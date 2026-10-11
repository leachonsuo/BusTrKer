import { useCallback, useEffect, useRef, useState } from 'react'
import { loadKakaoMaps, type KakaoCustomOverlay, type KakaoMap, type KakaoMarker, type KakaoMapsApi, type KakaoPolyline, type LatLng } from './kakao'
import { stopKey, transitKey, type RouteShape, type RouteStop, type Stop } from '../transit/api'
import { routeArrows } from './routeArrows'
import { groupVehicleSections } from '../transit/routeSegments'
import { sectionHaloColor } from '../transit/routeColors'
import { pickDirectionGuides, type ScreenRect } from './directionGuides'
import type { RouteDirection } from '../transit/routeDirections'
import { countMap, timeMap } from './mapDiagnostics'

const GOYANG_CENTER: LatLng = { latitude: 37.6584, longitude: 126.8320 }
const PREVIEW_ROUTE_COLOR = '#3b82f6'

export interface MapHandle {
  moveTo(position: LatLng): void
  focusStop(stop: Stop): void
  fitRoute(shape: RouteShape): void
  fitRoutes(shapes: RouteShape[]): void
  focusSection(points: LatLng[]): void
}

export interface MapRoute { key: string; color: string; strokeWeight: number; visible: boolean; shape: RouteShape | null; stops: RouteStop[]; preview?: boolean; previewColor?: string }
export interface MapVehicleSection { key: string; routeKey: string; stationSequence: number; color: string; path: LatLng[] }

interface Props {
  appKey: string
  userPosition: LatLng | null
  userPositionAccuracy: number | null
  stops: Stop[]
  selectedStop: Stop | null
  focusedRouteStop: { routeKey: string; stopId: string; sequence: number | null } | null
  level: number
  onReady(handle: MapHandle): void
  onError(message: string): void
  onViewportChange(center: LatLng, level: number): void
  onStopSelect(stop: Stop): void
  onRouteStopSelect(routeKey: string, stop: RouteStop): void
  onRouteSelect(key: string): void
  onSectionSelect(routeKey: string, stationSequence: number): void
  directionOptions: readonly RouteDirection[]
  onDirectionSelect(directionKey: string): void
  routes: MapRoute[]
  activeRouteKey: string | null
  vehicleSections: MapVehicleSection[]
  activeVehicleKey: string | null
  focusedSection: { routeKey: string; stationSequence: number } | null
}

interface MarkerEntry { marker: KakaoMarker; click: () => void }
interface RouteLineEntry { line: KakaoPolyline; shape: RouteShape; preview: boolean; click: () => void; over: () => void; out: () => void }
interface SectionLineEntry { line: KakaoPolyline; halo: KakaoPolyline; path: LatLng[]; click: () => void }
interface SectionIconEntry { overlay: KakaoCustomOverlay; button: HTMLButtonElement; path: LatLng[]; count: number }
interface RouteArrowEntry { overlay: KakaoCustomOverlay; content: HTMLDivElement }

function samePath(a: LatLng[], b: LatLng[]): boolean {
  return a === b || (a.length === b.length && a.every((point, index) =>
    point.latitude === b[index].latitude && point.longitude === b[index].longitude))
}

function pathMidpoint(points: LatLng[], project: (point: LatLng) => { x: number; y: number }): LatLng {
  const screen = points.map(project)
  const lengths = screen.slice(1).map((point, index) => Math.hypot(point.x - screen[index].x, point.y - screen[index].y))
  const halfway = lengths.reduce((sum, length) => sum + length, 0) / 2
  let travelled = 0
  for (let index = 0; index < lengths.length; index++) {
    if (travelled + lengths[index] >= halfway && lengths[index] > 0) {
      const ratio = (halfway - travelled) / lengths[index]
      return { latitude: points[index].latitude + (points[index + 1].latitude - points[index].latitude) * ratio,
        longitude: points[index].longitude + (points[index + 1].longitude - points[index].longitude) * ratio }
    }
    travelled += lengths[index]
  }
  return points[Math.floor(points.length / 2)]
}

function markerLimit(level: number): number {
  if (level <= 3) return 35
  if (level === 4) return 28
  if (level === 5) return 18
  if (level === 6) return 10
  return 0
}

export function MapView({ appKey, userPosition, userPositionAccuracy, stops, selectedStop, focusedRouteStop, level, onReady, onError, onViewportChange, onStopSelect, onRouteStopSelect, onRouteSelect, onSectionSelect, directionOptions, onDirectionSelect, routes, activeRouteKey, vehicleSections, activeVehicleKey, focusedSection }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<KakaoMap | null>(null)
  const apiRef = useRef<KakaoMapsApi | null>(null)
  const userMarkerRef = useRef<KakaoMarker | null>(null)
  const stopMarkersRef = useRef<MarkerEntry[]>([])
  const routeStopMarkersRef = useRef<MarkerEntry[]>([])
  const directionMarkersRef = useRef(new Map<string, { overlay: KakaoCustomOverlay; button: HTMLButtonElement; arrow: HTMLSpanElement } >())
  const polylinesRef = useRef(new Map<string, RouteLineEntry>())
  const vehicleLinesRef = useRef(new Map<string, SectionLineEntry>())
  const sectionIconsRef = useRef(new Map<string, SectionIconEntry>())
  const arrowsRef = useRef(new Map<string, RouteArrowEntry>())
  const routesRef = useRef<MapRoute[]>([])
  const sectionsRef = useRef<MapVehicleSection[]>([])
  const activeRouteRef = useRef(activeRouteKey)
  const routeSelectRef = useRef(onRouteSelect)
  const sectionSelectRef = useRef(onSectionSelect)
  const directionSelectRef = useRef(onDirectionSelect)
  activeRouteRef.current = activeRouteKey
  routeSelectRef.current = onRouteSelect
  sectionSelectRef.current = onSectionSelect
  directionSelectRef.current = onDirectionSelect
  const [ready, setReady] = useState(false)
  const [arrowRevision, setArrowRevision] = useState(0)

  const drawArrows = useCallback(() => {
    const map = mapRef.current
    const maps = apiRef.current
    const container = containerRef.current
    if (!map || !maps || !container) return
    const started = performance.now()
    const projection = map.getProjection()
    const zoom = map.getLevel()
    const visible = zoom <= 5 ? routesRef.current.filter((route) => route.visible && route.shape && !route.preview) : []
    const spacing = zoom <= 3 ? 115 : 145
    const perRouteLimit = Math.max(4, Math.floor(24 / Math.max(visible.length, 1)))
    const currentKeys = new Set<string>()
    const occupied: { x: number; y: number }[] = []
    // Route arrows over a thick vehicle section read as repeated crossing marks.
    const sectionSegments = sectionsRef.current.flatMap((section) => section.path.slice(1).map((point, index) => [
      projection.containerPointFromCoords(new maps.LatLng(section.path[index].latitude, section.path[index].longitude)),
      projection.containerPointFromCoords(new maps.LatLng(point.latitude, point.longitude)),
    ] as const))
    const onVehicleSection = (x: number, y: number) => sectionSegments.some(([a, b]) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const lengthSquared = dx * dx + dy * dy
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0
      return Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < 13
    })
    for (const route of visible) {
      const points = route.shape!.points
      const samples = routeArrows(points, (point) => projection.containerPointFromCoords(new maps.LatLng(point.latitude, point.longitude)),
        container.clientWidth, container.clientHeight, spacing, perRouteLimit)
      for (const sample of samples) {
        const screen = projection.containerPointFromCoords(new maps.LatLng(sample.position.latitude, sample.position.longitude))
        if (onVehicleSection(screen.x, screen.y) || occupied.some((point) => Math.hypot(point.x - screen.x, point.y - screen.y) < 40)) continue
        occupied.push(screen)
        const key = `${route.key}:${sample.position.latitude.toFixed(7)}:${sample.position.longitude.toFixed(7)}`
        currentKeys.add(key)
        const existing = arrowsRef.current.get(key)
        if (existing) {
          existing.content.className = `route-direction-arrow${route.key === activeRouteRef.current ? ' is-active' : ''}`
          existing.content.style.color = route.color
          continue
        }
        const content = document.createElement('div')
        content.className = `route-direction-arrow${route.key === activeRouteRef.current ? ' is-active' : ''}`
        content.dataset.routeKey = route.key
        content.style.color = route.color
        content.style.transform = `rotate(${sample.angle}deg)`
        content.textContent = '›'
        const overlay = new maps.CustomOverlay({ map, position: new maps.LatLng(sample.position.latitude, sample.position.longitude),
          content, xAnchor: 0.5, yAnchor: 0.5, zIndex: 2 })
        countMap('overlayCreated')
        arrowsRef.current.set(key, { overlay, content })
      }
    }
    for (const [key, entry] of arrowsRef.current) {
      if (currentKeys.has(key)) continue
      entry.overlay.setMap(null)
      countMap('overlayRemoved')
      arrowsRef.current.delete(key)
    }
    timeMap('arrowUpdate', started)
  }, [])

  useEffect(() => {
    let cancelled = false
    let idleTimer: number | undefined
    let idleHandler: (() => void) | undefined
    let createdMap: KakaoMap | undefined
    let mapsApi: KakaoMapsApi | undefined
    loadKakaoMaps(appKey).then((maps) => {
      if (cancelled || !containerRef.current) return
      mapsApi = maps
      apiRef.current = maps
      const map = new maps.Map(containerRef.current, {
        center: new maps.LatLng(GOYANG_CENTER.latitude, GOYANG_CENTER.longitude), level: 6,
      })
      createdMap = map
      countMap('mapCreated')
      mapRef.current = map
      const emitView = () => {
        const center = map.getCenter()
        onViewportChange({ latitude: center.getLat(), longitude: center.getLng() }, map.getLevel())
      }
      idleHandler = () => {
        window.clearTimeout(idleTimer)
        idleTimer = window.setTimeout(() => { emitView(); drawArrows(); setArrowRevision((value) => value + 1) }, 320)
      }
      maps.event.addListener(map, 'idle', idleHandler)
      countMap('listenerAdded')
      setReady(true)
      onReady({
        moveTo(position) {
          map.setCenter(new maps.LatLng(position.latitude, position.longitude))
          map.setLevel(4)
        },
        focusStop(stop) {
          map.setCenter(new maps.LatLng(stop.position.latitude, stop.position.longitude))
          map.setLevel(4)
        },
        fitRoute(shape) {
          if (shape.points.length < 2) return
          const bounds = new maps.LatLngBounds()
          for (const point of shape.points) bounds.extend(new maps.LatLng(point.latitude, point.longitude))
          map.setBounds(bounds, 55, 55, 55, 55)
        },
        fitRoutes(shapes) {
          const points = shapes.flatMap((shape) => shape.points)
          if (points.length < 2) return
          const bounds = new maps.LatLngBounds()
          for (const point of points) bounds.extend(new maps.LatLng(point.latitude, point.longitude))
          map.setBounds(bounds, 55, 55, 55, 55)
        },
        focusSection(points) {
          if (points.length < 2) return
          const bounds = new maps.LatLngBounds()
          for (const point of points) bounds.extend(new maps.LatLng(point.latitude, point.longitude))
          map.setBounds(bounds, 90, 90, 90, 90)
        },
      })
      emitView()
    }).catch((error: unknown) => {
      if (!cancelled) onError(error instanceof Error ? error.message : '지도를 불러오지 못했습니다.')
    })

    return () => {
      cancelled = true
      window.clearTimeout(idleTimer)
      if (createdMap && mapsApi && idleHandler) { mapsApi.event.removeListener(createdMap, 'idle', idleHandler); countMap('listenerRemoved') }
      if (createdMap) countMap('mapDisposed')
      if (userMarkerRef.current) { userMarkerRef.current.setMap(null); countMap('markerRemoved') }
      userMarkerRef.current = null
      for (const entry of stopMarkersRef.current) {
        mapsApi?.event.removeListener(entry.marker, 'click', entry.click)
        countMap('listenerRemoved')
        entry.marker.setMap(null)
        countMap('markerRemoved')
      }
      stopMarkersRef.current = []
      for (const entry of routeStopMarkersRef.current) {
        mapsApi?.event.removeListener(entry.marker, 'click', entry.click)
        countMap('listenerRemoved')
        entry.marker.setMap(null)
        countMap('markerRemoved')
      }
      routeStopMarkersRef.current = []
      for (const entry of directionMarkersRef.current.values()) { entry.overlay.setMap(null); entry.button.remove(); countMap('overlayRemoved') }
      directionMarkersRef.current.clear()
      for (const entry of polylinesRef.current.values()) {
        mapsApi?.event.removeListener(entry.line, 'click', entry.click)
        mapsApi?.event.removeListener(entry.line, 'mouseover', entry.over)
        mapsApi?.event.removeListener(entry.line, 'mouseout', entry.out)
        countMap('listenerRemoved', 3)
        entry.line.setMap(null)
        countMap('polylineRemoved')
      }
      polylinesRef.current.clear()
      for (const entry of vehicleLinesRef.current.values()) {
        mapsApi?.event.removeListener(entry.line, 'click', entry.click)
        mapsApi?.event.removeListener(entry.halo, 'click', entry.click)
        countMap('listenerRemoved', 2)
        entry.line.setMap(null)
        entry.halo.setMap(null)
        countMap('polylineRemoved', 2)
      }
      vehicleLinesRef.current.clear()
      for (const entry of sectionIconsRef.current.values()) { entry.overlay.setMap(null); countMap('overlayRemoved') }
      sectionIconsRef.current.clear()
      for (const entry of arrowsRef.current.values()) { entry.overlay.setMap(null); countMap('overlayRemoved') }
      arrowsRef.current.clear()
      mapRef.current = null
      apiRef.current = null
    }
  }, [appKey, onError, onReady, onViewportChange, drawArrows])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps || !userPosition) return
    if (userMarkerRef.current) { userMarkerRef.current.setMap(null); countMap('markerRemoved') }
    userMarkerRef.current = new maps.Marker({
      position: new maps.LatLng(userPosition.latitude, userPosition.longitude),
      image: new maps.MarkerImage('/user-pin.svg', new maps.Size(28, 28)), map,
    })
    countMap('markerCreated')
    map.setCenter(new maps.LatLng(userPosition.latitude, userPosition.longitude))
    map.setLevel(4)
  }, [ready, userPosition])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    for (const entry of stopMarkersRef.current) {
      maps.event.removeListener(entry.marker, 'click', entry.click)
      countMap('listenerRemoved')
      entry.marker.setMap(null)
      countMap('markerRemoved')
    }
    stopMarkersRef.current = []

    const selectedKey = selectedStop ? stopKey(selectedStop) : focusedRouteStop?.stopId ?? null
    const ordered = selectedStop ? [selectedStop, ...stops.filter((stop) => stopKey(stop) !== selectedKey)] : stops
    const seenIds = new Set<string>()
    const seenCoordinates = new Set<string>()
    const max = markerLimit(level) + (selectedStop ? 1 : 0)
    const normalImage = new maps.MarkerImage('/stop-pin.svg', new maps.Size(28, 34))
    const selectedImage = new maps.MarkerImage('/stop-pin-selected.svg', new maps.Size(34, 40))
    for (const stop of ordered) {
      if (stopMarkersRef.current.length >= max) break
      const key = stopKey(stop)
      const coordinates = `${stop.position.latitude.toFixed(6)}:${stop.position.longitude.toFixed(6)}`
      if (seenIds.has(key) || seenCoordinates.has(coordinates)) continue
      seenIds.add(key)
      seenCoordinates.add(coordinates)
      const marker = new maps.Marker({
        position: new maps.LatLng(stop.position.latitude, stop.position.longitude),
        image: key === selectedKey ? selectedImage : normalImage,
        map,
      })
      const click = () => onStopSelect(stop)
      maps.event.addListener(marker, 'click', click)
      countMap('markerCreated')
      countMap('listenerAdded')
      stopMarkersRef.current.push({ marker, click })
    }
  }, [ready, stops, selectedStop, focusedRouteStop, level, onStopSelect])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    const started = performance.now()
    routesRef.current = routes
    const validKeys = new Set<string>()
    for (const route of routes) {
      if (!route.visible || !route.shape || route.shape.points.length < 2) continue
      validKeys.add(route.key)
      let entry = polylinesRef.current.get(route.key)
      if (entry && (entry.shape !== route.shape || entry.preview !== !!route.preview)) {
        maps.event.removeListener(entry.line, 'click', entry.click)
        maps.event.removeListener(entry.line, 'mouseover', entry.over)
        maps.event.removeListener(entry.line, 'mouseout', entry.out)
        countMap('listenerRemoved', 3)
        entry.line.setMap(null)
        countMap('polylineRemoved')
        polylinesRef.current.delete(route.key)
        entry = undefined
      }
      if (!entry) {
        const path = route.shape.points.map((point) => new maps.LatLng(point.latitude, point.longitude))
        const line = new maps.Polyline({ map, path, strokeWeight: route.preview ? 2 : 3, strokeColor: route.preview ? route.previewColor ?? PREVIEW_ROUTE_COLOR : route.color,
          strokeOpacity: route.preview ? 0.68 : 0.55, strokeStyle: 'solid' })
        countMap('polylineCreated')
        const click = () => routeSelectRef.current(route.key)
        const over = () => line.setOptions({ strokeWeight: route.preview ? 2 : route.key === activeRouteRef.current ? 5 : 4,
          strokeOpacity: route.preview ? 0.82 : 0.95 })
        const out = () => line.setOptions({ strokeWeight: route.preview ? 2 : route.key === activeRouteRef.current ? 4 : 3,
          strokeOpacity: route.preview ? 0.68 : route.key === activeRouteRef.current ? 0.82 : 0.55 })
        maps.event.addListener(line, 'click', click)
        maps.event.addListener(line, 'mouseover', over)
        maps.event.addListener(line, 'mouseout', out)
        countMap('listenerAdded', 3)
        entry = { line, shape: route.shape, preview: !!route.preview, click, over, out }
        polylinesRef.current.set(route.key, entry)
      }
      entry.line.setOptions({ strokeWeight: route.preview ? 2 : route.key === activeRouteKey ? 4 : 3,
        strokeColor: route.preview ? route.previewColor ?? PREVIEW_ROUTE_COLOR : route.color,
        strokeOpacity: route.preview ? 0.68 : route.key === activeRouteKey ? 0.82 : 0.55 })
      entry.line.setZIndex(route.key === activeRouteKey ? 3 : 1)
    }
    for (const [key, entry] of polylinesRef.current) {
      if (validKeys.has(key)) continue
      maps.event.removeListener(entry.line, 'click', entry.click)
      maps.event.removeListener(entry.line, 'mouseover', entry.over)
      maps.event.removeListener(entry.line, 'mouseout', entry.out)
      countMap('listenerRemoved', 3)
      entry.line.setMap(null)
      countMap('polylineRemoved')
      polylinesRef.current.delete(key)
    }
    drawArrows()
    timeMap('routeUpdate', started)
  }, [ready, routes, activeRouteKey, drawArrows])

  useEffect(() => {
    const map = mapRef.current, maps = apiRef.current
    const container = containerRef.current
    if (!ready || !map || !maps || !container) return
    const projection = map.getProjection()
    const canvasRect = container.getBoundingClientRect()
    const blocked: ScreenRect[] = [...(container.parentElement?.parentElement?.querySelectorAll(
      '.direction-chooser, .sidebar.mobile-open') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left - canvasRect.left, top: rect.top - canvasRect.top,
        right: rect.right - canvasRect.left, bottom: rect.bottom - canvasRect.top }
    })
    const guides = pickDirectionGuides(directionOptions, (point) => projection.containerPointFromCoords(
      new maps.LatLng(point.latitude, point.longitude)), container.clientWidth, container.clientHeight,
    userPosition, userPositionAccuracy, blocked)
    const valid = new Set(guides.map((guide) => guide.key))
    for (const guide of guides) {
      let entry = directionMarkersRef.current.get(guide.key)
      if (!entry) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'direction-map-pin'
        button.dataset.directionKey = guide.key
        button.setAttribute('aria-label', `${guide.label} 선택`)
        const arrow = document.createElement('span')
        arrow.className = 'direction-map-arrow'
        arrow.textContent = '➜'
        arrow.setAttribute('aria-hidden', 'true')
        const label = document.createElement('span')
        label.textContent = guide.label
        button.append(arrow, label)
        button.addEventListener('click', () => directionSelectRef.current(guide.key))
        const overlay = new maps.CustomOverlay({ map,
          position: new maps.LatLng(guide.position.latitude, guide.position.longitude),
          content: button, xAnchor: 0.5, yAnchor: 1.15, zIndex: 4 })
        entry = { overlay, button, arrow }
        directionMarkersRef.current.set(guide.key, entry)
        countMap('overlayCreated')
      } else entry.overlay.setPosition(new maps.LatLng(guide.position.latitude, guide.position.longitude))
      entry.arrow.style.transform = `rotate(${guide.angle}deg)`
    }
    for (const [key, entry] of directionMarkersRef.current) {
      if (valid.has(key)) continue
      entry.overlay.setMap(null)
      entry.button.remove()
      countMap('overlayRemoved')
      directionMarkersRef.current.delete(key)
    }
  }, [ready, directionOptions, userPosition, userPositionAccuracy, arrowRevision])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    const validKeys = new Set<string>()
    // Vehicle refreshes update this overlay only; base route paths and arrows stay intact.
    const started = performance.now()
    const iconKeys = new Set<string>()
    const mapContainer = containerRef.current
    const projection = map.getProjection()
    let iconCount = 0
    sectionsRef.current = vehicleSections
    for (const group of groupVehicleSections(vehicleSections)) {
      const section = group[0]
      if (section.path.length < 2) continue
      const groupKey = `${section.routeKey}:${section.stationSequence}`
      validKeys.add(groupKey)
      const active = group.some((member) => member.key === activeVehicleKey) ||
        (focusedSection?.routeKey === section.routeKey && focusedSection.stationSequence === section.stationSequence)
      let entry = vehicleLinesRef.current.get(groupKey)
      if (entry && !samePath(entry.path, section.path)) {
        maps.event.removeListener(entry.line, 'click', entry.click)
        maps.event.removeListener(entry.halo, 'click', entry.click)
        countMap('listenerRemoved', 2)
        entry.line.setMap(null)
        entry.halo.setMap(null)
        countMap('polylineRemoved', 2)
        vehicleLinesRef.current.delete(groupKey)
        entry = undefined
      }
      if (!entry) {
        const path = section.path.map((point) => new maps.LatLng(point.latitude, point.longitude))
        const halo = new maps.Polyline({ map, path, strokeWeight: 11, strokeColor: sectionHaloColor(section.color),
          strokeOpacity: 0.86, strokeStyle: 'solid' })
        const line = new maps.Polyline({ map, path,
          strokeWeight: 8, strokeColor: section.color, strokeOpacity: 0.92, strokeStyle: 'solid' })
        countMap('polylineCreated', 2)
        const click = () => routeSelectRef.current(section.routeKey)
        maps.event.addListener(line, 'click', click)
        maps.event.addListener(halo, 'click', click)
        countMap('listenerAdded', 2)
        entry = { line, halo, path: section.path, click }
        vehicleLinesRef.current.set(groupKey, entry)
      }
      entry.halo.setOptions({ strokeWeight: active ? 13 : 11, strokeColor: sectionHaloColor(section.color) })
      entry.line.setOptions({ strokeWeight: active ? 10 : 8, strokeColor: section.color, strokeOpacity: active ? 1 : 0.92 })
      entry.halo.setZIndex(active ? 6 : 4)
      entry.line.setZIndex(active ? 7 : 5)
      if (level > 5 || !mapContainer || iconCount >= 20) continue
      const point = pathMidpoint(section.path, (position) => projection.containerPointFromCoords(new maps.LatLng(position.latitude, position.longitude)))
      const screen = projection.containerPointFromCoords(new maps.LatLng(point.latitude, point.longitude))
      if (screen.x < 28 || screen.y < 28 || screen.x > mapContainer.clientWidth - 28 || screen.y > mapContainer.clientHeight - 28) continue
      iconCount++
      iconKeys.add(groupKey)
      let icon = sectionIconsRef.current.get(groupKey)
      if (icon && (!samePath(icon.path, section.path) || icon.count !== group.length)) {
        icon.overlay.setMap(null)
        countMap('overlayRemoved')
        sectionIconsRef.current.delete(groupKey)
        icon = undefined
      }
      if (!icon) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'section-bus-icon'
        button.style.setProperty('--route-color', section.color)
        button.setAttribute('aria-label', `확인된 운행 구간 ${group.length}대, GPS 위치 아님`)
        button.title = '정류장 사이 확인된 운행 구간 · GPS 위치 아님'
        button.innerHTML = `<span aria-hidden="true">🚌</span>${group.length > 1 ? `<small>${group.length}</small>` : ''}`
        button.addEventListener('click', () => sectionSelectRef.current(section.routeKey, section.stationSequence))
        const overlay = new maps.CustomOverlay({ map, position: new maps.LatLng(point.latitude, point.longitude), content: button,
          xAnchor: 0.5, yAnchor: 0.5, zIndex: 7 })
        countMap('overlayCreated')
        icon = { overlay, button, path: section.path, count: group.length }
        sectionIconsRef.current.set(groupKey, icon)
      }
      icon.button.classList.toggle('selected', active)
      icon.button.style.setProperty('--route-color', section.color)
    }
    for (const [key, entry] of vehicleLinesRef.current) {
      if (validKeys.has(key)) continue
      maps.event.removeListener(entry.line, 'click', entry.click)
      maps.event.removeListener(entry.halo, 'click', entry.click)
      countMap('listenerRemoved', 2)
      entry.line.setMap(null)
      entry.halo.setMap(null)
      countMap('polylineRemoved', 2)
      vehicleLinesRef.current.delete(key)
    }
    for (const [key, entry] of sectionIconsRef.current) {
      if (iconKeys.has(key)) continue
      entry.overlay.setMap(null)
      countMap('overlayRemoved')
      sectionIconsRef.current.delete(key)
    }
    timeMap('sectionUpdate', started)
    drawArrows()
  }, [ready, vehicleSections, activeVehicleKey, focusedSection, level, arrowRevision, drawArrows])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    for (const entry of routeStopMarkersRef.current) {
      maps.event.removeListener(entry.marker, 'click', entry.click)
      countMap('listenerRemoved')
      entry.marker.setMap(null)
      countMap('markerRemoved')
    }
    routeStopMarkersRef.current = []
    if (level > 5) return
    const active = routes.find((route) => route.key === activeRouteKey && route.visible)
    if (!active) return
    const nearbyIds = new Set(stops.map(stopKey))
    const nearbyPositions = new Set(stops.map((stop) => `${stop.position.latitude.toFixed(6)}:${stop.position.longitude.toFixed(6)}`))
    if (selectedStop) {
      nearbyIds.add(stopKey(selectedStop))
      nearbyPositions.add(`${selectedStop.position.latitude.toFixed(6)}:${selectedStop.position.longitude.toFixed(6)}`)
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="${active.color}" stroke="white" stroke-width="2.5"/></svg>`
    const image = new maps.MarkerImage(`data:image/svg+xml,${encodeURIComponent(svg)}`, new maps.Size(18, 18))
    const selectedImage = new maps.MarkerImage('/stop-pin-selected.svg', new maps.Size(34, 40))
    const visibleStops = active.stops.filter((stop) => {
      const selected = focusedRouteStop?.routeKey === active.key && focusedRouteStop.stopId === transitKey(stop.id) &&
        (focusedRouteStop.sequence === null || focusedRouteStop.sequence === stop.sequence)
      return selected || (!nearbyIds.has(stopKey(stop)) && !nearbyPositions.has(`${stop.position.latitude.toFixed(6)}:${stop.position.longitude.toFixed(6)}`))
    })
    const step = Math.max(1, Math.ceil(visibleStops.length / 25))
    const selectedStops = visibleStops.filter((stop) => focusedRouteStop?.routeKey === active.key && focusedRouteStop.stopId === transitKey(stop.id) &&
      (focusedRouteStop.sequence === null || focusedRouteStop.sequence === stop.sequence))
    const sampled = [...selectedStops, ...visibleStops.filter((_, index) => index % step === 0)]
    const drawn = new Set<string>()
    for (const stop of sampled) {
      if (routeStopMarkersRef.current.length >= 26) break
      const coordinate = `${stop.position.latitude.toFixed(6)}:${stop.position.longitude.toFixed(6)}`
      if (drawn.has(coordinate)) continue
      drawn.add(coordinate)
      const isSelected = selectedStops.includes(stop)
      const marker = new maps.Marker({ position: new maps.LatLng(stop.position.latitude, stop.position.longitude), image: isSelected ? selectedImage : image, map })
      countMap('markerCreated')
      const click = () => onRouteStopSelect(active.key, stop)
      maps.event.addListener(marker, 'click', click)
      countMap('listenerAdded')
      routeStopMarkersRef.current.push({ marker, click })
    }
  }, [ready, routes, activeRouteKey, focusedRouteStop, level, stops, selectedStop, onRouteStopSelect])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !('ResizeObserver' in window)) return
    const observer = new ResizeObserver(() => { mapRef.current?.relayout(); drawArrows(); setArrowRevision((value) => value + 1) })
    observer.observe(container)
    return () => observer.disconnect()
  }, [ready, drawArrows])

  return <div className="map-canvas" ref={containerRef} role="region" aria-label="카카오 지도" />
}
