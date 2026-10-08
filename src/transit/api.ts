import type { LatLng } from '../map/kakao'

export type ProviderId = 'gbis' | 'precision' | 'tago'
export interface TransitId { provider: ProviderId; regionCode: string; value: string }
export interface Stop { id: TransitId; name: string; position: LatLng; mobileNo: string | null; distanceMeters: number | null }
export interface ArrivalVisit { minutesUntilArrival: number | null; stopsAway: number | null }
export interface StopArrival {
  routeId: TransitId
  stopId: TransitId
  routeName: string
  destination: string | null
  operationStatus: 'running' | 'ended' | 'waiting' | 'unknown'
  visits: ArrivalVisit[]
}
export interface NearbyStopsResult { stops: Stop[]; queriedAt: string; source: ProviderId }
export interface StopArrivalsResult { arrivals: StopArrival[]; queriedAt: string; source: ProviderId }

export function stopKey(stop: Stop): string {
  return `${stop.id.provider}:${stop.id.regionCode}:${stop.id.value}`
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('서버에 연결하지 못했습니다. Firebase 에뮬레이터가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : `서버 오류 (${response.status})`
    throw new Error(message)
  }
  return body
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validId(value: unknown): value is TransitId {
  const item = object(value)
  return !!item && (item.provider === 'gbis' || item.provider === 'precision' || item.provider === 'tago') && typeof item.regionCode === 'string' && typeof item.value === 'string'
}

function validProvider(value: unknown): value is ProviderId {
  return value === 'gbis' || value === 'precision' || value === 'tago'
}

function validStop(value: unknown): value is Stop {
  const item = object(value)
  const point = object(item?.position)
  return !!item && validId(item.id) && typeof item.name === 'string' && !!point && typeof point.latitude === 'number' && typeof point.longitude === 'number' &&
    (item.mobileNo === null || typeof item.mobileNo === 'string') && (item.distanceMeters === null || typeof item.distanceMeters === 'number')
}

function validArrival(value: unknown): value is StopArrival {
  const item = object(value)
  return !!item && validId(item.routeId) && validId(item.stopId) && typeof item.routeName === 'string' && Array.isArray(item.visits) &&
    item.visits.every((visit) => { const row = object(visit); return !!row && (row.minutesUntilArrival === null || typeof row.minutesUntilArrival === 'number') && (row.stopsAway === null || typeof row.stopsAway === 'number') })
}

export async function getNearbyStops(position: LatLng, signal: AbortSignal): Promise<NearbyStopsResult> {
  const params = new URLSearchParams({ lat: String(position.latitude), lng: String(position.longitude) })
  const body = object(await readJson(`/api/stops/nearby?${params}`, signal))
  if (!body || !Array.isArray(body.stops) || !body.stops.every(validStop) || typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('정류장 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as NearbyStopsResult
}

export async function getStopArrivals(stop: Stop, signal: AbortSignal): Promise<StopArrivalsResult> {
  const body = object(await readJson(`/api/stops/${encodeURIComponent(stop.id.value)}/arrivals`, signal))
  if (!body || !Array.isArray(body.arrivals) || !body.arrivals.every(validArrival) || typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('도착정보 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as StopArrivalsResult
}
