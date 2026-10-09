// Bounded, local-only audit. Keeps vehicle numbers and raw rows in memory; prints aggregates only.
const fs = require('node:fs')
const path = require('node:path')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8'))?.[1]?.trim()
if (!key) { process.stderr.write('Local service key unavailable\n'); process.exit(1) }
const PAGE_SIZE = 200
const MAX_PAGES = 10
const REGION = '4128000000'
const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value]

function timeShape(value) {
  const s = String(value ?? '').trim()
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(s)) return 'explicit-zone'
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(s)) return 'date-time-no-zone'
  if (/^\d{14}$/.test(s)) return 'compact-no-zone'
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return 'date-only'
  return s ? 'other' : 'missing'
}

function epoch(value, assumedOffset) {
  const s = String(value ?? '').trim()
  const shape = timeShape(s)
  if (shape === 'explicit-zone') return Date.parse(s.replace(' ', 'T'))
  let iso = s.replace(' ', 'T')
  if (shape === 'compact-no-zone') iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`
  if (shape !== 'date-time-no-zone' && shape !== 'compact-no-zone') return NaN
  return Date.parse(`${iso}${assumedOffset}`)
}

function distribution(rows, now, offset) {
  const counts = { within2m: 0, from2to5m: 0, from5to10m: 0, over10m: 0, future: 0, unparseable: 0 }
  let latestAgeSeconds = null
  for (const row of rows) {
    const captured = epoch(row.gthrDt, offset)
    if (!Number.isFinite(captured)) { counts.unparseable++; continue }
    const age = (now - captured) / 1000
    if (age < 0) counts.future++
    else if (age <= 120) counts.within2m++
    else if (age <= 300) counts.from2to5m++
    else if (age <= 600) counts.from5to10m++
    else counts.over10m++
    latestAgeSeconds = latestAgeSeconds === null ? age : Math.min(latestAgeSeconds, age)
  }
  return { ...counts, latestAgeSeconds: latestAgeSeconds === null ? null : Math.round(latestAgeSeconds) }
}

function validCoordinates(row) {
  if (String(row.lat ?? '').trim() === '' || String(row.lot ?? '').trim() === '') return false
  const latitude = Number(row.lat), longitude = Number(row.lot)
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
}

async function fetchPage(page) {
  const url = new URL('https://apis.data.go.kr/B551982/rte/rtm_loc_info')
  url.search = new URLSearchParams({ serviceKey: key, stdgCd: REGION, pageNo: String(page), numOfRows: String(PAGE_SIZE), type: 'json' }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
  let body
  try { body = await response.json() } catch { throw new Error(`Precision page ${page}: non-JSON HTTP ${response.status}`) }
  const root = body?.response ?? body
  const code = root?.header?.resultCode
  if (!response.ok || String(code) !== 'K0') throw new Error(`Precision page ${page}: HTTP ${response.status}, code ${String(code ?? 'missing')}`)
  const rows = list(root?.body?.items?.item)
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) throw new Error(`Precision page ${page}: invalid rows`)
  const total = Number(root?.body?.totalCount)
  if (!Number.isInteger(total) || total < 0) throw new Error(`Precision page ${page}: invalid total`)
  return { rows, total, status: response.status, contentType: response.headers.get('content-type') }
}

async function main() {
  const rows = []
  const pages = []
  let expected = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await fetchPage(page)
    expected ??= result.total
    if (result.total !== expected) throw new Error('Precision total changed during pagination; retry a bounded scan')
    pages.push({ page, returned: result.rows.length, httpStatus: result.status, contentType: result.contentType })
    rows.push(...result.rows)
    if (rows.length >= expected) break
    if (result.rows.length === 0) throw new Error('Precision pagination ended before total count')
  }
  const now = Date.now()
  const formats = {}
  for (const row of rows) formats[timeShape(row.gthrDt)] = (formats[timeShape(row.gthrDt)] ?? 0) + 1
  const identities = rows.map((row) => `${String(row.rteId ?? '')}:${String(row.vhclNo ?? '')}`)
  const validIdentities = identities.filter((id) => !id.endsWith(':') && !id.startsWith(':'))
  const latestByVehicle = new Map()
  rows.forEach((row, index) => {
    const identity = identities[index]
    if (identity.endsWith(':') || identity.startsWith(':')) return
    const current = latestByVehicle.get(identity)
    if (!current || epoch(row.gthrDt, '+09:00') > epoch(current.gthrDt, '+09:00')) latestByVehicle.set(identity, row)
  })
  const result = { regionCode: REGION, referenceTimeUtc: new Date(now).toISOString(), requestedPageSize: PAGE_SIZE, expectedTotal: expected, checkedRows: rows.length,
    complete: rows.length === expected, pages, timeFormats: formats, explicitTimezoneRows: formats['explicit-zone'] ?? 0,
    validCoordinateRows: rows.filter(validCoordinates).length, invalidCoordinateRows: rows.filter((row) => !validCoordinates(row)).length,
    conditionalKstFreshWithValidCoordinates: rows.filter((row) => validCoordinates(row) &&
      Number.isFinite(epoch(row.gthrDt, '+09:00')) && now - epoch(row.gthrDt, '+09:00') >= 0 &&
      now - epoch(row.gthrDt, '+09:00') <= 120_000).length,
    distinctVehicleKeys: new Set(validIdentities).size, duplicateRowsByVehicleKey: validIdentities.length - new Set(validIdentities).size,
    conditionalKst: distribution(rows, now, '+09:00'), conditionalUtc: distribution(rows, now, 'Z'),
    deduplicatedConditionalKst: distribution([...latestByVehicle.values()], now, '+09:00') }
  if (process.argv.includes('--repeat')) {
    await new Promise((resolve) => setTimeout(resolve, 65000))
    const repeat = await fetchPage(1)
    const firstPage = rows.slice(0, pages[0].returned)
    const before = new Map(firstPage.map((row) => [`${String(row.rteId ?? '')}:${String(row.vhclNo ?? '')}`, String(row.gthrDt ?? '')]))
    let compared = 0, changed = 0
    for (const row of repeat.rows) {
      const identity = `${String(row.rteId ?? '')}:${String(row.vhclNo ?? '')}`
      if (!before.has(identity)) continue
      compared++
      if (before.get(identity) !== String(row.gthrDt ?? '')) changed++
    }
    result.repeatFirstPage = { delaySeconds: 65, returned: repeat.rows.length, comparedVehicleKeys: compared,
      changedCollectionTimes: changed, unchangedCollectionTimes: compared - changed }
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
