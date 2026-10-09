import type { SelectedRoute } from '../App'
import { transitKey, type Route, type RouteStop } from '../transit/api'
import type { MapVehicleSection } from '../map/MapView'
import type { VehicleSnapshot } from '../transit/useVehicleTracking'

interface Props {
  query: string
  searchState: 'idle' | 'loading' | 'ready' | 'error'
  searchError: string
  results: Route[]
  selected: SelectedRoute[]
  activeKey: string | null
  limitMessage: string
  onChoose(route: Route): void
  onToggle(key: string): void
  onRemove(key: string): void
  onExpand(key: string): void
  onActivate(key: string): void
  onStopSelect(stop: RouteStop): void
  vehicleSnapshots: Record<string, VehicleSnapshot>
  vehicleSections: MapVehicleSection[]
  activeVehicleKey: string | null
  onVehicleSelect(key: string): void
  onVehicleRefresh(): void
  refreshNotice: string
  now: number
}

function queryAge(value: string, now: number): string {
  const elapsed = now - Date.parse(value)
  if (!Number.isFinite(elapsed) || elapsed < -30_000) return '조회 시각 확인 불가'
  if (elapsed < 0) return '방금 조회'
  if (elapsed < 60_000) return '1분 이내 조회'
  return `${Math.floor(elapsed / 60_000)}분 전 조회`
}

function vehicleError(message: string): string {
  if (/429|제한|quota|rate limit/i.test(message)) return '요청이 제한되었습니다. 잠시 후 다시 시도해 주세요.'
  if (/timeout|시간 초과|timed out/i.test(message)) return '조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
  if (/연결|network|fetch/i.test(message)) return '서버 연결을 확인해 주세요.'
  return '차량 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

function routeDescription(route: Route): string {
  return [route.startName && route.endName ? `${route.startName} → ${route.endName}` : route.startName ?? route.endName,
    route.typeName, route.regionName].filter(Boolean).join(' · ') || '상세정보 없음'
}

function stopBadge(item: SelectedRoute, stop: RouteStop): string | null {
  if (item.route.startStopId && transitKey(item.route.startStopId) === transitKey(stop.id)) return '기점'
  if (item.route.endStopId && transitKey(item.route.endStopId) === transitKey(stop.id)) return '종점'
  if (stop.turnYn === true) return '회차점'
  return null
}

function progressState(code: 0 | 1 | 2): string {
  return code === 0 ? '교차로 통과' : code === 1 ? '정류소 도착' : '정류소 출발'
}

export function RouteSidebar({ query, searchState, searchError, results, selected, activeKey, limitMessage,
  onChoose, onToggle, onRemove, onExpand, onActivate, onStopSelect,
  vehicleSnapshots, vehicleSections, activeVehicleKey, onVehicleSelect, onVehicleRefresh, refreshNotice, now }: Props) {
  const [vehicleListOpen, setVehicleListOpen] = useState<Record<string, boolean>>({})
  return <>
    <div className="sidebar-heading route-heading"><div><p className="eyebrow">BUS ROUTES</p><h1>버스 노선</h1></div><span className="route-count">{selected.length}/5 선택</span></div>
    <p className="sidebar-subtitle">실제 GBIS 노선형상과 확인된 운행 구간을 표시합니다. <button className="vehicle-refresh" onClick={onVehicleRefresh}>차량 새로고침</button></p>
    {refreshNotice && <p className="route-refresh-notice" role="status">{refreshNotice}</p>}
    <div className="route-sidebar-scroll">
      <section className="selected-routes" aria-label="선택한 버스 노선">
        <h2>선택한 노선 <small>최대 5개</small></h2>
        {selected.length === 0 && <p className="route-empty">버스번호를 검색하고 노선을 선택해 보세요.</p>}
        {limitMessage && <p className="route-error" role="alert">{limitMessage}</p>}
        {selected.map((item) => <div className={`selected-route ${activeKey === item.key ? 'active' : ''}${item.visible ? '' : ' is-hidden'}`} key={item.key} data-route-key={item.key} style={{ '--route-color': item.color } as CSSProperties}>
          <div className="selected-route-top">
            <button className="selected-route-name" onClick={() => onActivate(item.key)} title="지도에서 이 노선 강조" aria-pressed={activeKey === item.key}>
              <span className="route-color-dot" style={{ backgroundColor: item.color }} />
              <span><strong>{item.route.name}</strong><small>{activeKey === item.key ? '선택한 노선 · ' : ''}{item.route.typeName ?? '노선 유형 미제공'}</small></span>
            </button>
            <button className="route-action" onClick={() => onToggle(item.key)} aria-label={`${item.route.name} 노선 ${item.visible ? '숨기기' : '표시하기'}`} aria-pressed={item.visible}>{item.visible ? '숨기기' : '보이기'}</button>
            <button className="route-action route-remove" onClick={() => onRemove(item.key)} aria-label={`${item.route.name} 노선 삭제`}>×</button>
          </div>
          <p className="selected-route-description">{routeDescription(item.route)}</p>
          {item.shapeState === 'loading' && <p className="route-status">도로 경로를 불러오는 중…</p>}
          {item.shapeState === 'error' && <p className="route-error">경로 조회 실패 · {item.shapeError}</p>}
          {item.shapeState === 'ready' && !item.shape && <p className="route-status">제공되는 노선형상이 없습니다.</p>}
          {item.shape && <p className="route-status">실제 노선형상 {item.shape.points.length}개 좌표 · {item.visible ? '지도에 표시 중' : '숨김'}</p>}
          {item.detailError && <p className="route-status">상세정보: {item.detailError}</p>}
          {(() => {
            const snapshot = vehicleSnapshots[item.key]
            const age = snapshot?.data ? now - Date.parse(snapshot.data.queriedAt) : NaN
            const fresh = snapshot?.data && Number.isFinite(age) && age >= -30_000 && age <= 120_000
            const vehicles = snapshot?.status === 'ready' && fresh ? snapshot.data?.vehicles ?? [] : []
            const verifiedCount = vehicleSections.filter((section) => section.routeKey === item.key).length
            const listOpen = vehicleListOpen[item.key] ?? activeKey === item.key
            return <div className="vehicle-group" aria-label={`${item.route.name} 운행 차량`}>
              <div className="vehicle-group-heading"><strong>운행 차량 {snapshot?.status === 'ready' && fresh ? `${vehicles.length}대` : '—'}</strong>
                <small>{snapshot?.data ? queryAge(snapshot.data.queriedAt, now) : '조회 전'}</small></div>
              {snapshot?.status === 'ready' && fresh && <div className="vehicle-summary"><span>구간 확인 <strong>{verifiedCount}대</strong></span><span>구간 미확인 <strong>{vehicles.length - verifiedCount}대</strong></span></div>}
              {!item.visible && <p className="route-status">노선 숨김 · 차량 자동 조회 중지</p>}
              {item.visible && snapshot?.status === 'loading' && <p className="route-status">차량 위치 조회 중…</p>}
              {item.visible && snapshot?.status === 'error' && <div className="route-error" role="alert">{vehicleError(snapshot.message)}<details><summary>오류 내용</summary>{snapshot.message}</details></div>}
              {item.visible && snapshot?.status === 'ready' && !fresh && <p className="route-status">위치정보 갱신 지연 · 구간 강조 중지</p>}
              {item.visible && snapshot?.status === 'ready' && fresh && vehicles.length === 0 && <p className="route-status">현재 제공되는 운행 차량 정보가 없습니다.</p>}
              {item.visible && vehicles.length > 0 && <button className="vehicle-list-toggle" onClick={() => setVehicleListOpen((previous) => ({ ...previous, [item.key]: !listOpen }))} aria-expanded={listOpen} aria-controls={`vehicles-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>차량 목록 {vehicles.length}대 <span>{listOpen ? '접기' : '펼치기'}</span></button>}
              <div className="vehicle-list" id={`vehicles-${item.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`} hidden={!listOpen}>
              {item.visible && vehicles.map((vehicle) => {
                const key = `${item.key}:${vehicle.vehicleId}`
                const current = item.stops.find((stop) => stop.sequence === vehicle.stationSequence && stop.id.value === vehicle.currentStopId.value)
                const next = item.stops.find((stop) => stop.sequence === vehicle.stationSequence + 1 && stop.id.value === vehicle.nextStopId?.value)
                const hasRoadSection = vehicleSections.some((section) => section.key === key)
                const transition = snapshot?.changes[vehicle.vehicleId]
                return <button className={`vehicle-row ${activeVehicleKey === key ? 'selected' : ''}`} key={key}
                  onClick={() => onVehicleSelect(key)}>
                  <span className="vehicle-symbol">버스</span><span><strong>차량 {vehicle.vehicleId}</strong>
                    <small className="vehicle-transition">{hasRoadSection && current && next ? `${current.name} → ${next.name} · 구간 기준 위치` :
                      current && vehicle.stateCode === 1 ? `${current.name} 정류장 도착` :
                        `${progressState(vehicle.stateCode)} · 운행 구간 확인 불가`}</small>
                    <small>{hasRoadSection ? '지도에서 구간 보기' : '구간 초점 이동 불가'} · GPS 없음</small>
                    {transition && <small className="vehicle-transition">이전 조회: {transition.fromSequence}→{transition.toSequence}번 · {progressState(transition.fromState)}→{progressState(transition.toState)}</small>}</span>
                </button>
              })}
              </div>
              {item.visible && <p className="vehicle-disclaimer">GBIS 정류장 진행 정보 · 1분 간격 조회 · GPS 위치 아님</p>}
            </div>
          })()}
          <button className="route-expand" onClick={() => onExpand(item.key)} aria-expanded={item.expanded}>
            경유 정류장 {item.stopsState === 'ready' ? `${item.stops.length}곳` : ''} <span>{item.expanded ? '접기' : '펼치기'}</span>
          </button>
          {item.expanded && <div className="route-stop-list">
            {item.stopsState === 'loading' && <p className="route-status">경유 정류장을 불러오는 중…</p>}
            {item.stopsState === 'error' && <p className="route-error">{item.stopsError}</p>}
            {item.stopsState === 'ready' && item.stops.length === 0 && <p className="route-status">경유 정류장 정보가 없습니다.</p>}
            {item.stops.map((stop) => <button className="route-stop-row" key={`${stop.sequence}:${transitKey(stop.id)}`} onClick={() => onStopSelect(stop)}>
              <span className="route-stop-sequence">{stop.sequence}</span><span>{stop.name}</span>
              {stopBadge(item, stop) && <small>{stopBadge(item, stop)}</small>}
            </button>)}
          </div>}
        </div>)}
      </section>
      <section className="route-search-results" aria-label="노선 검색 결과">
        <h2>검색 결과 {searchState === 'ready' ? <small>{results.length}개</small> : null}</h2>
        {searchState === 'idle' && <p className="route-empty">상단에서 버스번호를 입력하세요. 고양시 노선을 먼저 보여주지만 GBIS 검색 결과 전체에서 선택할 수 있습니다.</p>}
        {searchState === 'loading' && <p className="route-empty" role="status">노선을 검색하는 중…</p>}
        {searchState === 'error' && <p className="route-error" role="alert">노선 검색 실패 · {searchError}</p>}
        {searchState === 'ready' && results.length === 0 && <p className="route-empty">“{query}” 검색 결과가 없습니다.</p>}
        {searchState === 'ready' && results.length > 120 && <p className="route-status">처음 120개 결과를 표시합니다. 버스번호를 더 자세히 입력해 주세요.</p>}
        {searchState === 'ready' && results.slice(0, 120).map((route) => {
          const chosen = selected.some((item) => item.key === transitKey(route.id))
          return <button className="route-result" key={transitKey(route.id)} onClick={() => onChoose(route)}>
            <span className="route-result-number">{route.name}</span>
            <span className="route-result-details"><strong>{routeDescription(route)}</strong><small>노선 ID {route.id.value}</small></span>
            <span className="route-result-add">{chosen ? '선택됨' : '+'}</span>
          </button>
        })}
      </section>
    </div>
    <div className="sidebar-footer"><span className="footer-rule" />경로는 GBIS 노선형상 좌표를 사용합니다.<br />화살표는 제공된 좌표 순서를 따라 표시합니다.</div>
  </>
}
import { useState, type CSSProperties } from 'react'
