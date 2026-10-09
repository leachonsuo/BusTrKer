// TAGO city -> route -> location access audit. Prints public route IDs and aggregate fields only.
const fs = require('node:fs')
const path = require('node:path')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8'))?.[1]?.trim()
if (!key) { process.stderr.write('Local service key unavailable\n'); process.exit(1) }
const rows = (value) => value == null ? [] : Array.isArray(value) ? value : [value]

async function call(service, operation, params = {}) {
  const url = new URL(`https://apis.data.go.kr/1613000/${service}/${operation}`)
  url.search = new URLSearchParams({ serviceKey: key, _type: 'json', pageNo: '1', numOfRows: '300', ...params }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
  let body
  try { body = await response.json() } catch { throw new Error(`${operation}: non-JSON HTTP ${response.status}`) }
  const root = body?.response ?? body
  const gateway = body?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? body?.OpenAPI_ServiceResponse?.comMsgHeader
  const code = String(root?.header?.resultCode ?? gateway?.returnReasonCode ?? 'missing')
  return { status: response.status, code, total: Number(root?.body?.totalCount ?? 0), rows: rows(root?.body?.items?.item) }
}

async function main() {
  const routeServiceCity = await call('BusRouteInfoInqireService', 'getCtyCodeList')
  const city = routeServiceCity.code === '00' ? routeServiceCity : await call('BusLcInfoInqireService', 'getCtyCodeList')
  const goyang = city.rows.filter((row) => String(row.cityname ?? '').includes('고양'))
  const result = { routeInfoAccess: { httpStatus: routeServiceCity.status, resultCode: routeServiceCity.code },
    city: { service: city === routeServiceCity ? 'BusRouteInfoInqireService' : 'BusLcInfoInqireService',
      httpStatus: city.status, resultCode: city.code, totalCount: city.total,
    checkedRows: city.rows.length, rowFields: city.rows[0] ? Object.keys(city.rows[0]) : [],
    goyang: goyang.map((row) => ({ cityCode: row.citycode, cityName: row.cityname })) } }
  if (city.status !== 200 || city.code !== '00' || goyang.length !== 1) {
    process.stdout.write(JSON.stringify(result) + '\n'); return
  }
  const cityCode = String(goyang[0].citycode)
  const route = await call('BusRouteInfoInqireService', 'getRouteNoList', { cityCode })
  const candidates = route.rows.filter((row) => String(row.routeno ?? '').trim() === '11')
  result.routes = { httpStatus: route.status, resultCode: route.code, totalCount: route.total,
    checkedRows: route.rows.length, rowFields: route.rows[0] ? Object.keys(route.rows[0]) : [],
    route11Candidates: candidates.map((row) => ({ routeId: row.routeid, routeNo: row.routeno })) }
  if (route.status !== 200 || route.code !== '00' || candidates.length !== 1) {
    process.stdout.write(JSON.stringify(result) + '\n'); return
  }
  const tagoRouteId = String(candidates[0].routeid)
  const location = await call('BusLcInfoInqireService', 'getRouteAcctoBusLcList', { cityCode, routeId: tagoRouteId })
  result.location = { httpStatus: location.status, resultCode: location.code, totalCount: location.total,
    checkedRows: location.rows.length, rowFields: location.rows[0] ? Object.keys(location.rows[0]) : [],
    gpsCoordinateRows: location.rows.filter((row) => Number.isFinite(Number(row.gpslati)) && Number.isFinite(Number(row.gpslong)) &&
      String(row.gpslati ?? '').trim() && String(row.gpslong ?? '').trim()).length,
    vehicleNumberRows: location.rows.filter((row) => String(row.vehicleno ?? '').trim()).length }
  process.stdout.write(JSON.stringify(result) + '\n')
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
