// Local-only response-shape inspector. Never prints the key, URL, or body.
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const line = readFileSync(resolve(__dirname, '../.secret.local'), 'utf8')
  .split(/\r?\n/).find((entry) => entry.startsWith('PUBLIC_DATA_SERVICE_KEY='))
const serviceKey = line?.slice('PUBLIC_DATA_SERVICE_KEY='.length).trim()
if (!serviceKey) {
  process.stdout.write('PUBLIC_DATA_SERVICE_KEY is not configured locally.\n')
  process.exitCode = 1
} else {
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const keys = (value) => isRecord(value) ? Object.keys(value) : []
  const inspect = async (api, path, params, key) => {
    const url = new URL(`https://apis.data.go.kr/6410000${path}`)
    url.search = new URLSearchParams({ serviceKey: key, format: 'json', ...params }).toString()
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
      const contentType = response.headers.get('content-type') || ''
      const raw = await response.text()
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = null }
      const envelope = isRecord(parsed?.response) ? parsed.response : parsed
      const header = envelope?.msgHeader || envelope?.header
      const body = envelope?.msgBody || envelope?.body
      const list = body?.busStationAroundList ?? body?.busStationList ?? body?.busArrivalList
      const gateway = parsed?.OpenAPI_ServiceResponse
      const gatewayHeader = gateway?.cmmMsgHeader ?? gateway?.comMsgHeader
      const message = String(header?.resultMsg ?? header?.resultMessage ?? '')
      const errorType = /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : null
      process.stdout.write(JSON.stringify({
        api, httpStatus: response.status, contentType, format: parsed === null ? 'non-json' : 'json',
        topLevelFields: keys(parsed), envelopeFields: keys(envelope), headerFields: keys(header),
        resultCode: header?.resultCode ?? null, resultCodeType: typeof header?.resultCode,
        errorType,
        bodyFields: keys(body), listType: Array.isArray(list) ? 'array' : isRecord(list) ? 'object' : typeof list,
        listLength: Array.isArray(list) ? list.length : isRecord(list) ? 1 : null,
        rowFields: keys(Array.isArray(list) ? list[0] : list),
        gatewayFields: keys(gateway), gatewayHeaderFields: keys(gatewayHeader),
        gatewayCode: gatewayHeader?.returnReasonCode ?? null,
        gatewayErrorType: /^[A-Z][A-Z0-9_]{2,80}$/.test(String(gatewayHeader?.errMsg ?? '')) ? gatewayHeader.errMsg : null,
      }) + '\n')
      return parsed
    } catch {
      process.stdout.write(JSON.stringify({ api, failureStage: 'network-or-timeout' }) + '\n')
    }
  }
  const main = async () => {
    const nearby = await inspect('getBusStationAroundListv2', '/busstationservice/v2/getBusStationAroundListv2', { x: '126.8320', y: '37.6584' }, serviceKey)
    const first = nearby?.response?.msgBody?.busStationAroundList?.[0]
    if (first?.stationId) await inspect('getBusArrivalListv2', '/busarrivalservice/v2/getBusArrivalListv2', { stationId: String(first.stationId) }, serviceKey)
    await inspect('getBusStationAroundListv2-no-data', '/busstationservice/v2/getBusStationAroundListv2', { x: '0', y: '0' }, serviceKey)
    await inspect('getBusStationAroundListv2-invalid-key', '/busstationservice/v2/getBusStationAroundListv2', { x: '126.8320', y: '37.6584' }, 'invalid-key')
  }
  main().catch(() => { process.stdout.write('inspection-failed\n'); process.exitCode = 1 })
}
