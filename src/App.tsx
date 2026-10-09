import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type MapHandle, type MapRoute } from './map/MapView'
import { RouteSidebar } from './routes/RouteSidebar'
import { verifiedRoadSection } from './transit/routeSegments'
import { useVehicleTracking } from './transit/useVehicleTracking'
import type { LatLng } from './map/kakao'
import { getNearbyStops, getRouteDetail, getRouteShape, getRouteStops, getStopArrivals, searchRoutes, stopKey, transitKey,
  type Route, type RouteShape, type RouteStop, type Stop, type StopArrival, type StopArrivalsResult } from './transit/api'

type LocationState = 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'error'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
const appKey = import.meta.env.VITE_KAKAO_MAP_APP_KEY?.trim() ?? ''
const ROUTE_COLORS = ['#1769cf', '#d45222', '#21875b', '#8a54c7', '#bd8a14']
const MAX_ROUTES = ROUTE_COLORS.length

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
  const [activeRouteKey, setActiveRouteKey] = useState<string | null>(null)
  const [routeLimitMessage, setRouteLimitMessage] = useState('')
  const routeControllersRef = useRef(new Map<string, AbortController>())
  const selectedRouteKeysRef = useRef(new Set<string>())
  const routeColorsRef = useRef(new Map<string, string>())
  const routeVisibleRef = useRef(new Set<string>())
  const routeSearchCacheRef = useRef(new Map<string, { at: number; routes: Route[] }>())
  const routeShapesRef = useRef(new Map<string, RouteShape>())
  const sectionPathsRef = useRef(new Map<string, { shape: RouteShape | null; stops: RouteStop[]; paths: Map<string, LatLng[] | null> }>())
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
      } finally {
        if (controller === current) controller = null
        if (!cancelled && !current.signal.aborted && active()) schedule(60_000)
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

  const addRoute = useCallback((route: Route) => {
    if (route.id.provider !== 'gbis' || route.id.regionCode !== 'gyeonggi' || !/^\d{1,20}$/.test(route.id.value)) return
    const key = transitKey(route.id)
    setMode('routes')
    setMobileListOpen(true)
    if (selectedRouteKeysRef.current.has(key)) { setActiveRouteKey(key); return }
    if (selectedRouteKeysRef.current.size >= MAX_ROUTES) { setRouteLimitMessage(`동시에 최대 ${MAX_ROUTES}개 노선을 표시할 수 있습니다.`); return }
    setRouteLimitMessage('')
    selectedRouteKeysRef.current.add(key)
    const used = new Set(routeColorsRef.current.values())
    const color = ROUTE_COLORS.find((value) => !used.has(value)) ?? ROUTE_COLORS[0]
    routeColorsRef.current.set(key, color)
    routeVisibleRef.current.add(key)
    setSelectedRoutes((items) => [...items, { key, route, color, visible: true, shape: null, shapeState: 'loading', shapeError: '',
      stops: [], stopsState: 'loading', stopsError: '', detailError: '', expanded: false }])
    setActiveRouteKey(key)
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
      update({ shape: result.shape, shapeState: 'ready' })
      if (result.shape && !controller.signal.aborted && routeVisibleRef.current.has(key)) {
        routeShapesRef.current.set(key, result.shape)
        if (routeShapesRef.current.size === 1) mapRef.current?.fitRoute(result.shape)
      }
    }).catch((error: unknown) => { if (!controller.signal.aborted) update({ shapeState: 'error', shapeError: error instanceof Error ? error.message : '경로 조회 실패' }) })
    void getRouteStops(route.id, controller.signal).then((result) => update({ stops: result.stops, stopsState: 'ready' }))
      .catch((error: unknown) => { if (!controller.signal.aborted) update({ stopsState: 'error', stopsError: error instanceof Error ? error.message : '경유 정류장 조회 실패' }) })
  }, [])

  const removeRoute = useCallback((key: string) => {
    routeControllersRef.current.get(key)?.abort()
    routeControllersRef.current.delete(key)
    selectedRouteKeysRef.current.delete(key)
    routeColorsRef.current.delete(key)
    routeVisibleRef.current.delete(key)
    routeShapesRef.current.delete(key)
    sectionPathsRef.current.delete(key)
    setSelectedRoutes((items) => items.filter((item) => item.key !== key))
    setActiveRouteKey((previous) => previous === key ? null : previous)
    setActiveVehicleKey((previous) => previous?.startsWith(`${key}:`) ? null : previous)
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

  const toggleRouteStops = useCallback((key: string) => {
    setSelectedRoutes((items) => items.map((item) => item.key === key ? { ...item, expanded: !item.expanded } : item))
    setActiveRouteKey(key)
  }, [])

  const mapRoutes = useMemo<MapRoute[]>(() => selectedRoutes.map((item) => ({ key: item.key, color: item.color,
    strokeWeight: 5, visible: item.visible, shape: item.shape, stops: item.stops })), [selectedRoutes])

  const trackedRoutes = useMemo(() => selectedRoutes.map((item) => ({ key: item.key, id: item.route.id, visible: item.visible })), [selectedRoutes])
  const { snapshots: vehicleSnapshots, refresh: refreshVehicles, refreshNotice } = useVehicleTracking(trackedRoutes)
  const vehicleSections = useMemo(() => selectedRoutes.flatMap((item) => {
    const snapshot = vehicleSnapshots[item.key]
    const queryAge = snapshot?.data ? now - Date.parse(snapshot.data.queriedAt) : NaN
    if (!item.visible || snapshot?.status !== 'ready' || !snapshot.data ||
        !Number.isFinite(queryAge) || queryAge < -30_000 || queryAge > 120_000) return []
    let cachedPaths = sectionPathsRef.current.get(item.key)
    if (!cachedPaths || cachedPaths.shape !== item.shape || cachedPaths.stops !== item.stops) {
      cachedPaths = { shape: item.shape, stops: item.stops, paths: new Map() }
      sectionPathsRef.current.set(item.key, cachedPaths)
    }
    return snapshot.data.vehicles.flatMap((vehicle) => {
      if (!vehicle.sectionVerified) return []
      const sectionKey = `${vehicle.stationSequence}:${vehicle.currentStopId.value}:${vehicle.nextStopId?.value ?? ''}`
      if (!cachedPaths.paths.has(sectionKey)) {
        cachedPaths.paths.set(sectionKey, verifiedRoadSection(item.shape, item.stops, vehicle))
        if (cachedPaths.paths.size > 250) cachedPaths.paths.delete(cachedPaths.paths.keys().next().value!)
      }
      const path = cachedPaths.paths.get(sectionKey)
      return path ? [{ key: `${item.key}:${vehicle.vehicleId}`, routeKey: item.key, stationSequence: vehicle.stationSequence, color: item.color, path }] : []
    })
  }), [selectedRoutes, vehicleSnapshots, now])

  const focusVehicle = useCallback((key: string) => {
    setActiveVehicleKey(key)
    const section = vehicleSections.find((item) => item.key === key)
    if (section) { setActiveRouteKey(section.routeKey); mapRef.current?.focusSection(section.path); setMobileListOpen(false) }
  }, [vehicleSections])

  const fitVisibleRoutes = useCallback(() => {
    mapRef.current?.fitRoutes([...routeShapesRef.current].filter(([key]) => routeVisibleRef.current.has(key)).map(([, shape]) => shape))
  }, [])

  const mapStops = useMemo(() => {
    const count = level <= 3 ? 35 : level === 4 ? 28 : level === 5 ? 18 : level === 6 ? 10 : 0
    return stops.slice(0, count)
  }, [stops, level])

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
            selected={selectedRoutes} activeKey={activeRouteKey} limitMessage={routeLimitMessage} onChoose={addRoute} onToggle={toggleRoute}
            onRemove={removeRoute} onExpand={toggleRouteStops} onActivate={setActiveRouteKey} onStopSelect={selectStop}
            vehicleSnapshots={vehicleSnapshots} vehicleSections={vehicleSections} activeVehicleKey={activeVehicleKey} now={now}
            onVehicleSelect={focusVehicle} onVehicleRefresh={refreshVehicles} refreshNotice={refreshNotice} />}
        </aside>

        <section className="map-panel" aria-label="지도 화면">
          {appKey ? <MapView appKey={appKey} userPosition={position} stops={mapStops} selectedStop={selectedStop} level={level} routes={mapRoutes} activeRouteKey={activeRouteKey} vehicleSections={vehicleSections} activeVehicleKey={activeVehicleKey} onReady={handleMapReady} onError={handleMapError} onViewportChange={handleViewportChange} onStopSelect={selectStop} onRouteSelect={(key) => { setActiveRouteKey(key); setSidebarCollapsed(false) }} /> :
            <div className="map-placeholder"><span className="placeholder-symbol" aria-hidden="true">◇</span><h2>지도 키 설정이 필요합니다</h2><p><code>.env.local</code>에 <code>VITE_KAKAO_MAP_APP_KEY</code>를 입력하고 개발 서버를 다시 실행해 주세요.</p></div>}
          {mapError && <div className="map-alert" role="alert">{mapError}</div>}
          <div className="map-caption"><span className="caption-dot" />{position ? '현재 위치 사용 중' : `지도 중심 · ${center ? '주변 검색' : '고양시'}`}</div>
          {mode === 'routes' && selectedRoutes.some((route) => route.visible && route.shape) && <div className="map-legend" aria-label="노선 지도 범례"><span><i className="legend-route" />전체 노선</span><span><i className="legend-section" />확인된 운행 구간</span><small>GPS 위치 아님</small></div>}
          {level >= 7 && <div className="zoom-hint">확대하면 정류장 마커가 표시됩니다</div>}
          <button className="map-location-button" onClick={locate} disabled={locationState === 'loading'} title="내 위치로 이동" aria-label="내 위치로 이동">⌖</button>
          {selectedRoutes.some((route) => route.visible && route.shape) && <button className="map-fit-routes-button" onClick={fitVisibleRoutes} title="선택한 노선 전체 보기">노선 전체 보기</button>}
          {selectedStop && <div className="arrival-panel" role="region" aria-label="선택한 정류장 도착정보">
            <div className="arrival-heading"><div><span className="panel-eyebrow">STOP DETAILS</span><h2>{selectedStop.name}</h2><p>ID {selectedStop.id.value}{selectedStop.mobileNo ? ` · 정류장 번호 ${selectedStop.mobileNo}` : ''}</p></div><button onClick={() => setSelectedStop(null)} aria-label="도착정보 닫기">×</button></div>
            <div className="arrival-content">
              {arrivalsState === 'loading' && <p className="arrival-message">실시간 도착정보를 불러오는 중입니다…</p>}
              {arrivalsState === 'error' && <div className="arrival-error" role="alert"><strong>도착정보 조회 실패</strong><p>{arrivalsError}</p></div>}
              {arrivalsState === 'ready' && arrivals?.arrivals.length === 0 && <p className="arrival-message">현재 제공되는 도착정보가 없습니다. 운행 여부는 확인되지 않았습니다.</p>}
              {arrivalsState === 'ready' && arrivals && arrivals.arrivals.map((arrival, index) => <div className="arrival-row" key={`${arrival.routeId.provider}:${arrival.routeId.value}:${arrival.stopId.value}:${index}`}>
                <div className="arrival-route"><button className="route-number" title="이 노선을 지도에 추가" onClick={() => { addRoute({ id: arrival.routeId, name: arrival.routeName, startName: null, endName: null, typeName: null, regionName: null, startStopId: null, endStopId: null }); setSelectedStop(null) }}>{arrival.routeName}</button><span className="route-destination">{arrival.destination ? `${arrival.destination} 방면` : '방면 정보 없음'}</span></div>
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
