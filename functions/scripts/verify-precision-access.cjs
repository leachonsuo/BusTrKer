// One bounded credential check. Outputs metadata only, never key, URL, rows, or response body.
const fs = require('node:fs')
const path = require('node:path')
const value = fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(value)?.[1]?.trim()
if (!key) { process.stderr.write('Local service key unavailable\n'); process.exit(1) }
async function main() {
  const endpoint = process.argv[2] ?? 'mst_info'
  const region = process.argv[3]
  const routeNo = process.argv[4]
  if (!['mst_info', 'rtm_loc_info'].includes(endpoint) || (region && !/^\d{10}$/.test(region))) throw new Error('Invalid documented endpoint or region code')
  const url = new URL(`https://apis.data.go.kr/B551982/rte/${endpoint}`)
  url.search = new URLSearchParams({ serviceKey: key, pageNo: '1', numOfRows: routeNo ? '100' : '5', type: 'json', ...(region ? { stdgCd: region } : {}) }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  const contentType = response.headers.get('content-type')
  const raw = await response.text()
  let body
  try { body = JSON.parse(raw) } catch { body = null }
  const root = body?.response ?? body
  const gateway = body?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? body?.OpenAPI_ServiceResponse?.comMsgHeader
  const items = root?.body?.items?.item
  const rows = Array.isArray(items) ? items : items && typeof items === 'object' ? [items] : []
  const gpsRows = endpoint === 'rtm_loc_info' ? rows : []
  const ageSeconds = gpsRows.map((row) => {
    const timestamp = String(row.gthrDt ?? '')
    const epoch = Date.parse(timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + '+09:00')
    return Number.isFinite(epoch) ? Math.round((Date.now() - epoch) / 1000) : null
  }).filter((age) => age !== null)
  process.stdout.write(JSON.stringify({ api: endpoint, requestedRegionCode: region ?? null, httpStatus: response.status, contentType,
    format: body ? 'json' : 'non-json', topLevelFields: body && typeof body === 'object' ? Object.keys(body) : [],
    resultCode: root?.header?.resultCode ?? root?.msgHeader?.resultCode ?? gateway?.returnReasonCode ?? null,
    gatewayErrorType: /^[A-Z][A-Z0-9_]{2,80}$/.test(String(gateway?.errMsg ?? '')) ? gateway.errMsg : null,
    bodyFields: root?.body && typeof root.body === 'object' ? Object.keys(root.body) : [],
    totalCount: root?.body?.totalCount ?? null, rowCount: rows.length,
    regionNames: [...new Set(rows.map((row) => row.lclgvNm).filter((name) => typeof name === 'string'))],
    rowFields: rows[0] ? Object.keys(rows[0]) : [],
    matchingRoutes: routeNo && endpoint === 'mst_info' ? rows.filter((row) => String(row.rteNo) === routeNo).map((row) => ({ rteId: row.rteId, rteNo: row.rteNo })) : undefined,
    validGpsRows: gpsRows.filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lot)) &&
      Math.abs(Number(row.lat)) <= 90 && Math.abs(Number(row.lot)) <= 180 && String(row.lat).trim() && String(row.lot).trim()).length,
    vehicleNumberRows: gpsRows.filter((row) => String(row.vhclNo ?? '').trim()).length,
    parseableCollectionTimes: ageSeconds.length,
    conditionalKstFreshWithinTwoMinutes: ageSeconds.filter((age) => age >= 0 && age <= 120).length,
    collectionAgeSecondsRangeIfKst: ageSeconds.length ? [Math.min(...ageSeconds), Math.max(...ageSeconds)] : null }) + '\n')
}
main().catch(() => { process.stderr.write('Precision access check failed at network or timeout stage\n'); process.exitCode = 1 })
