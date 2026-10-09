import type { Coordinates, NearbyStopsResult, Route, RouteDetailResult, RouteSearchResult, RouteShapeResult, RouteStop, RouteStopsResult, Stop, StopArrival, StopArrivalsResult, TransitId, TransitProvider, VehiclePosition, VehiclePositionsResult } from './domain'
import { cached } from './cache'
import { recordMetric } from './metrics'

const GBIS_BASE = 'https://apis.data.go.kr/6410000'
const REGION = 'gyeonggi'
let rateLimitedUntil = 0

function rateLimitError(): TransitApiError {
  rateLimitedUntil = Date.now() + 30_000
  return new TransitApiError(429, 'UPSTREAM_RATE_LIMITED', '공공데이터 API 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.')
}

export function resetGbisCooldownForTests(): void { rateLimitedUntil = 0 }

export class TransitApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly stage?: string) {
    super(message)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const result = String(value).trim()
  return result || null
}

function finite(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function nonnegative(value: unknown): number | null {
  const result = finite(value)
  return result !== null && Number.isInteger(result) && result >= 0 ? result : null
}

function rows(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null || value === '') throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 목록 형식이 올바르지 않습니다.', 'list-rows')
  const items = Array.isArray(value) ? value : [value]
  if (!items.every((item) => record(item))) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 목록 형식이 올바르지 않습니다.', 'list-rows')
  return items as Record<string, unknown>[]
}

function id(value: string): TransitId { return { provider: 'gbis', regionCode: REGION, value } }

function payload(raw: unknown, listName: string): Record<string, unknown>[] {
  const outer = record(raw)
  const root = outer && 'response' in outer ? record(outer.response) : outer
  const header = record(root?.msgHeader)
  const body = record(root?.msgBody)
  if (!root) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 응답 구조가 올바르지 않습니다.', 'response-envelope')
  if (!header) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 응답 구조가 올바르지 않습니다.', 'msgHeader')
  const code = text(header.resultCode)
  if (!code || !/^\d+$/.test(code)) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 결과코드 형식이 올바르지 않습니다.', 'result-code')
  if (code === '4' || (listName === 'busArrivalList' && code === '23')) return []
  if (code === '5' || code === '6' || code === '7') throw new TransitApiError(502, 'UPSTREAM_AUTH_ERROR', `GBIS 인증이 실패했습니다 (결과코드 ${code}).`, 'result-code')
  if (code !== '0') throw new TransitApiError(502, 'UPSTREAM_ERROR', `GBIS 요청이 실패했습니다 (결과코드 ${code}).`, 'result-code')
  if (!body) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 응답 본문이 없습니다.', 'msgBody')
  if (!(listName in body)) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 목록 필드가 없습니다.', 'list-field')
  return rows(body[listName])
}

export function parseNearbyStops(raw: unknown): Stop[] {
  const list = payload(raw, 'busStationAroundList')
  const seen = new Set<string>()
  const stops = list.map((item) => {
    const stationId = text(item.stationId)
    const name = text(item.stationName)
    const longitude = finite(item.x)
    const latitude = finite(item.y)
    if (!stationId || !/^\d+$/.test(stationId) || !name || longitude === null || latitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 정류장 필수 항목이 올바르지 않습니다.', 'station-fields')
    }
    return {
      id: id(stationId), name, position: { latitude, longitude },
      mobileNo: text(item.mobileNo), distanceMeters: nonnegative(item.distance),
    }
  }).filter((stop) => {
    if (seen.has(stop.id.value)) return false
    seen.add(stop.id.value)
    return true
  })
  return stops.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity)).slice(0, 50)
}

function visit(item: Record<string, unknown>, index: 1 | 2): { minutesUntilArrival: number | null; stopsAway: number | null } | null {
  const minutesUntilArrival = nonnegative(item[`predictTime${index}`])
  const stopsAway = nonnegative(item[`locationNo${index}`])
  return minutesUntilArrival === null && stopsAway === null ? null : { minutesUntilArrival, stopsAway }
}

function operationStatus(flag: unknown): StopArrival['operationStatus'] {
  if (flag === 'RUN' || flag === 'PASS') return 'running'
  if (flag === 'STOP') return 'ended'
  if (flag === 'WAIT') return 'waiting'
  return 'unknown'
}

export function parseArrivals(raw: unknown, stationId: string): StopArrival[] {
  const list = payload(raw, 'busArrivalList')
  return list.map((item) => {
    const routeId = text(item.routeId)
    const routeName = text(item.routeName)
    if (!routeId || !/^\d+$/.test(routeId) || !routeName) {
      throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 도착정보 필수 항목이 올바르지 않습니다.', 'arrival-fields')
    }
    const responseStationId = text(item.stationId)
    if (responseStationId && responseStationId !== stationId) {
      throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 도착정보의 정류장 ID가 요청과 다릅니다.', 'arrival-station-id')
    }
    return {
      routeId: id(routeId), stopId: id(stationId), routeName,
      destination: text(item.routeDestName), operationStatus: operationStatus(item.flag),
      visits: [visit(item, 1), visit(item, 2)].filter((value): value is NonNullable<typeof value> => value !== null),
    }
  })
}

type GbisReply = { raw: unknown; status: number; contentType: string }

function diagnostic(api: string, status: number | null, contentType: string | null, raw: unknown, failureStage?: string): void {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return
  const outer = record(raw)
  const root = record(outer?.response) ?? outer
  const header = record(root?.msgHeader)
  const body = record(root?.msgBody)
  const gateway = record(outer?.OpenAPI_ServiceResponse)
  const gatewayHeader = record(gateway?.cmmMsgHeader) ?? record(gateway?.comMsgHeader)
  const gatewayMessage = text(gatewayHeader?.errMsg)
  const gbisCode = text(header?.resultCode)
  const gbisErrorType = gbisCode === '4' ? 'NO_RESULTS'
    : gbisCode === '20' ? 'INVALID_POSITION'
    : gbisCode === '23' ? 'NO_ARRIVALS'
    : ['5', '6', '7'].includes(gbisCode ?? '') ? 'AUTH_ERROR'
    : gbisCode && gbisCode !== '0' ? 'UPSTREAM_ERROR' : null
  console.info('GBIS_DIAGNOSTIC', JSON.stringify({
    api, httpStatus: status, contentType, topLevelFields: Object.keys(outer ?? {}),
    resultCode: header?.resultCode ?? gatewayHeader?.returnReasonCode ?? null,
    errorType: gatewayMessage && /^[A-Z][A-Z0-9_]{2,80}$/.test(gatewayMessage) ? gatewayMessage : gbisErrorType,
    bodyFields: Object.keys(body ?? {}), failureStage: failureStage ?? null,
  }))
}

function gatewayError(raw: unknown): TransitApiError | null {
  const gateway = record(record(raw)?.OpenAPI_ServiceResponse)
  const header = record(gateway?.cmmMsgHeader) ?? record(gateway?.comMsgHeader)
  if (!header) return null
  const code = text(header.returnReasonCode)
  const kind = text(header.errMsg)
  if (code === '22' || code === '23' || kind?.startsWith('LIMITED_NUMBER_OF_SERVICE_REQUESTS')) {
    return new TransitApiError(429, 'UPSTREAM_RATE_LIMITED', '공공데이터 API 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.')
  }
  if (code === '20' || code === '30' || code === '31' || kind === 'SERVICE_KEY_IS_NULL' || kind === 'SERVICE_ACCESS_DENIED_ERROR') {
    return new TransitApiError(502, 'UPSTREAM_AUTH_ERROR', `공공데이터 API 인증이 실패했습니다 (결과코드 ${code ?? '없음'}).`)
  }
  return new TransitApiError(502, 'UPSTREAM_ERROR', `공공데이터 API 요청이 실패했습니다 (결과코드 ${code ?? '없음'}).`)
}

async function requestGbis(api: string, path: string, params: Record<string, string>, serviceKey: string): Promise<GbisReply> {
  // A distinct request after a 429 should not immediately hit the same key's quota again.
  if (Date.now() < rateLimitedUntil) throw new TransitApiError(429, 'UPSTREAM_RATE_LIMITED', '공공데이터 API 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.')
  const url = new URL(`${GBIS_BASE}${path}`)
  url.search = new URLSearchParams({ format: 'json', serviceKey, ...params }).toString()
  const started = performance.now()
  try {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
  } catch (error) {
    diagnostic(api, null, null, null, 'network')
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new TransitApiError(504, 'UPSTREAM_TIMEOUT', 'GBIS 응답 시간이 초과되었습니다.')
    }
    throw new TransitApiError(502, 'UPSTREAM_NETWORK_ERROR', 'GBIS에 연결하지 못했습니다.')
  }
  const contentType = response.headers.get('content-type') ?? ''
  let raw: unknown
  try {
    raw = await response.json() as unknown
  } catch {
    diagnostic(api, response.status, contentType, null, 'json-parse')
    if (response.status === 429) throw rateLimitError()
    if (!response.ok) throw new TransitApiError(502, 'UPSTREAM_HTTP_ERROR', `GBIS HTTP 오류 (${response.status}).`)
    throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS가 JSON 응답을 반환하지 않았습니다.')
  }
  const upstreamError = gatewayError(raw)
  diagnostic(api, response.status, contentType, raw, upstreamError ? 'gateway-error' : !response.ok ? 'http-status' : undefined)
  if (upstreamError) {
    if (upstreamError.status === 429) throw rateLimitError()
    throw upstreamError
  }
  if (response.status === 429) throw rateLimitError()
  if (!response.ok) throw new TransitApiError(502, 'UPSTREAM_HTTP_ERROR', `GBIS HTTP 오류 (${response.status}).`)
  return { raw, status: response.status, contentType }
  } catch (error) {
    recordMetric('upstreamError', api)
    throw error
  } finally {
    recordMetric('upstream', api, performance.now() - started)
  }
}

export async function nearbyGbis(position: Coordinates, serviceKey: string): Promise<NearbyStopsResult> {
  const x = position.longitude.toFixed(3)
  const y = position.latitude.toFixed(3)
  return cached(`gbis:nearby:${x}:${y}`, 45_000, async (): Promise<NearbyStopsResult> => {
    const api = 'getBusStationAroundListv2'
    const reply = await requestGbis(api, '/busstationservice/v2/getBusStationAroundListv2', { x, y }, serviceKey)
    try {
      return { stops: parseNearbyStops(reply.raw), queriedAt: new Date().toISOString(), source: 'gbis' }
    } catch (error) {
      diagnostic(api, reply.status, reply.contentType, reply.raw, error instanceof TransitApiError ? error.stage ?? error.code : 'parse')
      throw error
    }
  })
}

export async function arrivalsGbis(stationId: string, serviceKey: string): Promise<StopArrivalsResult> {
  return cached(`gbis:arrivals:${stationId}`, 10_000, async (): Promise<StopArrivalsResult> => {
    const api = 'getBusArrivalListv2'
    const reply = await requestGbis(api, '/busarrivalservice/v2/getBusArrivalListv2', { stationId }, serviceKey)
    try {
      return { arrivals: parseArrivals(reply.raw, stationId), queriedAt: new Date().toISOString(), source: 'gbis' }
    } catch (error) {
      diagnostic(api, reply.status, reply.contentType, reply.raw, error instanceof TransitApiError ? error.stage ?? error.code : 'parse')
      throw error
    }
  })
}

function routeFromItem(item: Record<string, unknown>): Route {
  const routeId = text(item.routeId)
  const name = text(item.routeName)
  const startStopId = text(item.startStationId)
  const endStopId = text(item.endStationId)
  if (!routeId || !/^\d+$/.test(routeId) || !name ||
      (startStopId !== null && !/^\d+$/.test(startStopId)) || (endStopId !== null && !/^\d+$/.test(endStopId))) {
    throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 노선 필수 항목이 올바르지 않습니다.', 'route-fields')
  }
  return { id: id(routeId), name, startName: text(item.startStationName), endName: text(item.endStationName),
    typeName: text(item.routeTypeName), regionName: text(item.regionName),
    startStopId: startStopId ? id(startStopId) : null,
    endStopId: endStopId ? id(endStopId) : null }
}

function routeStopFromItem(item: Record<string, unknown>): RouteStop {
  const stationId = text(item.stationId)
  const name = text(item.stationName)
  const longitude = finite(item.x)
  const latitude = finite(item.y)
  const sequence = nonnegative(item.stationSeq)
  const turn = item.turnYn === 'Y' ? true : item.turnYn === 'N' ? false : null
  if (!stationId || !/^\d+$/.test(stationId) || !name || longitude === null || latitude === null ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || sequence === null || sequence === 0 ||
      (item.turnYn != null && turn === null)) {
    throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 경유 정류장 항목이 올바르지 않습니다.', 'route-stop-fields')
  }
  return { id: id(stationId), name, position: { latitude, longitude }, mobileNo: text(item.mobileNo),
    distanceMeters: null, sequence, turnYn: turn, turnSequence: nonnegative(item.turnSeq) }
}

export function parseRouteSearch(raw: unknown): Route[] {
  const routes = payload(raw, 'busRouteList').map(routeFromItem)
  const seen = new Set<string>()
  return routes.filter((route) => {
    if (seen.has(route.id.value)) return false
    seen.add(route.id.value)
    return true
  })
}

export function parseRouteDetail(raw: unknown, routeId: string): Route | null {
  const list = payload(raw, 'busRouteInfoItem')
  if (list.length === 0) return null
  if (list.length !== 1) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 노선 상세정보 개수가 올바르지 않습니다.', 'route-detail-count')
  const route = routeFromItem(list[0])
  if (route.id.value !== routeId) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 노선 ID가 요청과 다릅니다.', 'route-detail-id')
  return route
}

export function parseRouteShape(raw: unknown, routeId: string): RouteShapeResult['shape'] {
  const list = payload(raw, 'busRouteLineList')
  if (list.length === 0) return null
  const seen = new Set<number>()
  const ordered = list.map((item) => {
    const sequence = nonnegative(item.lineSeq)
    const longitude = finite(item.x)
    const latitude = finite(item.y)
    if (sequence === null || sequence === 0 || seen.has(sequence) || longitude === null || latitude === null ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 노선형상 좌표가 올바르지 않습니다.', 'route-line-fields')
    }
    seen.add(sequence)
    return { sequence, position: { latitude, longitude } }
  }).sort((a, b) => a.sequence - b.sequence)
  const points = ordered.map((item) => item.position).filter((point, index, all) =>
    index === 0 || point.latitude !== all[index - 1].latitude || point.longitude !== all[index - 1].longitude)
  return points.length >= 2 ? { routeId: id(routeId), points } : null
}

export function parseRouteStops(raw: unknown): RouteStop[] {
  const list = payload(raw, 'busRouteStationList')
  const seen = new Set<number>()
  return list.map((item) => {
    const stop = routeStopFromItem(item)
    if (seen.has(stop.sequence)) throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 경유 정류장 순서가 중복되었습니다.', 'route-stop-sequence')
    seen.add(stop.sequence)
    return stop
  }).sort((a, b) => a.sequence - b.sequence)
}

export function parseVehiclePositions(raw: unknown, routeId: string, routeStops: RouteStop[]): VehiclePosition[] {
  const list = payload(raw, 'busLocationList')
  const bySequence = new Map(routeStops.map((stop) => [stop.sequence, stop]))
  const seen = new Set<string>()
  return list.map((item) => {
    const vehicleId = text(item.vehId)
    const responseRouteId = text(item.routeId)
    const stationId = text(item.stationId)
    const stationSequence = nonnegative(item.stationSeq)
    const stateCode = nonnegative(item.stateCd)
    if (!vehicleId || !/^\d+$/.test(vehicleId) || responseRouteId !== routeId ||
        !stationId || !/^\d+$/.test(stationId) || !stationSequence ||
        (stateCode !== 0 && stateCode !== 1 && stateCode !== 2)) {
      throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS 차량 위치 필드가 올바르지 않습니다.', 'vehicle-fields')
    }
    const current = bySequence.get(stationSequence)
    const next = bySequence.get(stationSequence + 1)
    // A valid vehicle remains in the list if GBIS and route-stop revisions disagree,
    // but its section is never drawn in that case.
    const matched = current?.id.value === stationId
    return {
      kind: 'stop-progress' as const, routeId: id(routeId), vehicleId, stationSequence,
      stateCode: stateCode as 0 | 1 | 2, currentStopId: id(stationId),
      nextStopId: matched && stateCode === 2 && current?.turnYn !== true && next ? next.id : null,
      sectionVerified: Boolean(matched && stateCode === 2 && current?.turnYn !== true && next), observedAt: null,
    }
  }).filter((vehicle) => {
    if (seen.has(vehicle.vehicleId)) return false
    seen.add(vehicle.vehicleId)
    return true
  })
}

async function requestAndParse<T>(api: string, path: string, params: Record<string, string>, serviceKey: string, parse: (raw: unknown) => T): Promise<T> {
  const reply = await requestGbis(api, path, params, serviceKey)
  try { return parse(reply.raw) } catch (error) {
    diagnostic(api, reply.status, reply.contentType, reply.raw, error instanceof TransitApiError ? error.stage ?? error.code : 'parse')
    throw error
  }
}

export async function searchGbisRoutes(query: string, serviceKey: string): Promise<RouteSearchResult> {
  const normalized = query.trim()
  return cached(`gbis:route-search:${normalized}`, 300_000, async () => ({
    routes: await requestAndParse('getBusRouteListv2', '/busrouteservice/v2/getBusRouteListv2', { keyword: normalized }, serviceKey, parseRouteSearch),
    queriedAt: new Date().toISOString(), source: 'gbis' as const,
  }))
}

export async function detailGbisRoute(routeId: string, serviceKey: string): Promise<RouteDetailResult> {
  return cached(`gbis:route-detail:${routeId}`, 1_800_000, async () => ({
    route: await requestAndParse('getBusRouteInfoItemv2', '/busrouteservice/v2/getBusRouteInfoItemv2', { routeId }, serviceKey, (raw) => parseRouteDetail(raw, routeId)),
    queriedAt: new Date().toISOString(), source: 'gbis' as const,
  }))
}

export async function shapeGbisRoute(routeId: string, serviceKey: string): Promise<RouteShapeResult> {
  return cached(`gbis:route-shape:${routeId}`, 3_600_000, async () => ({
    shape: await requestAndParse('getBusRouteLineListv2', '/busrouteservice/v2/getBusRouteLineListv2', { routeId }, serviceKey, (raw) => parseRouteShape(raw, routeId)),
    queriedAt: new Date().toISOString(), source: 'gbis' as const,
  }))
}

export async function stopsGbisRoute(routeId: string, serviceKey: string): Promise<RouteStopsResult> {
  return cached(`gbis:route-stops:${routeId}`, 1_800_000, async () => ({
    routeId: id(routeId),
    stops: await requestAndParse('getBusRouteStationListv2', '/busrouteservice/v2/getBusRouteStationListv2', { routeId }, serviceKey, parseRouteStops),
    queriedAt: new Date().toISOString(), source: 'gbis' as const,
  }))
}

export async function vehiclesGbisRoute(routeId: string, serviceKey: string): Promise<VehiclePositionsResult> {
  return cached(`gbis:vehicles:${routeId}`, 20_000, async () => {
    const api = 'getBusLocationListv2'
    const reply = await requestGbis(api, '/buslocationservice/v2/getBusLocationListv2', { routeId }, serviceKey)
    try {
      if (payload(reply.raw, 'busLocationList').length === 0) {
        return { routeId: id(routeId), vehicles: [], queriedAt: new Date().toISOString(), source: 'gbis' as const }
      }
      const routeStops = await stopsGbisRoute(routeId, serviceKey)
      return { routeId: id(routeId), vehicles: parseVehiclePositions(reply.raw, routeId, routeStops.stops),
        queriedAt: new Date().toISOString(), source: 'gbis' as const }
    } catch (error) {
      diagnostic(api, reply.status, reply.contentType, reply.raw, error instanceof TransitApiError ? error.stage ?? error.code : 'parse')
      throw error
    }
  })
}

export function gbisStopProvider(serviceKey: string): TransitProvider {
  return {
    id: 'gbis',
    supportedRegions: [REGION],
    searchRoutes: (query) => searchGbisRoutes(query, serviceKey),
    routeDetail: (routeId) => { assertGbisRouteId(routeId); return detailGbisRoute(routeId.value, serviceKey) },
    routeShape: (routeId) => { assertGbisRouteId(routeId); return shapeGbisRoute(routeId.value, serviceKey) },
    routeStops: (routeId) => { assertGbisRouteId(routeId); return stopsGbisRoute(routeId.value, serviceKey) },
    vehiclePositions: (routeId) => { assertGbisRouteId(routeId); return vehiclesGbisRoute(routeId.value, serviceKey) },
    nearbyStops: (position) => nearbyGbis(position, serviceKey),
    arrivals: (stopId) => {
      if (stopId.provider !== 'gbis' || stopId.regionCode !== REGION) {
        throw new TransitApiError(400, 'PROVIDER_ID_MISMATCH', 'GBIS 정류장 ID가 필요합니다.')
      }
      return arrivalsGbis(stopId.value, serviceKey)
    },
  }
}

function assertGbisRouteId(routeId: TransitId): void {
  if (routeId.provider !== 'gbis' || routeId.regionCode !== REGION || !/^\d{1,20}$/.test(routeId.value)) {
    throw new TransitApiError(400, 'PROVIDER_ID_MISMATCH', 'GBIS 노선 ID가 필요합니다.')
  }
}
