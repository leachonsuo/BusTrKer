import { useCallback, useEffect, useRef, useState } from 'react'
import { loadKakaoMaps, type KakaoCustomOverlay, type KakaoMap, type KakaoMarker, type KakaoMapsApi, type KakaoPolyline, type LatLng } from './kakao'
import { stopKey, type RouteShape, type RouteStop, type Stop } from '../transit/api'
import { routeArrows } from './routeArrows'
import { groupVehicleSections } from '../transit/routeSegments'
import { countMap, timeMap } from './mapDiagnostics'

const GOYANG_CENTER: LatLng = { latitude: 37.6584, longitude: 126.8320 }

export interface MapHandle {
  moveTo(position: LatLng): void
  focusStop(stop: Stop): void
  fitRoute(shape: RouteShape): void
  fitRoutes(shapes: RouteShape[]): void
  focusSection(points: LatLng[]): void
}

export interface MapRoute { key: string; color: string; strokeWeight: number; visible: boolean; shape: RouteShape | null; stops: RouteStop[] }
export interface MapVehicleSection { key: string; routeKey: string; stationSequence: number; color: string; path: LatLng[] }

interface Props {
  appKey: string
  userPosition: LatLng | null
  stops: Stop[]
  selectedStop: Stop | null
  level: number
  onReady(handle: MapHandle): void
  onError(message: string): void
  onViewportChange(center: LatLng, level: number): void
  onStopSelect(stop: Stop): void
  onRouteSelect(key: string): void
  routes: MapRoute[]
  activeRouteKey: string | null
  vehicleSections: MapVehicleSection[]
  activeVehicleKey: string | null
}

interface MarkerEntry { marker: KakaoMarker; click: () => void }
interface RouteLineEntry { line: KakaoPolyline; shape: RouteShape; click: () => void; over: () => void; out: () => void }
interface SectionLineEntry { line: KakaoPolyline; path: LatLng[]; count: KakaoCustomOverlay | null; countSize: number; click: () => void }
interface SectionArrowEntry { arrows: Map<string, RouteArrowEntry>; path: LatLng[]; active: boolean; level: number; revision: number }
interface RouteArrowEntry { overlay: KakaoCustomOverlay; content: HTMLDivElement }

function samePath(a: LatLng[], b: LatLng[]): boolean {
  return a === b || (a.length === b.length && a.every((point, index) =>
    point.latitude === b[index].latitude && point.longitude === b[index].longitude))
}

function markerLimit(level: number): number {
  if (level <= 3) return 35
  if (level === 4) return 28
  if (level === 5) return 18
  if (level === 6) return 10
  return 0
}

export function MapView({ appKey, userPosition, stops, selectedStop, level, onReady, onError, onViewportChange, onStopSelect, onRouteSelect, routes, activeRouteKey, vehicleSections, activeVehicleKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<KakaoMap | null>(null)
  const apiRef = useRef<KakaoMapsApi | null>(null)
  const userMarkerRef = useRef<KakaoMarker | null>(null)
  const stopMarkersRef = useRef<MarkerEntry[]>([])
  const routeStopMarkersRef = useRef<MarkerEntry[]>([])
  const polylinesRef = useRef(new Map<string, RouteLineEntry>())
  const vehicleLinesRef = useRef(new Map<string, SectionLineEntry>())
  const vehicleArrowsRef = useRef(new Map<string, SectionArrowEntry>())
  const arrowsRef = useRef(new Map<string, RouteArrowEntry>())
  const routesRef = useRef<MapRoute[]>([])
  const activeRouteRef = useRef(activeRouteKey)
  const routeSelectRef = useRef(onRouteSelect)
  activeRouteRef.current = activeRouteKey
  routeSelectRef.current = onRouteSelect
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
    const spacing = zoom <= 3 ? 75 : zoom <= 5 ? 112 : zoom <= 7 ? 155 : 210
    const visible = routesRef.current.filter((route) => route.visible && route.shape)
    const perRouteLimit = Math.max(8, Math.floor(65 / Math.max(visible.length, 1)))
    const currentKeys = new Set<string>()
    for (const route of visible) {
      const points = route.shape!.points
      const samples = routeArrows(points, (point) => projection.containerPointFromCoords(new maps.LatLng(point.latitude, point.longitude)),
        container.clientWidth, container.clientHeight, spacing, perRouteLimit)
      for (const sample of samples) {
        const key = `${route.key}:${sample.position.latitude.toFixed(7)}:${sample.position.longitude.toFixed(7)}`
        currentKeys.add(key)
        const existing = arrowsRef.current.get(key)
        if (existing) {
          existing.content.className = `route-direction-arrow${route.key === activeRouteRef.current ? ' is-active' : ''}`
          continue
        }
        const content = document.createElement('div')
        content.className = `route-direction-arrow${route.key === activeRouteRef.current ? ' is-active' : ''}`
        content.dataset.routeKey = route.key
        content.style.color = route.color
        content.style.transform = `rotate(${sample.angle}deg)`
        content.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><path d="M3 11h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
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
        countMap('listenerRemoved')
        entry.line.setMap(null)
        countMap('polylineRemoved')
        if (entry.count) { entry.count.setMap(null); countMap('overlayRemoved') }
      }
      vehicleLinesRef.current.clear()
      for (const entry of vehicleArrowsRef.current.values()) for (const arrow of entry.arrows.values()) { arrow.overlay.setMap(null); countMap('overlayRemoved') }
      vehicleArrowsRef.current.clear()
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

    const selectedKey = selectedStop ? stopKey(selectedStop) : null
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
  }, [ready, stops, selectedStop, level, onStopSelect])

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
      if (entry && entry.shape !== route.shape) {
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
        const line = new maps.Polyline({ map, path, strokeWeight: 4, strokeColor: route.color, strokeOpacity: 0.6, strokeStyle: 'solid' })
        countMap('polylineCreated')
        const click = () => routeSelectRef.current(route.key)
        const over = () => line.setOptions({ strokeWeight: route.key === activeRouteRef.current ? 7 : 6, strokeOpacity: 1 })
        const out = () => line.setOptions({ strokeWeight: route.key === activeRouteRef.current ? 6 : 4, strokeOpacity: route.key === activeRouteRef.current ? 0.95 : 0.6 })
        maps.event.addListener(line, 'click', click)
        maps.event.addListener(line, 'mouseover', over)
        maps.event.addListener(line, 'mouseout', out)
        countMap('listenerAdded', 3)
        entry = { line, shape: route.shape, click, over, out }
        polylinesRef.current.set(route.key, entry)
      }
      entry.line.setOptions({ strokeWeight: route.key === activeRouteKey ? 6 : 4, strokeColor: route.color,
        strokeOpacity: route.key === activeRouteKey ? 0.95 : 0.6 })
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
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    const validKeys = new Set<string>()
    // Vehicle refreshes update this overlay only; base route paths and arrows stay intact.
    const started = performance.now()
    for (const group of groupVehicleSections(vehicleSections)) {
      const section = group[0]
      if (section.path.length < 2) continue
      const groupKey = `${section.routeKey}:${section.stationSequence}`
      validKeys.add(groupKey)
      const active = group.some((member) => member.key === activeVehicleKey)
      let entry = vehicleLinesRef.current.get(groupKey)
      if (entry && !samePath(entry.path, section.path)) {
        maps.event.removeListener(entry.line, 'click', entry.click)
        countMap('listenerRemoved')
        entry.line.setMap(null)
        countMap('polylineRemoved')
        if (entry.count) { entry.count.setMap(null); countMap('overlayRemoved') }
        vehicleLinesRef.current.delete(groupKey)
        entry = undefined
      }
      if (!entry) {
        const line = new maps.Polyline({ map, path: section.path.map((point) => new maps.LatLng(point.latitude, point.longitude)),
          strokeWeight: 9, strokeColor: section.color, strokeOpacity: 0.9, strokeStyle: 'solid' })
        countMap('polylineCreated')
        const click = () => routeSelectRef.current(section.routeKey)
        maps.event.addListener(line, 'click', click)
        countMap('listenerAdded')
        entry = { line, path: section.path, count: null, countSize: 0, click }
        vehicleLinesRef.current.set(groupKey, entry)
      }
      entry.line.setOptions({ strokeWeight: active ? 12 : 9, strokeColor: section.color, strokeOpacity: active ? 1 : 0.92 })
      entry.line.setZIndex(active ? 6 : 4)
      if (entry.countSize !== group.length) {
        if (entry.count) { entry.count.setMap(null); countMap('overlayRemoved') }
        entry.count = null
      }
      if (group.length > 1 && !entry.count) {
        const point = section.path[Math.floor(section.path.length / 2)]
        const badge = document.createElement('div')
        badge.className = 'vehicle-section-count'
        badge.textContent = `${group.length}대 · 구간 기준`
        badge.style.setProperty('--route-color', section.color)
        entry.count = new maps.CustomOverlay({ map, position: new maps.LatLng(point.latitude, point.longitude),
          content: badge, xAnchor: 0.5, yAnchor: 1.5, zIndex: 7 })
        countMap('overlayCreated')
      }
      entry.countSize = group.length
      const previousArrows = vehicleArrowsRef.current.get(groupKey)
      if (previousArrows && samePath(previousArrows.path, section.path) && previousArrows.active === active &&
          previousArrows.level === level && previousArrows.revision === arrowRevision) continue
      const arrows = previousArrows?.arrows ?? new Map<string, RouteArrowEntry>()
      const arrowKeys = new Set<string>()
      const projection = map.getProjection()
      const container = containerRef.current
      if (!container) continue
      const samples = routeArrows(section.path,
        (point) => projection.containerPointFromCoords(new maps.LatLng(point.latitude, point.longitude)),
        container.clientWidth, container.clientHeight, level <= 4 ? 90 : 130, 4)
      for (const sample of samples) {
        const key = `${sample.position.latitude.toFixed(7)}:${sample.position.longitude.toFixed(7)}`
        arrowKeys.add(key)
        const existing = arrows.get(key)
        if (existing) {
          existing.content.className = `vehicle-direction-arrow${active ? ' selected' : ''}`
          continue
        }
        const content = document.createElement('div')
        content.className = `vehicle-direction-arrow${active ? ' selected' : ''}`
        content.style.color = section.color
        content.style.transform = `rotate(${sample.angle}deg)`
        content.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><path d="M3 11h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        const overlay = new maps.CustomOverlay({ map, position: new maps.LatLng(sample.position.latitude, sample.position.longitude), content, xAnchor: 0.5, yAnchor: 0.5, zIndex: 5 })
        countMap('overlayCreated')
        arrows.set(key, { overlay, content })
      }
      for (const [key, arrow] of arrows) {
        if (arrowKeys.has(key)) continue
        arrow.overlay.setMap(null)
        countMap('overlayRemoved')
        arrows.delete(key)
      }
      vehicleArrowsRef.current.set(groupKey, { arrows, path: section.path, active, level, revision: arrowRevision })
    }
    for (const [key, entry] of vehicleLinesRef.current) {
      if (validKeys.has(key)) continue
      maps.event.removeListener(entry.line, 'click', entry.click)
      countMap('listenerRemoved')
      entry.line.setMap(null)
      countMap('polylineRemoved')
      if (entry.count) { entry.count.setMap(null); countMap('overlayRemoved') }
      vehicleLinesRef.current.delete(key)
    }
    for (const [key, entry] of vehicleArrowsRef.current) {
      if (validKeys.has(key)) continue
      for (const arrow of entry.arrows.values()) { arrow.overlay.setMap(null); countMap('overlayRemoved') }
      vehicleArrowsRef.current.delete(key)
    }
    timeMap('sectionUpdate', started)
  }, [ready, vehicleSections, activeVehicleKey, level, arrowRevision])

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
    if (level > 4) return
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
    const visibleStops = active.stops.filter((stop) => !nearbyIds.has(stopKey(stop)) && !nearbyPositions.has(`${stop.position.latitude.toFixed(6)}:${stop.position.longitude.toFixed(6)}`))
    const step = Math.max(1, Math.ceil(visibleStops.length / 25))
    for (let index = 0; index < visibleStops.length; index += step) {
      const stop = visibleStops[index]
      const marker = new maps.Marker({ position: new maps.LatLng(stop.position.latitude, stop.position.longitude), image, map })
      countMap('markerCreated')
      const click = () => onStopSelect(stop)
      maps.event.addListener(marker, 'click', click)
      countMap('listenerAdded')
      routeStopMarkersRef.current.push({ marker, click })
    }
  }, [ready, routes, activeRouteKey, level, stops, selectedStop, onStopSelect])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !('ResizeObserver' in window)) return
    const observer = new ResizeObserver(() => { mapRef.current?.relayout(); drawArrows(); setArrowRevision((value) => value + 1) })
    observer.observe(container)
    return () => observer.disconnect()
  }, [ready, drawArrows])

  return <div className="map-canvas" ref={containerRef} role="region" aria-label="카카오 지도" />
}
