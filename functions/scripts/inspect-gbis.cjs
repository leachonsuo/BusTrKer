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
      const list = body?.busStationAroundList ?? body?.busStationList ?? body?.busArrivalList ?? body?.busRouteList ?? body?.busRouteLineList ?? body?.busRouteStationList ?? body?.busRouteInfoItem ?? body?.busLocationList
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
    const routes = await inspect('getBusRouteListv2', '/busrouteservice/v2/getBusRouteListv2', { keyword: '11' }, serviceKey)
    const routeList = routes?.response?.msgBody?.busRouteList
    const routeRows = Array.isArray(routeList) ? routeList : routeList ? [routeList] : []
    const route = routeRows.find((item) => String(item.regionName ?? '').includes('고양')) ?? routeRows[0]
    if (route?.routeId) {
      const routeId = String(route.routeId)
      await inspect('getBusRouteInfoItemv2', '/busrouteservice/v2/getBusRouteInfoItemv2', { routeId }, serviceKey)
      const lineResponse = await inspect('getBusRouteLineListv2', '/busrouteservice/v2/getBusRouteLineListv2', { routeId }, serviceKey)
      const stationResponse = await inspect('getBusRouteStationListv2', '/busrouteservice/v2/getBusRouteStationListv2', { routeId }, serviceKey)
      const line = lineResponse?.response?.msgBody?.busRouteLineList
      const stations = stationResponse?.response?.msgBody?.busRouteStationList
      if (Array.isArray(line) && Array.isArray(stations)) {
        const seqs = line.map((item) => Number(item.lineSeq))
        const stationSeqs = stations.map((item) => Number(item.stationSeq))
        const orderedLine = [...line].sort((a, b) => Number(a.lineSeq) - Number(b.lineSeq))
        const orderedStations = [...stations].sort((a, b) => Number(a.stationSeq) - Number(b.stationSeq))
        const distanceMeters = (a, b) => {
          const latitude = (Number(a.y) + Number(b.y)) / 2 * Math.PI / 180
          return Math.round(Math.hypot((Number(a.x) - Number(b.x)) * Math.cos(latitude) * 111320, (Number(a.y) - Number(b.y)) * 111320))
        }
        process.stdout.write(JSON.stringify({ api: 'route-geometry-check', pointCount: line.length,
          invalidCoordinates: line.filter((item) => !Number.isFinite(Number(item.x)) || !Number.isFinite(Number(item.y)) || Math.abs(Number(item.x)) > 180 || Math.abs(Number(item.y)) > 90).length,
          duplicateLineSeq: seqs.length - new Set(seqs).size,
          lineSeqAscending: seqs.every((value, index) => index === 0 || value >= seqs[index - 1]),
          stationSeqAscending: stationSeqs.every((value, index) => index === 0 || value >= stationSeqs[index - 1]),
          turnYnValues: [...new Set(stations.map((item) => String(item.turnYn)))].filter((value) => /^[A-Z]{1,4}$/.test(value)),
          firstPointToFirstStopMeters: distanceMeters(orderedLine[0], orderedStations[0]),
          lastPointToLastStopMeters: distanceMeters(orderedLine[orderedLine.length - 1], orderedStations[orderedStations.length - 1]),
        }) + '\n')
      }
    }
  }
  main().catch(() => { process.stdout.write('inspection-failed\n'); process.exitCode = 1 })
}
