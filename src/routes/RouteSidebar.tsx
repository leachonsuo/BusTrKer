import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SelectedRoute } from '../App'
import { transitKey, type Route, type RouteStop } from '../transit/api'
import type { MapVehicleSection } from '../map/MapView'
import type { VehicleSnapshot } from '../transit/useVehicleTracking'
import { vehicleBelongsToDirection, type DirectionSplit } from '../transit/routeDirections'
import { ROUTE_COLOR_PRESETS, sectionColorForRoute } from '../transit/routeColors'

interface Props {
  query: string
  searchState: 'idle' | 'loading' | 'ready' | 'error'
  searchError: string
  results: Route[]
  selected: SelectedRoute[]
  activeKey: string | null
  focusedStop: { routeKey: string; stopId: string; sequence: number | null } | null
  limitMessage: string
  onChoose(route: Route): void
  onToggle(key: string): void
  onRemove(key: string): void
  onColorChange(key: string, color: string): void
  onExpand(key: string): void
  onActivate(key: string): void
  onStopSelect(routeKey: string, stop: RouteStop): void
  vehicleSnapshots: Record<string, VehicleSnapshot>
  vehicleSections: MapVehicleSection[]
  activeVehicleKey: string | null
  focusedSection: { routeKey: string; stationSequence: number } | null
  onVehicleSelect(key: string): void
  onVehicleRefresh(): void
  refreshNotice: string
  now: number
  directionSplits: Map<string, DirectionSplit>
  onReselectDirection(key: string): void
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
  if (stop.turnYn === true) return '회차점'
  if (item.route.startStopId && transitKey(item.route.startStopId) === transitKey(stop.id)) return '기점'
  if (item.route.endStopId && transitKey(item.route.endStopId) === transitKey(stop.id)) return '종점'
  return null
}

function matchedStop(focus: Props['focusedStop'], routeKey: string, stop: RouteStop): boolean {
  return focus?.routeKey === routeKey && focus.stopId === transitKey(stop.id) &&
    (focus.sequence === null || focus.sequence === stop.sequence)
}

function progressState(code: 0 | 1 | 2): string {
  return code === 0 ? '교차로 통과' : code === 1 ? '정류소 도착' : '정류소 출발'
}

export function RouteSidebar({ query, searchState, searchError, results, selected, activeKey, focusedStop, limitMessage,
  onChoose, onToggle, onRemove, onExpand, onActivate, onStopSelect, onColorChange,
  vehicleSnapshots, vehicleSections, activeVehicleKey, focusedSection, onVehicleSelect, onVehicleRefresh, refreshNotice, now,
  directionSplits, onReselectDirection }: Props) {
  const [vehicleListOpen, setVehicleListOpen] = useState<Record<string, boolean>>({})
  const [colorPickerKey, setColorPickerKey] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrolledSectionsRef = useRef(new Set<string>())
  const focusedRoute = selected.find((item) => item.key === focusedSection?.routeKey)
  const focusedCurrent = focusedRoute?.stops.find((stop) => stop.sequence === focusedSection?.stationSequence)
  const focusedNext = focusedRoute?.stops.find((stop) => stop.sequence === (focusedSection?.stationSequence ?? -1) + 1)
  const focusedCount = vehicleSections.filter((section) => section.routeKey === focusedSection?.routeKey && section.stationSequence === focusedSection?.stationSequence).length
  useEffect(() => {
    if (!activeKey || !scrollRef.current) return
    const container = scrollRef.current
    const focused = focusedStop?.routeKey === activeKey && focusedStop.sequence !== null
      ? [...container.querySelectorAll<HTMLElement>('[data-route-stop]')].find((row) =>
        row.dataset.routeStop === `${activeKey}:${focusedStop?.sequence}:${focusedStop?.stopId}`)
      : null
    const route = [...container.querySelectorAll<HTMLElement>('[data-route-key]')].find((row) => row.dataset.routeKey === activeKey)
    ;(focused ?? route)?.scrollIntoView({ block: 'nearest' })
  }, [activeKey, focusedStop, selected.find((item) => item.key === activeKey)?.stopsState])
  useEffect(() => {
    if (!activeKey || focusedSection?.routeKey === activeKey || autoScrolledSectionsRef.current.has(activeKey)) return
    const first = vehicleSections.find((section) => section.routeKey === activeKey)
    if (!first) return
    const route = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-route-key]') ?? [])]
      .find((element) => element.dataset.routeKey === activeKey)
    const list = route?.querySelector<HTMLElement>('.route-stop-list')
    const section = [...(list?.querySelectorAll<HTMLElement>('[data-route-section]') ?? [])]
      .find((element) => element.dataset.routeSection === String(first.stationSequence))
    if (!list || !section) return
    list.scrollTop = Math.max(0, section.offsetTop - list.offsetTop - 90)
    autoScrolledSectionsRef.current.add(activeKey)
  }, [activeKey, focusedSection, vehicleSections])
  return <>
    <div className="sidebar-heading route-heading"><div><p className="eyebrow">BUS ROUTES</p><h1>버스 노선</h1></div><span className="route-count">{selected.length}/5 선택</span></div>
    <p className="sidebar-subtitle">실제 GBIS 노선형상과 확인된 운행 구간을 표시합니다. <button className="vehicle-refresh" onClick={onVehicleRefresh}>차량 새로고침</button></p>
    {refreshNotice && <p className="route-refresh-notice" role="status">{refreshNotice}</p>}
    {focusedCount > 0 && focusedCurrent && focusedNext && <p className="route-section-detail" role="status">
      <strong>🚌 {focusedRoute?.route.name} · 확인된 운행 구간 {focusedCount}대</strong><span>{focusedCurrent.name} → {focusedNext.name}</span><small>정류장 사이 구간 기준 · GPS 위치 아님</small>
    </p>}
    <div className="route-sidebar-scroll" ref={scrollRef}>
      <section className="selected-routes" aria-label="선택한 버스 노선">
        <h2>선택한 노선 <small>최대 5개</small></h2>
        {selected.length === 0 && <p className="route-empty">버스번호를 검색하고 노선을 선택해 보세요.</p>}
        {limitMessage && <p className="route-error" role="alert">{limitMessage}</p>}
        {selected.map((item) => {
          const split = directionSplits.get(item.key)
          const direction = split?.directions?.find((entry) => entry.key === item.directionKey)
          const directionReady = !!direction && !item.choosingDirection
          const previewDirection = split?.directions?.[0]
          return <div className={`selected-route ${activeKey === item.key ? 'active' : ''}${item.visible ? '' : ' is-hidden'}`} key={item.key} data-route-key={item.key} style={{ '--route-color': item.color, '--section-color': sectionColorForRoute(item.color) } as CSSProperties}>
          <div className="selected-route-top">
            <button className="selected-route-name" onClick={() => onActivate(item.key)} title="지도에서 이 노선 강조" aria-pressed={activeKey === item.key}>
              <span className="route-color-dot" style={{ backgroundColor: item.color }} />
              <span><strong>{item.route.name}</strong><small>{activeKey === item.key ? '선택한 노선 · ' : ''}{item.route.typeName ?? '노선 유형 미제공'}</small></span>
            </button>
            <button className="route-action" onClick={() => onToggle(item.key)} aria-label={`${item.route.name} 노선 ${item.visible ? '숨기기' : '표시하기'}`} aria-pressed={item.visible}>{item.visible ? '숨기기' : '보이기'}</button>
            <button className="route-action" onClick={() => setColorPickerKey((previous) => previous === item.key ? null : item.key)} aria-label={`${item.route.name} 노선 색상 설정`} aria-expanded={colorPickerKey === item.key}>색상</button>
            <button className="route-action route-remove" onClick={() => onRemove(item.key)} aria-label={`${item.route.name} 노선 삭제`}>×</button>
          </div>
          {colorPickerKey === item.key && <div className="route-color-picker" aria-label={`${item.route.name} 노선 색상`}>
            <div className="route-color-presets">{ROUTE_COLOR_PRESETS.map((color) => <button key={color} type="button" className="route-color-preset"
              style={{ backgroundColor: color }} aria-label={`노선 색상 ${color}`} aria-pressed={item.color.toLowerCase() === color}
              onClick={() => onColorChange(item.key, color)} />)}</div>
            <label>직접 선택 <input type="color" value={item.color} onChange={(event) => onColorChange(item.key, event.target.value)} /></label>
            <button type="button" className="route-color-reset" onClick={() => onColorChange(item.key, ROUTE_COLOR_PRESETS[0])}>기본 파란색으로 복원</button>
            <span className="route-color-preview"><i style={{ borderTopColor: item.color }} />기본선 <i className="section" style={{ borderTopColor: sectionColorForRoute(item.color) }} />운행 구간</span>
          </div>}
          <p className="selected-route-description">{routeDescription(item.route)}</p>
          {item.shapeState === 'loading' && <p className="route-status">도로 경로를 불러오는 중…</p>}
          {item.shapeState === 'error' && <p className="route-error">경로 조회 실패 · {item.shapeError}</p>}
          {item.shapeState === 'ready' && !item.shape && <p className="route-status">제공되는 노선형상이 없습니다.</p>}
          {item.shape && <p className="route-status">{directionReady ? direction.label : previewDirection ? `${previewDirection.label} 미리보기` : split ? '전체 노선 개요' : '방향 분석 중'} · 실제 형상 {directionReady ? direction.shape.points.length : previewDirection ? previewDirection.shape.points.length : item.shape.points.length}개 좌표</p>}
          {item.detailError && <p className="route-status">상세정보: {item.detailError}</p>}
          {directionReady ? <button className="direction-reselect" onClick={() => onReselectDirection(item.key)}>방향 다시 선택 · 현재 {direction.label}</button> :
            <p className="route-status">{split && !split.directions ? split.reason : '운행 방향을 선택하면 해당 방향의 정류장과 차량 구간이 표시됩니다.'}</p>}
          {directionReady && <>
          {(() => {
            const snapshot = vehicleSnapshots[item.key]
            const age = snapshot?.data ? now - Date.parse(snapshot.data.queriedAt) : NaN
            const fresh = snapshot?.data && Number.isFinite(age) && age >= -30_000 && age <= 120_000
            const vehicles = snapshot?.status === 'ready' && fresh ? snapshot.data?.vehicles.filter((vehicle) => vehicleBelongsToDirection(vehicle, direction)) ?? [] : []
            const verifiedCount = vehicleSections.filter((section) => section.routeKey === item.key).length
            const listOpen = vehicleListOpen[item.key] ?? false
            return <div className="vehicle-group" aria-label={`${item.route.name} 운행 차량`}>
              <div className="vehicle-group-heading"><strong>방향 확인 차량 {snapshot?.status === 'ready' && fresh ? `${vehicles.length}대` : '—'}</strong>
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
            경유 정류장 {item.stopsState === 'ready' ? `${direction.stops.length}곳` : ''} <span>{item.expanded ? '접기' : '펼치기'}</span>
          </button>
          {item.expanded && <div className="route-stop-list">
            {item.stopsState === 'loading' && <p className="route-status">경유 정류장을 불러오는 중…</p>}
            {item.stopsState === 'error' && <p className="route-error">{item.stopsError}</p>}
            {item.stopsState === 'ready' && item.stops.length === 0 && <p className="route-status">경유 정류장 정보가 없습니다.</p>}
            {item.stops.length > 0 && (() => {
              const ordered = [...direction.stops].sort((a, b) => a.sequence - b.sequence)
              const turnIndex = ordered.findIndex((stop) => stop.turnYn === true)
              const focusedMatches = ordered.filter((stop) => matchedStop(focusedStop, item.key, stop)).length
              return <>
                {focusedStop?.routeKey === item.key && focusedStop.sequence === null && focusedMatches > 1 &&
                  <p className="route-status">같은 정류장 ID를 {focusedMatches}회 경유합니다. 목록에서 방문 순서를 선택해 주세요.</p>}
                {ordered.map((stop, index) => {
                  const section = turnIndex < 0 ? null : index === 0 ? '운행 방향' : index === turnIndex ? '회차 지점' : index === turnIndex + 1 ? '복귀 방향' : null
                  const sectionVehicles = vehicleSections.filter((vehicle) => vehicle.routeKey === item.key && vehicle.stationSequence === stop.sequence)
                  const selected = matchedStop(focusedStop, item.key, stop)
                  return <div key={`${stop.sequence}:${transitKey(stop.id)}`}>
                    {section && <div className="route-stop-section">{section}</div>}
                    <button className={`route-stop-row${selected ? ' selected' : ''}${stop.turnYn === true ? ' turnaround' : ''}`} data-route-stop={`${item.key}:${stop.sequence}:${transitKey(stop.id)}`} aria-pressed={selected}
                      onClick={() => onStopSelect(item.key, stop)}>
                      <span className="route-stop-sequence">{String(stop.sequence).padStart(2, '0')}</span><span className="route-stop-name">{stop.name}</span>
                      {stopBadge(item, stop) && <small>{stopBadge(item, stop)}</small>}
                    </button>
                    {sectionVehicles.length > 0 && <div data-route-section={stop.sequence} className={`route-stop-vehicles${sectionVehicles.some((vehicle) => vehicle.key === activeVehicleKey) ? ' selected' : ''}`}>
                      <span aria-hidden="true">🚌</span><span>현재 다음 정류장까지 운행 중 · {sectionVehicles.length}대<br /><small>정확한 GPS 위치 아님</small></span>
                    </div>}
                  </div>
                })}
              </>
            })()}
          </div>}
          </>}
          {split && !split.directions && item.stopsState === 'ready' && item.stops.length > 0 && <>
            <button className="route-expand" onClick={() => onExpand(item.key)} aria-expanded={item.expanded}>
              전체 경유 정류장 {item.stops.length}곳 <span>{item.expanded ? '접기' : '펼치기'}</span>
            </button>
            {item.expanded && <div className="route-stop-list" aria-label={`${item.route.name} 전체 경유 정류장`}>
              <p className="route-status">방향 경계를 확인할 수 없어 전체 방문 순서로 표시합니다.</p>
              {[...item.stops].sort((a, b) => a.sequence - b.sequence).map((stop) => {
                const selected = matchedStop(focusedStop, item.key, stop)
                return <button key={`${stop.sequence}:${transitKey(stop.id)}`}
                  className={`route-stop-row${selected ? ' selected' : ''}${stop.turnYn === true ? ' turnaround' : ''}`}
                  data-route-stop={`${item.key}:${stop.sequence}:${transitKey(stop.id)}`} aria-pressed={selected}
                  onClick={() => onStopSelect(item.key, stop)}>
                  <span className="route-stop-sequence">{String(stop.sequence).padStart(2, '0')}</span>
                  <span className="route-stop-name">{stop.name}</span>
                  {stopBadge(item, stop) && <small>{stopBadge(item, stop)}</small>}
                </button>
              })}
            </div>}
          </>}
        </div>})}
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
