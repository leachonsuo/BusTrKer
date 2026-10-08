import type { Coordinates, NearbyStopsResult, Stop, StopArrival, StopArrivalsResult, TransitId, TransitProvider } from './domain'
import { cached } from './cache'

const GBIS_BASE = 'https://apis.data.go.kr/6410000'
const REGION = 'gyeonggi'

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
  if (code === '20' || code === '30' || code === '31' || kind === 'SERVICE_KEY_IS_NULL' || kind === 'SERVICE_ACCESS_DENIED_ERROR') {
    return new TransitApiError(502, 'UPSTREAM_AUTH_ERROR', `공공데이터 API 인증이 실패했습니다 (결과코드 ${code ?? '없음'}).`)
  }
  return new TransitApiError(502, 'UPSTREAM_ERROR', `공공데이터 API 요청이 실패했습니다 (결과코드 ${code ?? '없음'}).`)
}

async function requestGbis(api: string, path: string, params: Record<string, string>, serviceKey: string): Promise<GbisReply> {
  const url = new URL(`${GBIS_BASE}${path}`)
  url.search = new URLSearchParams({ format: 'json', serviceKey, ...params }).toString()
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
    if (!response.ok) throw new TransitApiError(502, 'UPSTREAM_HTTP_ERROR', `GBIS HTTP 오류 (${response.status}).`)
    throw new TransitApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'GBIS가 JSON 응답을 반환하지 않았습니다.')
  }
  const upstreamError = gatewayError(raw)
  diagnostic(api, response.status, contentType, raw, upstreamError ? 'gateway-error' : !response.ok ? 'http-status' : undefined)
  if (upstreamError) throw upstreamError
  if (!response.ok) throw new TransitApiError(502, 'UPSTREAM_HTTP_ERROR', `GBIS HTTP 오류 (${response.status}).`)
  return { raw, status: response.status, contentType }
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

export function gbisStopProvider(serviceKey: string): TransitProvider {
  return {
    id: 'gbis',
    supportedRegions: [REGION],
    nearbyStops: (position) => nearbyGbis(position, serviceKey),
    arrivals: (stopId) => {
      if (stopId.provider !== 'gbis' || stopId.regionCode !== REGION) {
        throw new TransitApiError(400, 'PROVIDER_ID_MISMATCH', 'GBIS 정류장 ID가 필요합니다.')
      }
      return arrivalsGbis(stopId.value, serviceKey)
    },
  }
}
