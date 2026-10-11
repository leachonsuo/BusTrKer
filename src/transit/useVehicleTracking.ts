import { useCallback, useEffect, useRef, useState } from 'react'
import { getVehiclePositions, type VehiclePositionsResult } from './api'
import { vehicleTransitions, type VehicleTransition } from './vehicleProgress'
import { VehiclePollingController, type PollingTrigger, type PollingUpdate, type TrackedRoute } from './vehiclePolling'

export type { TrackedRoute }
export interface VehicleSnapshot {
  status: 'loading' | 'ready' | 'error'
  data: VehiclePositionsResult | null
  message: string
  changes: Record<string, VehicleTransition>
}
export interface VehicleAction { kind: 'cleared' | 'loading' | 'ready' | 'error'; trigger: PollingTrigger | null;
  atMs: number; httpStatus: number | null }

function notice(result: ReturnType<VehiclePollingController['refresh']>, selected: number): string {
  if (result.unavailable) return navigator.onLine === false ? '네트워크 연결이 복구되면 차량을 다시 조회합니다.' : '탭을 다시 활성화하면 차량을 조회합니다.'
  if (selected === 0) return '표시 중인 노선이 없습니다.'
  if (result.started) return `${result.started}개 노선의 차량정보를 다시 조회합니다.`
  if (result.rateLimited) return '호출량 제한으로 재조회 대기 중입니다.'
  if (result.busy) return '차량정보를 이미 조회 중입니다.'
  return '방금 조회했습니다. 잠시 후 다시 시도해 주세요.'
}

export function useVehicleTracking(routes: TrackedRoute[]) {
  const [snapshots, setSnapshots] = useState<Record<string, VehicleSnapshot>>({})
  const [refreshNotice, setRefreshNotice] = useState('')
  const schedulerRef = useRef<VehiclePollingController | null>(null)
  const actionsRef = useRef<Record<string, VehicleAction[]>>({})
  const selectedCountRef = useRef(0)
  selectedCountRef.current = routes.filter((route) => route.visible).length

  if (!schedulerRef.current) {
    schedulerRef.current = new VehiclePollingController(getVehiclePositions, (key: string, event: PollingUpdate) => {
      const actions = actionsRef.current[key] ?? []
      actionsRef.current[key] = [...actions.slice(-2), { kind: event?.status ?? 'cleared', trigger: event?.trigger ?? null,
        atMs: Date.now(), httpStatus: event?.status === 'error' ? event.httpStatus : null }]
      setSnapshots((previous) => {
        if (event === null) {
          if (!(key in previous)) return previous
          const next = { ...previous }
          delete next[key]
          return next
        }
        const prior = previous[key]
        if (event.status === 'ready') return { ...previous, [key]: { status: 'ready', data: event.data, message: '',
          changes: vehicleTransitions(prior?.data?.vehicles ?? [], event.data.vehicles) } }
        // Keep the last successful snapshot visible while the next request is in flight.
        if (event.status === 'loading') return { ...previous, [key]: { status: prior?.data ? 'ready' : 'loading',
          data: prior?.data ?? null, message: '', changes: prior?.changes ?? {} } }
        return { ...previous, [key]: { status: 'error', data: null, message: event.message, changes: {} } }
      })
    })
  }

  const routeSignature = routes.filter((route) => route.visible).map((route) => route.key).join('|')
  useEffect(() => { schedulerRef.current?.setRoutes(routes) }, [routeSignature]) // visible IDs define the polling set

  useEffect(() => {
    const controller = schedulerRef.current!
    controller.setVisible(!document.hidden)
    controller.setOnline(navigator.onLine !== false)
    const onVisibility = () => controller.setVisible(!document.hidden)
    const onOnline = () => controller.setOnline(true)
    const onOffline = () => controller.setOnline(false)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); controller.setRoutes([]) }
  }, [])

  const refresh = useCallback(() => {
    const result = schedulerRef.current!.refresh()
    setRefreshNotice(notice(result, selectedCountRef.current))
  }, [])

  return { snapshots, actions: actionsRef.current, refresh, refreshNotice }
}
