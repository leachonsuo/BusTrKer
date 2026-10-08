import { useEffect, useRef, useState } from 'react'
import { loadKakaoMaps, type KakaoMap, type KakaoMarker, type KakaoMapsApi, type LatLng } from './kakao'
import { stopKey, type Stop } from '../transit/api'

export const GOYANG_CENTER: LatLng = { latitude: 37.6584, longitude: 126.8320 }

export interface MapHandle {
  moveTo(position: LatLng): void
  focusStop(stop: Stop): void
}

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
}

interface MarkerEntry { marker: KakaoMarker; click: () => void }

function markerLimit(level: number): number {
  if (level <= 3) return 35
  if (level === 4) return 28
  if (level === 5) return 18
  if (level === 6) return 10
  return 0
}

export function MapView({ appKey, userPosition, stops, selectedStop, level, onReady, onError, onViewportChange, onStopSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<KakaoMap | null>(null)
  const apiRef = useRef<KakaoMapsApi | null>(null)
  const userMarkerRef = useRef<KakaoMarker | null>(null)
  const stopMarkersRef = useRef<MarkerEntry[]>([])
  const [ready, setReady] = useState(false)

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
      mapRef.current = map
      const emitView = () => {
        const center = map.getCenter()
        onViewportChange({ latitude: center.getLat(), longitude: center.getLng() }, map.getLevel())
      }
      idleHandler = () => {
        window.clearTimeout(idleTimer)
        idleTimer = window.setTimeout(emitView, 320)
      }
      maps.event.addListener(map, 'idle', idleHandler)
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
      })
      emitView()
    }).catch((error: unknown) => {
      if (!cancelled) onError(error instanceof Error ? error.message : '지도를 불러오지 못했습니다.')
    })

    return () => {
      cancelled = true
      window.clearTimeout(idleTimer)
      if (createdMap && mapsApi && idleHandler) mapsApi.event.removeListener(createdMap, 'idle', idleHandler)
      userMarkerRef.current?.setMap(null)
      userMarkerRef.current = null
      for (const entry of stopMarkersRef.current) {
        mapsApi?.event.removeListener(entry.marker, 'click', entry.click)
        entry.marker.setMap(null)
      }
      stopMarkersRef.current = []
      mapRef.current = null
      apiRef.current = null
    }
  }, [appKey, onError, onReady, onViewportChange])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps || !userPosition) return
    userMarkerRef.current?.setMap(null)
    userMarkerRef.current = new maps.Marker({
      position: new maps.LatLng(userPosition.latitude, userPosition.longitude),
      image: new maps.MarkerImage('/user-pin.svg', new maps.Size(28, 28)), map,
    })
    map.setCenter(new maps.LatLng(userPosition.latitude, userPosition.longitude))
    map.setLevel(4)
  }, [ready, userPosition])

  useEffect(() => {
    const map = mapRef.current
    const maps = apiRef.current
    if (!ready || !map || !maps) return
    for (const entry of stopMarkersRef.current) {
      maps.event.removeListener(entry.marker, 'click', entry.click)
      entry.marker.setMap(null)
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
      stopMarkersRef.current.push({ marker, click })
    }
  }, [ready, stops, selectedStop, level, onStopSelect])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !('ResizeObserver' in window)) return
    const observer = new ResizeObserver(() => mapRef.current?.relayout())
    observer.observe(container)
    return () => observer.disconnect()
  }, [ready])

  return <div className="map-canvas" ref={containerRef} role="region" aria-label="카카오 지도" />
}
