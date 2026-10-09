// One bounded comparison. Full plate values stay in memory and are never logged.
const fs = require('node:fs')
const path = require('node:path')
const { parsePrecisionLocations, normalizeFullPlate, assessFixAge, distanceToPathMeters } = require('../lib/transit/precisionEvidence.js')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8'))?.[1]?.trim()
if (!key) { process.stderr.write('Local service key unavailable\n'); process.exit(1) }
const ROUTE_ID = '219000001' // Verified against both providers' stop lists by audit-route-match.cjs.
const rows = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
const plate = (value) => normalizeFullPlate(String(value ?? ''))

async function get(base, params) {
  const url = new URL(base)
  url.search = new URLSearchParams({ serviceKey: key, ...params }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
  let body
  try { body = await response.json() } catch { throw new Error(`Non-JSON HTTP ${response.status}`) }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return body?.response ?? body
}

async function main() {
  const location = await get('https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2', { routeId: ROUTE_ID, format: 'json' })
  if (!['0', '4'].includes(String(location?.msgHeader?.resultCode))) throw new Error('GBIS location unavailable')
  const gbisRows = rows(location?.msgBody?.busLocationList)
  const gbisByPlate = new Map()
  let gbisPlateRows = 0
  for (const row of gbisRows) {
    const number = plate(row.plateNo)
    if (!number) continue
    gbisPlateRows++
    gbisByPlate.set(number, [...(gbisByPlate.get(number) ?? []), row])
  }
  const shapeReply = await get('https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteLineListv2', { routeId: ROUTE_ID, format: 'json' })
  if (String(shapeReply?.msgHeader?.resultCode) !== '0') throw new Error('GBIS route shape unavailable')
  const shape = rows(shapeReply?.msgBody?.busRouteLineList).sort((a, b) => Number(a.lineSeq) - Number(b.lineSeq))
    .map((row) => ({ latitude: Number(row.y), longitude: Number(row.x) }))
  const precisionRows = []
  const pageSize = 200, maxPages = 10
  let all = 0, total = null, pages = 0, parserAcceptedRows = 0, parserRejectedRows = 0
  for (let page = 1; page <= maxPages; page++) {
    const reply = await get('https://apis.data.go.kr/B551982/rte/rtm_loc_info',
      { stdgCd: '4128000000', pageNo: String(page), numOfRows: String(pageSize), type: 'json' })
    if (String(reply?.header?.resultCode) !== 'K0') throw new Error(`Precision location page ${page} unavailable`)
    total ??= Number(reply?.body?.totalCount)
    const current = rows(reply?.body?.items?.item)
    for (const item of current) {
      try { parsePrecisionLocations({ header: reply.header, body: { totalCount: 1, items: { item } } }); parserAcceptedRows++ }
      catch { parserRejectedRows++ }
    }
    all += current.length
    pages++
    precisionRows.push(...current.filter((row) => String(row.rteId) === ROUTE_ID))
    if (all >= total) break
    if (!current.length) throw new Error('Precision pagination ended early')
  }
  const now = Date.now()
  const matched = []
  let precisionPlateRows = 0
  for (const row of precisionRows) {
    const number = plate(row.vhclNo)
    if (!number) continue
    precisionPlateRows++
    const matches = gbisByPlate.get(number) ?? []
    if (matches.length !== 1) continue
    const ageSecondsIfKst = assessFixAge(String(row.gthrDt ?? ''), now, 540).ageSeconds
    const latitude = Number(row.lat), longitude = Number(row.lot)
    const validCoordinate = Number.isFinite(latitude) && Number.isFinite(longitude) &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    matched.push({ ageSecondsIfKst, validCoordinate,
      distanceToRouteMeters: validCoordinate ? Math.round(distanceToPathMeters({ latitude, longitude }, shape)) : null,
      gbisStateCode: Number(matches[0].stateCd) })
  }
  const fresh = matched.filter((row) => row.ageSecondsIfKst !== null && row.ageSecondsIfKst >= 0 && row.ageSecondsIfKst <= 120)
  const matchedAges = matched.map((row) => row.ageSecondsIfKst).filter((age) => age !== null)
  const matchedDistances = matched.map((row) => row.distanceToRouteMeters).filter((distance) => distance !== null)
  process.stdout.write(JSON.stringify({ routeId: ROUTE_ID,
    gbis: { count: gbisRows.length, hasPlateNoField: gbisRows.some((row) => Object.hasOwn(row, 'plateNo')),
      plateRows: gbisPlateRows, uniqueNormalizedPlates: gbisByPlate.size, duplicateNormalizedPlates: gbisPlateRows - gbisByPlate.size },
    precision: { totalRegionRows: total, checkedRegionRows: all, parserAcceptedRows, parserRejectedRows, pages, routeRows: precisionRows.length,
      hasVehicleNumberField: precisionRows.some((row) => Object.hasOwn(row, 'vhclNo')),
      plateRows: precisionPlateRows },
    exactFullPlateMatches: matched.length, conditionalKstFreshMatches: fresh.length,
    conditionalKstFreshWithin100mOfShape: fresh.filter((row) => row.validCoordinate && row.distanceToRouteMeters <= 100).length,
    matchedAgesIfKst: { within2m: fresh.length,
      from2to5m: matched.filter((row) => row.ageSecondsIfKst > 120 && row.ageSecondsIfKst <= 300).length,
      over5m: matched.filter((row) => row.ageSecondsIfKst > 300).length },
    matchedAgeSecondsIfKstRange: matchedAges.length ? [Math.min(...matchedAges), Math.max(...matchedAges)] : null,
    matchedRouteDistanceMetersRange: matchedDistances.length ? [Math.min(...matchedDistances), Math.max(...matchedDistances)] : null,
    matchedWithin100mOfShape: matchedDistances.filter((distance) => distance <= 100).length,
    matchedStateCodeCounts: Object.fromEntries([0, 1, 2].map((state) =>
      [state, matched.filter((row) => row.gbisStateCode === state).length])) }) + '\n')
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
