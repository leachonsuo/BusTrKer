import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type MapHandle, type MapRoute } from './map/MapView'
import { RouteSidebar } from './routes/RouteSidebar'
import { separateSharedStraightVertices } from './transit/routeShape'
import { routePreview } from './transit/routePreview'
import { splitRouteDirections,
  vehicleBelongsToDirection, type DirectionSplit, type RouteDirection } from './transit/routeDirections'
import { verifiedRoadSection, type SectionRejectReason } from './transit/routeSegments'
import { isHexColor, loadRouteColors, persistRouteColors, ROUTE_COLOR_PRESETS, sectionColorForRoute } from './transit/routeColors'
import { useVehicleTracking, type VehicleSnapshot } from './transit/useVehicleTracking'
import type { LatLng } from './map/kakao'
import { getNearbyStops, getRouteDetail, getRouteShape, getRouteStops, getStopArrivals, searchRoutes, stopKey, transitKey, TransitRequestError, vehicleFetchTiming,
  type Route, type RouteShape, type RouteStop, type Stop, type StopArrival, type StopArrivalsResult } from './transit/api'

type LocationState = 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'error'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
const appKey = import.meta.env.VITE_KAKAO_MAP_APP_KEY?.trim() ?? ''
const MAX_ROUTES = 5
const EMPTY_DIRECTIONS: readonly RouteDirection[] = []

export interface SelectedRoute {
  key: string
  route: Route
  color: string
  visible: boolean
  shape: RouteShape | null
  shapeState: LoadState
  shapeError: string
  stops: RouteStop[]
  stopsState: LoadState
  stopsError: string
  detailError: string
  expanded: boolean
  directionKey: string | null
  choosingDirection: boolean
}

interface SectionDiagnostic {
  routeKey: string
  slot: number
  rendered: number
  status: string
  vehicles: number
  verified: number
  ageMs: number | null
  requestStartedAtMs: number | null
  responseCompletedAtMs: number | null
  httpStatus: number | null
  serverQueryAgeMs: number | null
}

function locationMessage(state: LocationState): string {
  switch (state) {
    case 'loading': return '현재 위치 확인 중'
    case 'ready': return '현재 위치를 기준으로 표시 중'
    case 'denied': return '위치 권한이 거부되어 고양시 또는 현재 지도 중심을 기준으로 표시합니다.'
    case 'unavailable': return '위치 정보를 사용할 수 없습니다. HTTPS 또는 localhost를 확인해 주세요.'
    case 'error': return '위치를 확인하지 못했습니다. 지도 중심을 기준으로 표시합니다.'
    default: return '위치를 허용하면 주변 정류장을 자동으로 찾습니다.'
  }
}

function timeLabel(value: string | null): string {
  if (!value) return '조회 시각 없음'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '조회 시각 없음' : `${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)} 조회`
}

function statusLabel(status: StopArrival['operationStatus']): string | null {
  if (status === 'ended') return '운행 종료'
  if (status === 'waiting') return '회차 대기'
  return null
}

export default function App() {
  const mapRef = useRef<MapHandle | null>(null)
  const locationRequestedRef = useRef(false)
  const [position, setPosition] = useState<LatLng | null>(null)
  const [positionAccuracy, setPositionAccuracy] = useState<number | null>(null)
  const [locationState, setLocationState] = useState<LocationState>('idle')
  const [mapError, setMapError] = useState('')
  const [center, setCenter] = useState<LatLng | null>(null)
  const [level, setLevel] = useState(6)
  const [stops, setStops] = useState<Stop[]>([])
  const [stopsState, setStopsState] = useState<LoadState>('idle')
  const [stopsError, setStopsError] = useState('')
  const [stopsQueriedAt, setStopsQueriedAt] = useState<string | null>(null)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<'stops' | 'routes'>('stops')
  const [routeQuery, setRouteQuery] = useState('')
  const [routeResults, setRouteResults] = useState<Route[]>([])
  const [routeSearchState, setRouteSearchState] = useState<LoadState>('idle')
  const [routeSearchError, setRouteSearchError] = useState('')
  const [selectedRoutes, setSelectedRoutes] = useState<SelectedRoute[]>([])
  const [activeVehicleKey, setActiveVehicleKey] = useState<string | null>(null)
  const [focusedSection, setFocusedSection] = useState<{ routeKey: string; stationSequence: number } | null>(null)
  const [activeRouteKey, setActiveRouteKey] = useState<string | null>(null)
  const [routeStopFocus, setRouteStopFocus] = useState<{ routeKey: string; stopId: string; sequence: number | null } | null>(null)
  const [routeLimitMessage, setRouteLimitMessage] = useState('')
  const routeControllersRef = useRef(new Map<string, AbortController>())
  const selectedRouteKeysRef = useRef(new Set<string>())
  const routeColorsRef = useRef(loadRouteColors())
  const routeVisibleRef = useRef(new Set<string>())
  const routeSearchCacheRef = useRef(new Map<string, { at: number; routes: Route[] }>())
  const directionCacheRef = useRef(new Map<string, { shape: RouteShape; stops: RouteStop[]; result: DirectionSplit }>())
  const sectionPathsRef = useRef(new Map<string, { shape: RouteShape | null; stops: RouteStop[]; paths: Map<string, LatLng[] | null> }>())
  const overviewFittedRef = useRef(new Set<string>())
  const previousSectionDiagnosticsRef = useRef<SectionDiagnostic[]>([])
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [mobileListExpanded, setMobileListExpanded] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const [arrivals, setArrivals] = useState<StopArrivalsResult | null>(null)
  const [arrivalsState, setArrivalsState] = useState<LoadState>('idle')
  const [arrivalsError, setArrivalsError] = useState('')

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    const updateClock = () => { if (!document.hidden) setNow(Date.now()) }
    document.addEventListener('visibilitychange', updateClock)
    window.addEventListener('online', updateClock)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', updateClock); window.removeEventListener('online', updateClock) }
  }, [])

  const locate = useCallback(() => {
    if (!navigator.geolocation || !window.isSecureContext) {
      setLocationState('unavailable')
      return
    }
    setLocationState('loading')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const next = { latitude: coords.latitude, longitude: coords.longitude }
        setPosition(next)
        setPositionAccuracy(Number.isFinite(coords.accuracy) ? coords.accuracy : null)
        setLocationState('ready')
        mapRef.current?.moveTo(next)
      },
      (error) => setLocationState(error.code === error.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    )
  }, [])

  const handleMapReady = useCallback((handle: MapHandle) => {
    mapRef.current = handle
    if (!locationRequestedRef.current) {
      locationRequestedRef.current = true
      locate()
    }
  }, [locate])
  const handleMapError = useCallback((message: string) => setMapError(message), [])
  const handleViewportChange = useCallback((nextCenter: LatLng, nextLevel: number) => {
    setLevel(nextLevel)
    setCenter((previous) => previous && previous.latitude.toFixed(3) === nextCenter.latitude.toFixed(3) && previous.longitude.toFixed(3) === nextCenter.longitude.toFixed(3) ? previous : nextCenter)
  }, [])
  const selectStop = useCallback((stop: Stop) => {
    setRouteStopFocus(null)
    setSelectedStop(stop)
    setMobileListOpen(false)
    mapRef.current?.focusStop(stop)
  }, [])

  const centerKey = center ? `${center.latitude.toFixed(3)}:${center.longitude.toFixed(3)}` : null
  useEffect(() => {
    if (!center || !centerKey || !appKey) return
    const controller = new AbortController()
    setStopsState('loading')
    setStopsError('')
    setStops([])
    getNearbyStops(center, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setStops(result.stops)
      setStopsQueriedAt(result.queriedAt)
      setStopsState('ready')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setStopsState('error')
      setStopsQueriedAt(null)
      setStopsError(error instanceof Error ? error.message : '정류장을 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [centerKey, refreshCounter, appKey]) // center changes only when its rounded search coordinate changes

  const selectedKey = selectedStop ? stopKey(selectedStop) : null
  useEffect(() => {
    if (!selectedStop || !selectedKey) return
    let cancelled = false
    let controller: AbortController | null = null
    let timer: number | undefined
    let nextDueAt = 0
    let automaticBlocked = false
    const active = () => !document.hidden && navigator.onLine !== false
    setArrivals(null)
    setArrivalsState('loading')
    setArrivalsError('')
    const schedule = (delay: number) => {
      nextDueAt = Date.now() + delay
      window.clearTimeout(timer)
      if (active()) timer = window.setTimeout(() => void load(), delay)
    }
    const load = async () => {
      if (!active() || controller) return
      const current = new AbortController()
      controller = current
      try {
        const result = await getStopArrivals(selectedStop, current.signal)
        if (cancelled || current.signal.aborted) return
        setArrivals(result)
        setArrivalsState('ready')
        setArrivalsError('')
      } catch (error) {
        if (cancelled || current.signal.aborted) return
        setArrivals(null)
        setArrivalsState('error')
        setArrivalsError(error instanceof Error ? error.message : '도착정보를 불러오지 못했습니다.')
        if (error instanceof TransitRequestError &&
            (error.code === 'INTERNAL_BUDGET_EXHAUSTED' || error.code === 'BUDGET_UNAVAILABLE' || error.code === 'UPSTREAM_AUTH_ERROR')) {
          automaticBlocked = true
        }
      } finally {
        if (controller === current) controller = null
        if (!cancelled && !current.signal.aborted && active() && !automaticBlocked) schedule(60_000)
      }
    }
    const onActivity = () => {
      window.clearTimeout(timer)
      if (!active()) {
        if (controller) { controller.abort(); controller = null; nextDueAt = 0 }
        if (navigator.onLine === false) {
          setArrivals(null)
          setArrivalsState('error')
          setArrivalsError('네트워크 연결이 끊겼습니다. 연결되면 다시 조회합니다.')
        }
        return
      }
      if (automaticBlocked) return
      if (controller) return
      if (Date.now() >= nextDueAt) void load()
      else schedule(nextDueAt - Date.now())
    }
    document.addEventListener('visibilitychange', onActivity)
    window.addEventListener('online', onActivity)
    window.addEventListener('offline', onActivity)
    onActivity()
    return () => { cancelled = true; controller?.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onActivity); window.removeEventListener('online', onActivity); window.removeEventListener('offline', onActivity) }
  }, [selectedKey])

  const filteredStops = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase()
    return keyword ? stops.filter((stop) => stop.name.toLocaleLowerCase().includes(keyword)) : stops
  }, [stops, search])

  useEffect(() => {
    if (mode !== 'routes') return
    const query = routeQuery.trim()
    if (!query) { setRouteResults([]); setRouteSearchState('idle'); setRouteSearchError(''); return }
    const previous = routeSearchCacheRef.current.get(query)
    if (previous && Date.now() - previous.at < 300_000) {
      setRouteResults(previous.routes)
      setRouteSearchState('ready')
      setRouteSearchError('')
      return
    }
    const controller = new AbortController()
    setRouteSearchState('loading')
    setRouteSearchError('')
    const timer = window.setTimeout(() => {
      searchRoutes(query, controller.signal).then((result) => {
        if (controller.signal.aborted) return
        const ordered = result.routes.sort((a, b) => {
          const score = (route: Route) => (route.name === query ? 0 : 2) +
            ((route.regionName?.includes('고양') || route.startName?.includes('고양')) ? 0 : 1)
          return score(a) - score(b) || a.name.localeCompare(b.name, 'ko')
        })
        routeSearchCacheRef.current.set(query, { at: Date.now(), routes: ordered })
        if (routeSearchCacheRef.current.size > 30) routeSearchCacheRef.current.delete(routeSearchCacheRef.current.keys().next().value!)
        setRouteResults(ordered)
        setRouteSearchState('ready')
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRouteResults([])
        setRouteSearchState('error')
        setRouteSearchError(error instanceof Error ? error.message : '노선을 검색하지 못했습니다.')
      })
    }, 360)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [routeQuery, mode])

  useEffect(() => () => {
    for (const controller of routeControllersRef.current.values()) controller.abort()
    routeControllersRef.current.clear()
  }, [])

  const addRoute = useCallback((route: Route, focusStopId?: string) => {
    if (route.id.provider !== 'gbis' || route.id.regionCode !== 'gyeonggi' || !/^\d{1,20}$/.test(route.id.value)) return false
    const key = transitKey(route.id)
    setMode('routes')
    setMobileListOpen(true)
    setMobileListExpanded(true)
    if (selectedRouteKeysRef.current.has(key)) {
      routeVisibleRef.current.add(key)
      setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, visible: true, expanded: true } : item))
      setActiveRouteKey(key)
      setRouteStopFocus(focusStopId ? { routeKey: key, stopId: focusStopId, sequence: null } : null)
      return true
    }
    if (selectedRouteKeysRef.current.size >= MAX_ROUTES) { setRouteLimitMessage(`동시에 최대 ${MAX_ROUTES}개 노선을 표시할 수 있습니다. 기존 노선을 삭제한 뒤 다시 선택해 주세요.`); return false }
    setRouteLimitMessage('')
    selectedRouteKeysRef.current.add(key)
    const used = new Set([...routeColorsRef.current].filter(([routeKey]) => selectedRouteKeysRef.current.has(routeKey)).map(([, value]) => value))
    const color = routeColorsRef.current.get(key) ?? ROUTE_COLOR_PRESETS.find((value) => !used.has(value)) ?? ROUTE_COLOR_PRESETS[0]
    routeColorsRef.current.set(key, color)
    persistRouteColors(routeColorsRef.current)
    routeVisibleRef.current.add(key)
    setSelectedRoutes((items) => [...items, { key, route, color, visible: true, shape: null, shapeState: 'loading', shapeError: '',
      stops: [], stopsState: 'loading', stopsError: '', detailError: '', expanded: true,
      directionKey: null, choosingDirection: true }])
    setActiveRouteKey(key)
    setRouteStopFocus(focusStopId ? { routeKey: key, stopId: focusStopId, sequence: null } : null)
    const controller = new AbortController()
    routeControllersRef.current.set(key, controller)
    const update = (patch: Partial<SelectedRoute>) => {
      if (!controller.signal.aborted) setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, ...patch } : item))
    }
    void getRouteDetail(route.id, controller.signal).then((result) => {
      if (result.route) update({ route: result.route })
      else update({ detailError: '노선 상세정보가 제공되지 않습니다.' })
    }).catch((error: unknown) => { if (!controller.signal.aborted) update({ detailError: error instanceof Error ? error.message : '상세정보 조회 실패' }) })
    void getRouteShape(route.id, controller.signal).then((result) => {
      const shape = result.shape ? separateSharedStraightVertices(result.shape).shape : null
      update({ shape, shapeState: 'ready' })
    }).catch((error: unknown) => { if (!controller.signal.aborted) update({ shapeState: 'error', shapeError: error instanceof Error ? error.message : '경로 조회 실패' }) })
    void getRouteStops(route.id, controller.signal).then((result) => update({ stops: result.stops, stopsState: 'ready' }))
      .catch((error: unknown) => { if (!controller.signal.aborted) update({ stopsState: 'error', stopsError: error instanceof Error ? error.message : '경유 정류장 조회 실패' }) })
    return true
  }, [])

  const removeRoute = useCallback((key: string) => {
    routeControllersRef.current.get(key)?.abort()
    routeControllersRef.current.delete(key)
    selectedRouteKeysRef.current.delete(key)
    routeVisibleRef.current.delete(key)
    directionCacheRef.current.delete(key)
    sectionPathsRef.current.delete(key)
    overviewFittedRef.current.delete(key)
    setSelectedRoutes((items) => items.filter((item) => item.key !== key))
    setActiveRouteKey((previous) => previous === key ? null : previous)
    setRouteStopFocus((previous) => previous?.routeKey === key ? null : previous)
    setActiveVehicleKey((previous) => previous?.startsWith(`${key}:`) ? null : previous)
    setFocusedSection((previous) => previous?.routeKey === key ? null : previous)
    setRouteLimitMessage('')
  }, [])

  const toggleRoute = useCallback((key: string) => {
    if (!selectedRouteKeysRef.current.has(key)) return
    const visible = !routeVisibleRef.current.has(key)
    if (visible) routeVisibleRef.current.add(key)
    else routeVisibleRef.current.delete(key)
    setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, visible } : item))
    if (!visible) setActiveVehicleKey((previous) => previous?.startsWith(`${key}:`) ? null : previous)
  }, [])

  const changeRouteColor = useCallback((key: string, color: string) => {
    if (!selectedRouteKeysRef.current.has(key) || !isHexColor(color)) return
    routeColorsRef.current.set(key, color)
    persistRouteColors(routeColorsRef.current)
    setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, color } : item))
  }, [])

  const toggleRouteStops = useCallback((key: string) => {
    setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, expanded: !item.expanded } : item))
    setActiveRouteKey(key)
  }, [])

  const directionSplits = useMemo(() => {
    const results = new Map<string, DirectionSplit>()
    for (const item of selectedRoutes) {
      if (!item.shape || item.stopsState !== 'ready') continue
      const cached = directionCacheRef.current.get(item.key)
      if (cached && cached.shape === item.shape && cached.stops === item.stops) results.set(item.key, cached.result)
      else {
        const result = splitRouteDirections(item.route, item.shape, item.stops)
        directionCacheRef.current.set(item.key, { shape: item.shape, stops: item.stops, result })
        results.set(item.key, result)
      }
    }
    return results
  }, [selectedRoutes])
  const directionFor = (item: SelectedRoute): RouteDirection | null =>
    directionSplits.get(item.key)?.directions?.find((direction) => direction.key === item.directionKey) ?? null
  const previewFor = (item: SelectedRoute) => routePreview(item.shape, directionSplits.get(item.key), item.stopsState === 'error')
  const selectDirection = useCallback((routeKey: string, directionKey: string) => {
    const direction = directionSplits.get(routeKey)?.directions?.find((item) => item.key === directionKey)
    if (!direction) return
    setSelectedRoutes((items) => items.map((item) => item.key === routeKey ? { ...item, directionKey, choosingDirection: false, expanded: true } : item))
    setActiveRouteKey(routeKey)
    setRouteStopFocus(null)
    setActiveVehicleKey(null)
    setFocusedSection(null)
    mapRef.current?.fitRoute(direction.shape)
  }, [directionSplits])
  const reselectDirection = useCallback((routeKey: string) => {
    setSelectedRoutes((items) => items.map((item) => item.key === routeKey ? { ...item, choosingDirection: true } : item))
    setActiveRouteKey(routeKey)
    setRouteStopFocus(null)
    setActiveVehicleKey(null)
    setFocusedSection(null)
    const route = selectedRoutes.find((item) => item.key === routeKey)
    if (route) {
      const preview = routePreview(route.shape, directionSplits.get(route.key), route.stopsState === 'error')
      if (preview) mapRef.current?.fitRoute(preview.shape)
    }
  }, [selectedRoutes, directionSplits])
  useEffect(() => {
    const item = selectedRoutes.find((route) => route.key === activeRouteKey)
    if (!item?.choosingDirection) return
    const preview = previewFor(item)
    if (!preview) return
    if (overviewFittedRef.current.has(item.key)) return
    overviewFittedRef.current.add(item.key)
    mapRef.current?.fitRoute(preview.shape)
  }, [selectedRoutes, activeRouteKey, directionSplits])

  useEffect(() => {
    if (!routeStopFocus || routeStopFocus.sequence !== null) return
    const route = selectedRoutes.find((item) => item.key === routeStopFocus.routeKey)
    if (route?.stopsState !== 'ready') return
    const matches = route.stops.filter((stop) => transitKey(stop.id) === routeStopFocus.stopId)
    if (matches.length === 1) setRouteStopFocus({ ...routeStopFocus, sequence: matches[0].sequence })
  }, [routeStopFocus, selectedRoutes])

  const activateRoute = useCallback((key: string) => {
    setActiveRouteKey(key)
    setRouteStopFocus((previous) => previous?.routeKey === key ? previous : null)
    setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, expanded: true } : item))
  }, [])

  const focusRouteStop = useCallback((routeKey: string, stop: RouteStop) => {
    setActiveRouteKey(routeKey)
    setRouteStopFocus({ routeKey, stopId: transitKey(stop.id), sequence: stop.sequence })
    mapRef.current?.focusStop(stop)
  }, [])

  const mapRoutes = useMemo<MapRoute[]>(() => selectedRoutes.map((item) => {
    const direction = directionSplits.get(item.key)?.directions?.find((entry) => entry.key === item.directionKey)
    const selected = !!direction && !item.choosingDirection
    const preview = previewFor(item)
    return { key: item.key, color: item.color, strokeWeight: 5, visible: item.visible,
      shape: selected ? direction.shape : preview?.shape ?? null,
      stops: selected ? direction.stops : directionSplits.get(item.key)?.directions === null ? item.stops : [],
      preview: !selected, previewColor: preview?.source === 'fallback-full-route' ? item.color : undefined }
  }), [selectedRoutes, directionSplits])

  const trackedRoutes = useMemo(() => selectedRoutes.map((item) => ({ key: item.key, id: item.route.id,
    visible: item.visible && !!directionSplits.get(item.key)?.directions?.some((direction) => direction.key === item.directionKey) })), [selectedRoutes, directionSplits])
  const { snapshots: vehicleSnapshots, actions: vehicleActions, refresh: refreshVehicles, refreshNotice } = useVehicleTracking(trackedRoutes)
  const vehicleSections = useMemo(() => selectedRoutes.flatMap((item) => {
    const direction = directionFor(item)
    if (!direction || item.choosingDirection) return []
    const snapshot = vehicleSnapshots[item.key]
    const queryAge = snapshot?.data ? now - Date.parse(snapshot.data.queriedAt) : NaN
    if (!item.visible || snapshot?.status !== 'ready' || !snapshot.data ||
        !Number.isFinite(queryAge) || queryAge < -30_000 || queryAge > 120_000) return []
    let cachedPaths = sectionPathsRef.current.get(item.key)
    if (!cachedPaths || cachedPaths.shape !== direction.shape || cachedPaths.stops !== direction.stops) {
      cachedPaths = { shape: direction.shape, stops: direction.stops, paths: new Map() }
      sectionPathsRef.current.set(item.key, cachedPaths)
    }
    return snapshot.data.vehicles.flatMap((vehicle) => {
      if (!vehicleBelongsToDirection(vehicle, direction)) return []
      const sectionKey = `${vehicle.stationSequence}:${vehicle.currentStopId.value}:${vehicle.nextStopId?.value ?? ''}`
      if (!cachedPaths.paths.has(sectionKey)) {
        const fullPath = verifiedRoadSection(item.shape, item.stops, vehicle)
        cachedPaths.paths.set(sectionKey, fullPath ? verifiedRoadSection(direction.shape, direction.stops, vehicle) : null)
        if (cachedPaths.paths.size > 250) cachedPaths.paths.delete(cachedPaths.paths.keys().next().value!)
      }
      const path = cachedPaths.paths.get(sectionKey)
      return path ? [{ key: `${item.key}:${vehicle.vehicleId}`, routeKey: item.key, stationSequence: vehicle.stationSequence, color: sectionColorForRoute(item.color), path }] : []
    })
  }), [selectedRoutes, vehicleSnapshots, now, directionSplits])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const current: SectionDiagnostic[] = selectedRoutes.map((route, slot) => {
      const snapshot: VehicleSnapshot | undefined = vehicleSnapshots[route.key]
      const age = snapshot?.data ? now - Date.parse(snapshot.data.queriedAt) : NaN
      const timing = snapshot?.data ? vehicleFetchTiming(snapshot.data) : null
      const serverAge = timing?.serverDateMs !== null && timing?.serverDateMs !== undefined && snapshot?.data
        ? timing.serverDateMs - Date.parse(snapshot.data.queriedAt) : NaN
      return { routeKey: route.key, slot: slot + 1,
        rendered: vehicleSections.filter((section) => section.routeKey === route.key).length,
        status: snapshot?.status ?? 'missing', vehicles: snapshot?.data?.vehicles.length ?? 0,
        verified: snapshot?.data?.vehicles.filter((vehicle) => vehicle.sectionVerified).length ?? 0,
        ageMs: Number.isFinite(age) ? Math.round(age) : null,
        requestStartedAtMs: timing?.startedAtMs ?? null, responseCompletedAtMs: timing?.completedAtMs ?? null,
        httpStatus: timing?.httpStatus ?? null, serverQueryAgeMs: Number.isFinite(serverAge) ? Math.round(serverAge) : null }
    })
    for (const before of previousSectionDiagnosticsRef.current) {
      const after = current.find((item) => item.routeKey === before.routeKey)
      if (before.rendered === 0 || (after?.rendered ?? 0) !== 0) continue
      const route = selectedRoutes.find((item) => item.key === before.routeKey)
      const snapshot = vehicleSnapshots[before.routeKey]
      const rejectionCounts: Partial<Record<SectionRejectReason, number>> = {}
      let geometryMatched = 0
      if (route && snapshot?.data) for (const vehicle of snapshot.data.vehicles) {
        if (!vehicle.sectionVerified) continue
        const path = verifiedRoadSection(route.shape, route.stops, vehicle, (code) => {
          rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1
        })
        if (path) geometryMatched++
      }
      const reason = !route ? 'route_removed' : !route.visible ? 'route_hidden' : route.choosingDirection ? 'direction_chooser' :
        !after || after.status === 'missing' ? 'snapshot_removed' : after.status === 'error' ? 'request_error' :
          after.status === 'loading' ? 'request_loading' : after.ageMs === null ? 'invalid_query_time' :
            after.ageMs < -30_000 ? 'future_query_time' : after.ageMs > 120_000 ? 'expired_query_time' :
              !route.shape ? 'route_shape_missing' : route.stops.length === 0 ? 'route_stops_missing' :
                after.verified === 0 ? 'no_verified_sections' : geometryMatched > 0 ? 'section_cache_or_memo_mismatch' :
                  'verified_geometry_rejected'
      const summary = (item: SectionDiagnostic) => ({ rendered: item.rendered, status: item.status,
        vehicles: item.vehicles, verified: item.verified, ageMs: item.ageMs,
        requestStartedAt: item.requestStartedAtMs === null ? null : new Date(item.requestStartedAtMs).toISOString(),
        responseCompletedAt: item.responseCompletedAtMs === null ? null : new Date(item.responseCompletedAtMs).toISOString(),
        httpStatus: item.httpStatus, serverQueryAgeMs: item.serverQueryAgeMs })
      // Aggregate diagnostics only: no key, vehicle ID, plate, coordinates, URL, or payload.
      console.info('BUS_TRACKER_SECTION_DROP', { routeSlot: before.slot, reason,
        before: summary(before), after: after ? summary(after) : null,
        geometryMatched, rejectionCounts,
        routeReady: route ? { visible: route.visible, shapeState: route.shapeState, shapePoints: route.shape?.points.length ?? 0,
          stopsState: route.stopsState, stops: route.stops.length } : null,
        mapPropCount: after?.rendered ?? 0, sidebarPropCount: after?.rendered ?? 0,
        recentActions: (vehicleActions[before.routeKey] ?? []).map((action) => ({ kind: action.kind, trigger: action.trigger,
          at: new Date(action.atMs).toISOString(), httpStatus: action.httpStatus })) })
    }
    previousSectionDiagnosticsRef.current = current
  }, [selectedRoutes, vehicleSnapshots, vehicleSections, now, vehicleActions])

  const focusVehicle = useCallback((key: string) => {
    setActiveVehicleKey(key)
    const section = vehicleSections.find((item) => item.key === key)
    if (section) { setFocusedSection({ routeKey: section.routeKey, stationSequence: section.stationSequence }); setActiveRouteKey(section.routeKey); mapRef.current?.focusSection(section.path) }
  }, [vehicleSections])

  const focusMapSection = useCallback((routeKey: string, stationSequence: number) => {
    const sections = vehicleSections.filter((section) => section.routeKey === routeKey && section.stationSequence === stationSequence)
    if (!sections.length) return
    setFocusedSection({ routeKey, stationSequence })
    setActiveRouteKey(routeKey)
    if (sections.length === 1) setActiveVehicleKey(sections[0].key)
    else setActiveVehicleKey(null)
    setSelectedRoutes((items) => items.map((item) => item.key === routeKey ? { ...item, expanded: true } : item))
    setMobileListOpen(true)
  }, [vehicleSections])

  const fitVisibleRoutes = useCallback(() => {
    mapRef.current?.fitRoutes(mapRoutes.filter((route) => route.visible && route.shape).map((route) => route.shape!))
  }, [mapRoutes])

  const mapStops = useMemo(() => {
    const count = level <= 3 ? 35 : level === 4 ? 28 : level === 5 ? 18 : level === 6 ? 10 : 0
    return stops.slice(0, count)
  }, [stops, level])

  const chooserRoute = selectedRoutes.find((route) => route.key === activeRouteKey && route.visible && route.choosingDirection)
  const chooserSplit = chooserRoute ? directionSplits.get(chooserRoute.key) : null
  const chooserPreview = chooserRoute ? previewFor(chooserRoute) : null
  const chooserOptions = chooserSplit?.directions ?? EMPTY_DIRECTIONS
  const chooseActiveDirection = useCallback((directionKey: string) => {
    if (activeRouteKey) selectDirection(activeRouteKey, directionKey)
  }, [activeRouteKey, selectDirection])

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="topbar">
        <div className="brand" aria-label="BusTracker"><span className="brand-mark" aria-hidden="true">B</span><span>BusTracker<span className="brand-dot">.</span></span></div>
        <div className="search-mode-switch" role="group" aria-label="검색 종류"><button className={mode === 'stops' ? 'active' : ''} onClick={() => setMode('stops')}>정류장</button><button className={mode === 'routes' ? 'active' : ''} onClick={() => setMode('routes')}>버스 노선</button></div>
        <div className="top-search"><span aria-hidden="true">⌕</span><input aria-label={mode === 'stops' ? '정류장 이름으로 필터링' : '버스번호 검색'} placeholder={mode === 'stops' ? '주변 정류장 검색' : '버스번호 검색 · 예: 11'} value={mode === 'stops' ? search : routeQuery} onChange={(event) => { if (mode === 'stops') setSearch(event.target.value); else setRouteQuery(event.target.value); setMobileListOpen(true) }} /></div>
        <span className="top-region">고양시에서 시작하는 버스 지도</span>
        <button className="desktop-sidebar-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-expanded={!sidebarCollapsed} aria-controls="mobile-stop-list">{sidebarCollapsed ? '목록 열기' : '목록 접기'}</button>
      </header>

      <main className="workspace">
        <aside id="mobile-stop-list" className={`sidebar ${mobileListOpen ? 'mobile-open' : ''}${mobileListExpanded ? ' mobile-expanded' : ''}`} aria-label={mode === 'stops' ? '주변 정류장 목록' : '버스 노선 목록'}>
          <button className="mobile-panel-size" onClick={() => setMobileListExpanded((expanded) => !expanded)} aria-label={mobileListExpanded ? '목록 패널 축소' : '목록 패널 확장'}>{mobileListExpanded ? '패널 축소 ⌄' : '패널 확장 ⌃'}</button>
          {mode === 'stops' ? <>
          <div className="sidebar-heading">
            <div><p className="eyebrow">NEARBY STOPS</p><h1>주변 정류장</h1></div>
            <button className="refresh-button" title="정류장 다시 조회" onClick={() => setRefreshCounter((value) => value + 1)} aria-label="정류장 다시 조회">↻</button>
          </div>
          <p className="sidebar-subtitle">{center ? '현재 지도 중심 반경 약 500m' : '지도를 준비하고 있습니다.'} · {timeLabel(stopsQueriedAt)}</p>
          <div className="sidebar-status" role="status">{locationMessage(locationState)}</div>
          {stopsState === 'loading' && <p className="list-message">정류장을 불러오는 중입니다…</p>}
          {stopsState === 'error' && <div className="list-error" role="alert"><strong>정류장 조회 실패</strong><p>{stopsError}</p><button onClick={() => setRefreshCounter((value) => value + 1)}>다시 시도</button></div>}
          {stopsState === 'ready' && filteredStops.length === 0 && <p className="list-message">{search ? '검색 결과가 없습니다.' : '이 위치에서 조회된 정류장이 없습니다.'}</p>}
          {stopsState === 'ready' && filteredStops.length > 0 && <div className="stop-list">
            {filteredStops.map((stop) => <button key={stopKey(stop)} className={`stop-row ${selectedKey === stopKey(stop) ? 'selected' : ''}`} onClick={() => selectStop(stop)}>
              <span className="stop-row-icon" aria-hidden="true">▣</span>
              <span className="stop-row-main"><strong>{stop.name}</strong><small>정류장 ID {stop.id.value}{stop.mobileNo ? ` · 번호 ${stop.mobileNo}` : ''}</small></span>
              <span className="stop-row-distance">{stop.distanceMeters !== null ? `${stop.distanceMeters}m` : '›'}</span>
            </button>)}
          </div>}
          <div className="sidebar-footer"><span className="footer-rule" />표시된 정보는 GBIS 조회 결과입니다.<br />도착 예정은 실제 운행 상황에 따라 달라질 수 있습니다.</div>
          </> : <RouteSidebar query={routeQuery} searchState={routeSearchState} searchError={routeSearchError} results={routeResults}
            selected={selectedRoutes} activeKey={activeRouteKey} focusedStop={routeStopFocus} limitMessage={routeLimitMessage} onChoose={addRoute} onToggle={toggleRoute}
            onRemove={removeRoute} onExpand={toggleRouteStops} onActivate={activateRoute} onStopSelect={focusRouteStop} onColorChange={changeRouteColor}
            vehicleSnapshots={vehicleSnapshots} vehicleSections={vehicleSections} activeVehicleKey={activeVehicleKey} focusedSection={focusedSection} now={now}
            onVehicleSelect={focusVehicle} onVehicleRefresh={refreshVehicles} refreshNotice={refreshNotice}
            directionSplits={directionSplits} onReselectDirection={reselectDirection} />}
        </aside>

        <section className="map-panel" aria-label="지도 화면">
          {appKey ? <MapView appKey={appKey} userPosition={position} userPositionAccuracy={positionAccuracy} stops={mapStops} selectedStop={selectedStop} focusedRouteStop={routeStopFocus} level={level} routes={mapRoutes} activeRouteKey={activeRouteKey} vehicleSections={vehicleSections} activeVehicleKey={activeVehicleKey} focusedSection={focusedSection} directionOptions={chooserOptions} onDirectionSelect={chooseActiveDirection} onReady={handleMapReady} onError={handleMapError} onViewportChange={handleViewportChange} onStopSelect={selectStop} onRouteStopSelect={focusRouteStop} onRouteSelect={(key) => { activateRoute(key); setSidebarCollapsed(false); setMobileListOpen(true) }} onSectionSelect={focusMapSection} /> :
            <div className="map-placeholder"><span className="placeholder-symbol" aria-hidden="true">◇</span><h2>지도 키 설정이 필요합니다</h2><p><code>.env.local</code>에 <code>VITE_KAKAO_MAP_APP_KEY</code>를 입력하고 개발 서버를 다시 실행해 주세요.</p></div>}
          {mapError && <div className="map-alert" role="alert">{mapError}</div>}
          {chooserRoute && <div className="direction-chooser" role="region" aria-label={`${chooserRoute.route.name} ${chooserSplit?.directions === null ? '전체 노선 개요' : '운행 방향 선택'}`}>
            <span className="panel-eyebrow">ROUTE DIRECTION</span>
            <h2>{chooserRoute.route.name}번 · {chooserSplit?.directions === null ? '전체 노선 개요' : '운행 방향 선택'}</h2>
            {!chooserSplit && <p>노선형상과 경유 정류장을 확인하는 중입니다…</p>}
            {chooserSplit && !chooserSplit.directions && <><p>{chooserSplit.reason}</p><p>방향을 추측하지 않고 전체 노선 개요만 표시합니다.</p></>}
            {chooserSplit?.directions && <>
              <p>노선 미리보기입니다. 이용할 방향을 선택하세요.</p>
              {chooserPreview?.source === 'first-direction' && <small>{chooserPreview.directionLabel} 경로를 미리 표시합니다. 다른 방향은 선택 후 표시됩니다.</small>}
              <div className="direction-choices">{chooserOptions.map((direction) => <button key={direction.key}
                className="direction-choice" onClick={() => selectDirection(chooserRoute.key, direction.key)}>
                 <strong>{direction.label}</strong><span>{direction.startStop.name} → {direction.endStop.name}</span>
              </button>)}</div>
              <small>지도 안내는 실제 진행 방향을 확인할 수 있는 구간에만 표시됩니다.</small>
            </>}
          </div>}
          <div className="map-caption"><span className="caption-dot" />{position ? '현재 위치 사용 중' : `지도 중심 · ${center ? '주변 검색' : '고양시'}`}</div>
          {mode === 'routes' && (() => {
            const route = mapRoutes.find((item) => item.key === activeRouteKey && item.visible && item.shape && !item.preview) ??
              mapRoutes.find((item) => item.visible && item.shape && !item.preview)
            if (!route) return null
            return <div className="map-legend" aria-label="노선 지도 범례"><span><i className="legend-route" style={{ borderTopColor: route.color }} />{selectedRoutes.find((item) => item.key === route.key)?.route.name} 기본 노선</span><span><i className="legend-section" style={{ borderTopColor: sectionColorForRoute(route.color) }} />확인된 운행 구간</span><small>GPS 위치 아님</small></div>
          })()}
          {level >= 7 && <div className="zoom-hint">확대하면 정류장 마커가 표시됩니다</div>}
          <button className="map-location-button" onClick={locate} disabled={locationState === 'loading'} title="내 위치로 이동" aria-label="내 위치로 이동">⌖</button>
          {mapRoutes.some((route) => route.visible && route.shape) && <button className="map-fit-routes-button" onClick={fitVisibleRoutes} title="표시 중인 노선 보기">노선 전체 보기</button>}
          {selectedStop && <div className="arrival-panel" role="region" aria-label="선택한 정류장 도착정보">
            <div className="arrival-heading"><div><span className="panel-eyebrow">STOP DETAILS</span><h2>{selectedStop.name}</h2><p>ID {selectedStop.id.value}{selectedStop.mobileNo ? ` · 정류장 번호 ${selectedStop.mobileNo}` : ''}</p></div><button onClick={() => setSelectedStop(null)} aria-label="도착정보 닫기">×</button></div>
            <div className="arrival-content">
              {arrivalsState === 'loading' && <p className="arrival-message">실시간 도착정보를 불러오는 중입니다…</p>}
              {arrivalsState === 'error' && <div className="arrival-error" role="alert"><strong>도착정보 조회 실패</strong><p>{arrivalsError}</p></div>}
              {arrivalsState === 'ready' && arrivals?.arrivals.length === 0 && <p className="arrival-message">현재 제공되는 도착정보가 없습니다. 운행 여부는 확인되지 않았습니다.</p>}
              {arrivalsState === 'ready' && arrivals && arrivals.arrivals.map((arrival, index) => <div className="arrival-row" key={`${arrival.routeId.provider}:${arrival.routeId.value}:${arrival.stopId.value}:${index}`}>
                <div className="arrival-route"><button className="route-number" title="노선과 경유 정류장 목록 열기" onClick={() => { if (addRoute({ id: arrival.routeId, name: arrival.routeName, startName: null, endName: null, typeName: null, regionName: null, startStopId: null, endStopId: null }, transitKey(arrival.stopId))) setSelectedStop(null) }}>{arrival.routeName}</button><span className="route-destination">{arrival.destination ? `${arrival.destination} 방면` : '방면 정보 없음'}</span></div>
                {statusLabel(arrival.operationStatus) ? <span className="arrival-state">{statusLabel(arrival.operationStatus)}</span> : arrival.visits.length ?
                  <div className="visit-list">{arrival.visits.map((visit, index) => <div className="visit" key={index}><strong>{visit.minutesUntilArrival === null ? '도착시간 미제공' : visit.minutesUntilArrival === 0 ? '곧 도착' : `약 ${visit.minutesUntilArrival}분 후`}</strong><span>{visit.stopsAway === null ? '위치 미제공' : `${visit.stopsAway}정거장 전`}</span></div>)}</div> :
                  <span className="arrival-state">도착 예정 정보 없음</span>}
              </div>)}
            </div>
            <div className="arrival-footer">{timeLabel(arrivals?.queriedAt ?? null)} · GBIS <span>1분마다 다시 조회</span></div>
          </div>}
          <button className="mobile-list-toggle" onClick={() => setMobileListOpen((open) => !open)} aria-expanded={mobileListOpen} aria-controls="mobile-stop-list">{mode === 'stops' ? '정류장 목록' : '버스 노선'} <span>{mode === 'stops' ? stopsState === 'ready' ? `${stops.length}곳` : '' : `${selectedRoutes.length}개 선택`} {mobileListOpen ? '⌄' : '⌃'}</span></button>
        </section>
      </main>
    </div>
  )
}
