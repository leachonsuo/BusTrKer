// Bounded evidence check for one public GBIS route and Goyang precision route catalog.
// Prints route metadata and aggregate stop comparisons, never vehicle identifiers or raw responses.
const fs = require('node:fs')
const path = require('node:path')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8'))?.[1]?.trim()
const routeId = process.argv[2] ?? '219000001'
if (!key || !/^\d{1,20}$/.test(routeId)) { process.stderr.write('Local key or numeric route ID unavailable\n'); process.exit(1) }
const rows = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
const norm = (value) => String(value ?? '').normalize('NFKC').replace(/[\s()\[\]·._-]/g, '').toLowerCase()

async function get(base, params) {
  const url = new URL(base)
  url.search = new URLSearchParams({ serviceKey: key, ...params }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  let body
  try { body = await response.json() } catch { throw new Error(`Non-JSON HTTP ${response.status}`) }
  const root = body?.response ?? body
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return root
}

function lcs(a, b) {
  let prior = Array(b.length + 1).fill(0)
  for (const item of a) {
    const next = Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) next[j] = item === b[j - 1] ? prior[j - 1] + 1 : Math.max(prior[j], next[j - 1])
    prior = next
  }
  return prior[b.length]
}

async function main() {
  const gbisBase = 'https://apis.data.go.kr/6410000/busrouteservice/v2/'
  const detail = await get(gbisBase + 'getBusRouteInfoItemv2', { format: 'json', routeId })
  const gbisRoute = detail?.msgBody?.busRouteInfoItem
  if (String(detail?.msgHeader?.resultCode) !== '0' || !gbisRoute || Array.isArray(gbisRoute)) throw new Error('GBIS route detail unavailable')
  const stopReply = await get(gbisBase + 'getBusRouteStationListv2', { format: 'json', routeId })
  if (String(stopReply?.msgHeader?.resultCode) !== '0') throw new Error('GBIS stops unavailable')
  const gbisStops = rows(stopReply?.msgBody?.busRouteStationList).sort((a, b) => Number(a.stationSeq) - Number(b.stationSeq))
  const base = 'https://apis.data.go.kr/B551982/rte/'
  const master = await get(base + 'mst_info', { stdgCd: '4128000000', pageNo: '1', numOfRows: '100', type: 'json' })
  if (String(master?.header?.resultCode) !== 'K0') throw new Error('Precision master unavailable')
  const masters = rows(master?.body?.items?.item)
  const candidates = masters.filter((row) => norm(row.rteNo) === norm(gbisRoute.routeName))
  const precisionStops = []
  const pageSize = 500, maxPages = 30
  let total = null, pages = 0, allRows = 0
  for (let page = 1; page <= maxPages; page++) {
    const reply = await get(base + 'ps_info', { stdgCd: '4128000000', pageNo: String(page), numOfRows: String(pageSize), type: 'json' })
    if (String(reply?.header?.resultCode) !== 'K0') throw new Error(`Precision stops page ${page} unavailable: code ${String(reply?.header?.resultCode ?? reply?.msgHeader?.resultCode ?? 'missing')}`)
    total ??= Number(reply?.body?.totalCount)
    const current = rows(reply?.body?.items?.item)
    pages++
    allRows += current.length
    precisionStops.push(...current.filter((row) => candidates.some((candidate) => String(row.rteId) === String(candidate.rteId))))
    if (allRows >= total) break
    if (!current.length) throw new Error('Precision stop pagination ended early')
  }
  const gbisNames = gbisStops.map((row) => norm(row.stationName))
  const gbisIds = gbisStops.map((row) => String(row.stationId))
  const candidateResults = candidates.map((candidate) => {
    const own = precisionStops.filter((row) => String(row.rteId) === String(candidate.rteId))
    const directions = [...new Set(own.map((row) => String(row.drcGbnCd ?? 'missing')))]
    const sorted = [...own].sort((a, b) => Number(a.bstaSn) - Number(b.bstaSn))
    const names = sorted.map((row) => norm(row.bstaNm))
    const ids = sorted.map((row) => String(row.bstaId))
    return { rteId: String(candidate.rteId), routeNo: String(candidate.rteNo),
      sameNumericId: String(candidate.rteId) === routeId,
      endpoints: { gbis: [gbisRoute.startStationName, gbisRoute.endStationName], precision: [candidate.stpnt, candidate.edpnt] },
      endpointNameMatches: norm(gbisRoute.startStationName) === norm(candidate.stpnt) && norm(gbisRoute.endStationName) === norm(candidate.edpnt),
      precisionStopCount: own.length, directionCodes: directions,
      exactStopIdOverlap: ids.filter((id) => gbisIds.includes(id)).length,
      normalizedStopNameOverlap: names.filter((name) => gbisNames.includes(name)).length,
      nameOrderLcs: lcs(gbisNames, names), idOrderLcs: lcs(gbisIds, ids) }
  })
  process.stdout.write(JSON.stringify({ gbis: { routeId, name: gbisRoute.routeName,
    regionName: gbisRoute.regionName, stopCount: gbisStops.length,
    turnPointCount: gbisStops.filter((row) => row.turnYn === 'Y').length },
    precision: { masterCount: masters.length, expectedStopTotal: total, checkedStopRows: allRows,
      complete: allRows === total, pages, candidateCount: candidates.length, candidates: candidateResults } }) + '\n')
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
