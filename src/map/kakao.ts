export interface LatLng {
  latitude: number
  longitude: number
}

interface KakaoLatLng {
  getLat(): number
  getLng(): number
}

interface KakaoMap {
  setCenter(position: KakaoLatLng): void
  setLevel(level: number): void
  getCenter(): KakaoLatLng
  getLevel(): number
  relayout(): void
}

interface KakaoMarker {
  setMap(map: KakaoMap | null): void
}

interface KakaoMarkerImage {}

interface KakaoMapsApi {
  load(callback: () => void): void
  LatLng: new (latitude: number, longitude: number) => KakaoLatLng
  Size: new (width: number, height: number) => object
  Map: new (element: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap
  MarkerImage: new (src: string, size: object) => KakaoMarkerImage
  Marker: new (options: { position: KakaoLatLng; map: KakaoMap; image?: KakaoMarkerImage }) => KakaoMarker
  event: {
    addListener(target: KakaoMap | KakaoMarker, type: string, handler: () => void): void
    removeListener(target: KakaoMap | KakaoMarker, type: string, handler: () => void): void
  }
}

declare global {
  interface Window {
    kakao?: { maps: KakaoMapsApi }
  }
}

let sdkPromise: Promise<KakaoMapsApi> | undefined

export function loadKakaoMaps(appKey: string): Promise<KakaoMapsApi> {
  if (sdkPromise) return sdkPromise

  const loading = new Promise<KakaoMapsApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`
    script.async = true
    script.onload = () => {
      if (!window.kakao?.maps) {
        reject(new Error('카카오 지도 SDK를 초기화하지 못했습니다.'))
        return
      }
      window.kakao.maps.load(() => resolve(window.kakao!.maps))
    }
    script.onerror = () => reject(new Error('카카오 지도 SDK를 불러오지 못했습니다. 키와 등록 도메인을 확인해 주세요.'))
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    sdkPromise = undefined
    throw error
  })

  sdkPromise = loading
  return loading
}

export type { KakaoMap, KakaoMarker, KakaoMapsApi }
