import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapView, type MapHandle } from './map/MapView'
import type { LatLng } from './map/kakao'
import { getNearbyStops, getStopArrivals, stopKey, type Stop, type StopArrival, type StopArrivalsResult } from './transit/api'

type LocationState = 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'error'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
const appKey = import.meta.env.VITE_KAKAO_MAP_APP_KEY?.trim() ?? ''

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
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null)
  const [arrivals, setArrivals] = useState<StopArrivalsResult | null>(null)
  const [arrivalsState, setArrivalsState] = useState<LoadState>('idle')
  const [arrivalsError, setArrivalsError] = useState('')

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
    setArrivals(null)
    setArrivalsState('loading')
    setArrivalsError('')
    const schedule = () => { timer = window.setTimeout(() => { if (document.hidden) schedule(); else void load() }, 60_000) }
    const load = async () => {
      controller = new AbortController()
      try {
        const result = await getStopArrivals(selectedStop, controller.signal)
        if (cancelled) return
        setArrivals(result)
        setArrivalsState('ready')
        setArrivalsError('')
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setArrivals(null)
        setArrivalsState('error')
        setArrivalsError(error instanceof Error ? error.message : '도착정보를 불러오지 못했습니다.')
      }
      if (!cancelled) schedule()
    }
    void load()
    return () => { cancelled = true; controller?.abort(); window.clearTimeout(timer) }
  }, [selectedKey])

  const filteredStops = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase()
    return keyword ? stops.filter((stop) => stop.name.toLocaleLowerCase().includes(keyword)) : stops
  }, [stops, search])

  const mapStops = useMemo(() => {
    const count = level <= 3 ? 35 : level === 4 ? 28 : level === 5 ? 18 : level === 6 ? 10 : 0
    return stops.slice(0, count)
  }, [stops, level])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="BusTracker"><span className="brand-mark" aria-hidden="true">B</span><span>BusTracker<span className="brand-dot">.</span></span></div>
        <div className="top-search"><span aria-hidden="true">⌕</span><input aria-label="정류장 이름으로 필터링" placeholder="주변 정류장 검색" value={search} onChange={(event) => { setSearch(event.target.value); setMobileListOpen(true) }} /></div>
        <span className="top-region">고양시에서 시작하는 버스 지도</span>
      </header>

      <main className="workspace">
        <aside id="mobile-stop-list" className={`sidebar ${mobileListOpen ? 'mobile-open' : ''}`} aria-label="주변 정류장 목록">
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
        </aside>

        <section className="map-panel" aria-label="지도 화면">
          {appKey ? <MapView appKey={appKey} userPosition={position} stops={mapStops} selectedStop={selectedStop} level={level} onReady={handleMapReady} onError={handleMapError} onViewportChange={handleViewportChange} onStopSelect={selectStop} /> :
            <div className="map-placeholder"><span className="placeholder-symbol" aria-hidden="true">◇</span><h2>지도 키 설정이 필요합니다</h2><p><code>.env.local</code>에 <code>VITE_KAKAO_MAP_APP_KEY</code>를 입력하고 개발 서버를 다시 실행해 주세요.</p></div>}
          {mapError && <div className="map-alert" role="alert">{mapError}</div>}
          <div className="map-caption"><span className="caption-dot" />{position ? '현재 위치 사용 중' : `지도 중심 · ${center ? '주변 검색' : '고양시'}`}</div>
          {level >= 7 && <div className="zoom-hint">확대하면 정류장 마커가 표시됩니다</div>}
          <button className="map-location-button" onClick={locate} disabled={locationState === 'loading'} title="내 위치로 이동" aria-label="내 위치로 이동">⌖</button>
          {selectedStop && <div className="arrival-panel" role="region" aria-label="선택한 정류장 도착정보">
            <div className="arrival-heading"><div><span className="panel-eyebrow">STOP DETAILS</span><h2>{selectedStop.name}</h2><p>ID {selectedStop.id.value}{selectedStop.mobileNo ? ` · 정류장 번호 ${selectedStop.mobileNo}` : ''}</p></div><button onClick={() => setSelectedStop(null)} aria-label="도착정보 닫기">×</button></div>
            <div className="arrival-content">
              {arrivalsState === 'loading' && <p className="arrival-message">실시간 도착정보를 불러오는 중입니다…</p>}
              {arrivalsState === 'error' && <div className="arrival-error" role="alert"><strong>도착정보 조회 실패</strong><p>{arrivalsError}</p></div>}
              {arrivalsState === 'ready' && arrivals?.arrivals.length === 0 && <p className="arrival-message">현재 제공되는 도착정보가 없습니다. 운행 여부는 확인되지 않았습니다.</p>}
              {arrivalsState === 'ready' && arrivals && arrivals.arrivals.map((arrival, index) => <div className="arrival-row" key={`${arrival.routeId.provider}:${arrival.routeId.value}:${arrival.stopId.value}:${index}`}>
                <div className="arrival-route"><span className="route-number">{arrival.routeName}</span><span className="route-destination">{arrival.destination ? `${arrival.destination} 방면` : '방면 정보 없음'}</span></div>
                {statusLabel(arrival.operationStatus) ? <span className="arrival-state">{statusLabel(arrival.operationStatus)}</span> : arrival.visits.length ?
                  <div className="visit-list">{arrival.visits.map((visit, index) => <div className="visit" key={index}><strong>{visit.minutesUntilArrival === null ? '도착시간 미제공' : visit.minutesUntilArrival === 0 ? '곧 도착' : `약 ${visit.minutesUntilArrival}분 후`}</strong><span>{visit.stopsAway === null ? '위치 미제공' : `${visit.stopsAway}정거장 전`}</span></div>)}</div> :
                  <span className="arrival-state">도착 예정 정보 없음</span>}
              </div>)}
            </div>
            <div className="arrival-footer">{timeLabel(arrivals?.queriedAt ?? null)} · GBIS <span>1분마다 다시 조회</span></div>
          </div>}
          <button className="mobile-list-toggle" onClick={() => setMobileListOpen((open) => !open)} aria-expanded={mobileListOpen} aria-controls="mobile-stop-list">정류장 목록 <span>{stopsState === 'ready' ? `${stops.length}곳` : ''} {mobileListOpen ? '⌄' : '⌃'}</span></button>
        </section>
      </main>
    </div>
  )
}
