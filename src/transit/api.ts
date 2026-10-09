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
export interface Route { id: TransitId; name: string; startName: string | null; endName: string | null; typeName: string | null; regionName: string | null; startStopId: TransitId | null; endStopId: TransitId | null }
export interface RouteStop extends Stop { sequence: number; turnYn: boolean | null; turnSequence: number | null }
export interface RouteShape { routeId: TransitId; points: LatLng[] }
export interface RouteSearchResult { routes: Route[]; queriedAt: string; source: ProviderId }
export interface RouteDetailResult { route: Route | null; queriedAt: string; source: ProviderId }
export interface RouteShapeResult { shape: RouteShape | null; queriedAt: string; source: ProviderId }
export interface RouteStopsResult { routeId: TransitId; stops: RouteStop[]; queriedAt: string; source: ProviderId }
export interface VehiclePosition {
  kind: 'stop-progress'
  routeId: TransitId
  vehicleId: string
  stationSequence: number
  stateCode: 0 | 1 | 2
  currentStopId: TransitId
  nextStopId: TransitId | null
  sectionVerified: boolean
  observedAt: null
}
export interface VehiclePositionsResult { routeId: TransitId; vehicles: VehiclePosition[]; queriedAt: string; source: ProviderId }

export function transitKey(id: TransitId): string { return `${id.provider}:${id.regionCode}:${id.value}` }

export function stopKey(stop: Stop): string {
  return transitKey(stop.id)
}

export class TransitRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message) }
}

async function readJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new TransitRequestError(0, 'NETWORK_ERROR', '서버에 연결하지 못했습니다. Firebase 에뮬레이터가 실행 중인지 확인해 주세요.')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : `서버 오류 (${response.status})`
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'HTTP_ERROR'
    throw new TransitRequestError(response.status, code, message)
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

function validPoint(value: unknown): value is LatLng {
  const point = object(value)
  return !!point && typeof point.latitude === 'number' && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === 'number' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
}

function nullableString(value: unknown): boolean { return value === null || typeof value === 'string' }

function validRoute(value: unknown): value is Route {
  const route = object(value)
  return !!route && validId(route.id) && typeof route.name === 'string' &&
    nullableString(route.startName) && nullableString(route.endName) && nullableString(route.typeName) && nullableString(route.regionName) &&
    (route.startStopId === null || validId(route.startStopId)) && (route.endStopId === null || validId(route.endStopId))
}

function validRouteStop(value: unknown): value is RouteStop {
  const stop = object(value)
  return validStop(value) && !!stop && Number.isInteger(stop.sequence) && Number(stop.sequence) > 0 &&
    (stop.turnYn === null || typeof stop.turnYn === 'boolean') && (stop.turnSequence === null || Number.isInteger(stop.turnSequence))
}

function validVehicle(value: unknown, routeId: TransitId): value is VehiclePosition {
  const row = object(value)
  return !!row && row.kind === 'stop-progress' && validId(row.routeId) && transitKey(row.routeId) === transitKey(routeId) &&
    typeof row.vehicleId === 'string' && /^\d+$/.test(row.vehicleId) && Number.isInteger(row.stationSequence) && Number(row.stationSequence) > 0 &&
    (row.stateCode === 0 || row.stateCode === 1 || row.stateCode === 2) && validId(row.currentStopId) &&
    (row.nextStopId === null || validId(row.nextStopId)) && typeof row.sectionVerified === 'boolean' && row.observedAt === null
}

export async function getVehiclePositions(routeId: TransitId, signal: AbortSignal): Promise<VehiclePositionsResult> {
  const body = object(await readJson(`/api/routes/${encodeURIComponent(routeId.value)}/vehicles`, signal))
  if (!body || !validId(body.routeId) || transitKey(body.routeId) !== transitKey(routeId) ||
      !Array.isArray(body.vehicles) || !body.vehicles.every((item) => validVehicle(item, routeId)) ||
      typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('차량 위치 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as VehiclePositionsResult
}

export async function searchRoutes(query: string, signal: AbortSignal): Promise<RouteSearchResult> {
  const body = object(await readJson(`/api/routes/search?q=${encodeURIComponent(query)}`, signal))
  if (!body || !Array.isArray(body.routes) || !body.routes.every(validRoute) || typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('노선 검색 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as RouteSearchResult
}

export async function getRouteDetail(routeId: TransitId, signal: AbortSignal): Promise<RouteDetailResult> {
  const body = object(await readJson(`/api/routes/${encodeURIComponent(routeId.value)}`, signal))
  if (!body || (body.route !== null && (!validRoute(body.route) || transitKey(body.route.id) !== transitKey(routeId))) || typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('노선 상세 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as RouteDetailResult
}

export async function getRouteShape(routeId: TransitId, signal: AbortSignal): Promise<RouteShapeResult> {
  const body = object(await readJson(`/api/routes/${encodeURIComponent(routeId.value)}/shape`, signal))
  const shape = object(body?.shape)
  if (!body || (body.shape !== null && (!shape || !validId(shape.routeId) || transitKey(shape.routeId) !== transitKey(routeId) ||
      !Array.isArray(shape.points) || shape.points.length < 2 || !shape.points.every(validPoint))) ||
      typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('노선 경로 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as RouteShapeResult
}

export async function getRouteStops(routeId: TransitId, signal: AbortSignal): Promise<RouteStopsResult> {
  const body = object(await readJson(`/api/routes/${encodeURIComponent(routeId.value)}/stops`, signal))
  if (!body || !validId(body.routeId) || transitKey(body.routeId) !== transitKey(routeId) ||
      !Array.isArray(body.stops) || !body.stops.every(validRouteStop) || typeof body.queriedAt !== 'string' || !validProvider(body.source)) {
    throw new Error('경유 정류장 응답 형식이 올바르지 않습니다.')
  }
  return body as unknown as RouteStopsResult
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
