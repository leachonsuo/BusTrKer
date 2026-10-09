// Tests the official documentation's sample identifiers only; does not map them to Goyang or GBIS.
const fs = require('node:fs')
const path = require('node:path')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8'))?.[1]?.trim()
if (!key) { process.stderr.write('Local service key unavailable\n'); process.exit(1) }
async function main() {
  const url = new URL('https://apis.data.go.kr/1613000/BusLcInfoInqireService/getRouteAcctoBusLcList')
  url.search = new URLSearchParams({ serviceKey: key, _type: 'json', cityCode: '25', routeId: 'DJB30300052', pageNo: '1', numOfRows: '1' }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  let body
  try { body = await response.json() } catch { body = null }
  const gateway = body?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? body?.OpenAPI_ServiceResponse?.comMsgHeader
  const root = body?.response ?? body
  const item = root?.body?.items?.item
  const rows = Array.isArray(item) ? item : item && typeof item === 'object' ? [item] : []
  process.stdout.write(JSON.stringify({ api: 'getRouteAcctoBusLcList', sampleOnly: true,
    httpStatus: response.status, contentType: response.headers.get('content-type'), format: body ? 'json' : 'non-json',
    topLevelFields: body && typeof body === 'object' ? Object.keys(body) : [],
    resultCode: root?.header?.resultCode ?? gateway?.returnReasonCode ?? null,
    gatewayErrorType: /^[A-Z][A-Z0-9_]{2,80}$/.test(String(gateway?.errMsg ?? '')) ? gateway.errMsg : null,
    totalCount: root?.body?.totalCount ?? null, rowCount: rows.length, rowFields: rows[0] ? Object.keys(rows[0]) : [] }) + '\n')
}
main().catch(() => { process.stderr.write('TAGO access check failed at network or timeout stage\n'); process.exitCode = 1 })
