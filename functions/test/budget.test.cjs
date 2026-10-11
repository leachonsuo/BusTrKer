const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')
const execFileAsync = promisify(execFile)
const {
  MemoryBudgetStore, FileBudgetStore, ROLLING_WINDOW_MS, reserveGbisAttempt,
  serviceForGbisApi, setBudgetStoreForTests,
} = require('../lib/transit/budget.js')

test('all four route endpoints share one service budget; the other three are independent', async () => {
  for (const api of ['getBusRouteListv2', 'getBusRouteInfoItemv2', 'getBusRouteLineListv2', 'getBusRouteStationListv2']) {
    assert.equal(serviceForGbisApi(api), 'routes')
  }
  assert.equal(serviceForGbisApi('getBusStationAroundListv2'), 'stations')
  assert.equal(serviceForGbisApi('getBusLocationListv2'), 'locations')
  assert.equal(serviceForGbisApi('getBusArrivalListv2'), 'arrivals')
  assert.equal(serviceForGbisApi('unmappedMethod'), null)
  const store = new MemoryBudgetStore()
  for (const api of ['getBusRouteListv2', 'getBusRouteInfoItemv2']) {
    assert.equal((await store.reserve(serviceForGbisApi(api), 2)).allowed, true)
  }
  assert.equal((await store.reserve('routes', 2)).allowed, false)
  for (const service of ['stations', 'locations', 'arrivals']) assert.equal((await store.reserve(service, 2)).used, 1)
})

test('0, 500, 799 and 800 attempts; concurrent last slot is granted once', async () => {
  const store = new MemoryBudgetStore()
  assert.equal((await store.reserve('locations', 800)).used, 1)
  for (let count = 2; count <= 500; count++) await store.reserve('locations', 800)
  assert.equal((await store.reserve('locations', 800)).used, 501)
  for (let count = 502; count <= 799; count++) await store.reserve('locations', 800)
  const decisions = await Promise.all(Array.from({ length: 20 }, () => store.reserve('locations', 800)))
  assert.equal(decisions.filter((decision) => decision.allowed).length, 1)
  assert.equal(decisions.filter((decision) => !decision.allowed).length, 19)
  assert.ok(decisions.every((decision) => decision.used === 800))
})

test('rolling 24 hours does not reset at either UTC or KST midnight; clock regression fails closed', async () => {
  let now = Date.parse('2026-10-10T14:59:59.000Z') // 23:59:59 KST
  const store = new MemoryBudgetStore(undefined, () => now)
  assert.equal((await store.reserve('routes', 1)).allowed, true)
  now += 2_000 // KST date changed
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now = Date.parse('2026-10-10T23:59:59.000Z')
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now += 2_000 // UTC date changed
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now = Date.parse('2026-10-10T14:59:59.000Z') + ROLLING_WINDOW_MS
  assert.equal((await store.reserve('routes', 1)).allowed, true)
  now--
  await assert.rejects(store.reserve('routes', 1), /clock/)
})

test('local file ledger survives a fresh Node process and serializes multiple instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bustracker-budget-'))
  const file = join(dir, 'ledger.json')
  try {
    const modulePath = resolve(__dirname, '../lib/transit/budget.js')
    const child = `const {FileBudgetStore}=require(process.argv[1]); new FileBudgetStore(process.argv[2]).reserve('stations',2).then(r=>process.stdout.write(String(r.allowed))).catch(()=>process.exit(2))`
    assert.equal(execFileSync(process.execPath, ['-e', child, modulePath, file], { encoding: 'utf8' }), 'true')
    assert.equal(execFileSync(process.execPath, ['-e', child, modulePath, file], { encoding: 'utf8' }), 'true')
    assert.equal((await new FileBudgetStore(file).reserve('stations', 2)).allowed, false)
    const ledger = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(ledger.attempts.stations.length, 2)

    const other = join(dir, 'parallel.json')
    const decisions = await Promise.all(Array.from({ length: 10 }, () => new FileBudgetStore(other).reserve('arrivals', 3)))
    assert.equal(decisions.filter((item) => item.allowed).length, 3)
    assert.equal((await new FileBudgetStore(other).reserve('arrivals', 3)).allowed, false)
    const acrossProcesses = join(dir, 'processes.json')
    const childResults = await Promise.all(Array.from({ length: 8 }, () =>
      execFileAsync(process.execPath, ['-e', child, modulePath, acrossProcesses], { encoding: 'utf8' })))
    assert.equal(childResults.filter((item) => item.stdout === 'true').length, 2)
    assert.equal(childResults.filter((item) => item.stdout === 'false').length, 6)
    await writeFile(other, '{corrupt')
    await assert.rejects(new FileBudgetStore(other).reserve('arrivals', 3))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a reservation is required before fetch, cache hits do not reserve, and failed fetches stay counted', async () => {
  const originalFetch = global.fetch
  const originalLimit = process.env.GBIS_BUDGET_STATIONS
  let calls = 0
  const { nearbyGbis } = require('../lib/transit/gbis.js')
  process.env.GBIS_BUDGET_STATIONS = '1'
  setBudgetStoreForTests(new MemoryBudgetStore())
  global.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody: { busStationAroundList: {
      stationId: 1001, stationName: '모의 정류장', x: 126.7, y: 37.6,
    } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const first = { latitude: 37.6011, longitude: 126.7011 }
    assert.equal((await nearbyGbis(first, 'not-a-real-key')).stops.length, 1)
    assert.equal((await nearbyGbis(first, 'not-a-real-key')).stops.length, 1)
    await assert.rejects(nearbyGbis({ latitude: 37.6021, longitude: 126.7021 }, 'not-a-real-key'),
      (error) => error.status === 429 && error.code === 'INTERNAL_BUDGET_EXHAUSTED')
    assert.equal(calls, 1)

    setBudgetStoreForTests(new MemoryBudgetStore())
    global.fetch = async () => { calls++; throw new Error('mock network failure') }
    await assert.rejects(nearbyGbis({ latitude: 37.6031, longitude: 126.7031 }, 'not-a-real-key'),
      (error) => error.code === 'UPSTREAM_NETWORK_ERROR')
    await assert.rejects(nearbyGbis({ latitude: 37.6041, longitude: 126.7041 }, 'not-a-real-key'),
      (error) => error.code === 'INTERNAL_BUDGET_EXHAUSTED')
    assert.equal(calls, 2)

    setBudgetStoreForTests(new MemoryBudgetStore())
    global.fetch = async () => { calls++; throw new DOMException('mock timeout', 'TimeoutError') }
    await assert.rejects(nearbyGbis({ latitude: 37.6051, longitude: 126.7051 }, 'not-a-real-key'),
      (error) => error.code === 'UPSTREAM_TIMEOUT')
    await assert.rejects(nearbyGbis({ latitude: 37.6061, longitude: 126.7061 }, 'not-a-real-key'),
      (error) => error.code === 'INTERNAL_BUDGET_EXHAUSTED')
    assert.equal(calls, 3)
  } finally {
    global.fetch = originalFetch
    setBudgetStoreForTests(null)
    if (originalLimit === undefined) delete process.env.GBIS_BUDGET_STATIONS
    else process.env.GBIS_BUDGET_STATIONS = originalLimit
  }
})

test('an unavailable shared store and an unmapped API fail closed without a GBIS request', async () => {
  const originalLimit = process.env.GBIS_BUDGET_ROUTES
  const originalFetch = global.fetch
  let fetches = 0
  global.fetch = async () => { fetches++; throw new Error('should not fetch') }
  setBudgetStoreForTests({ reserve: async () => { throw new Error('storage down') } })
  try {
    assert.equal((await reserveGbisAttempt('getBusRouteListv2')).kind, 'unavailable')
    assert.equal((await reserveGbisAttempt('newUnmappedApi')).kind, 'unavailable')
    const { nearbyGbis } = require('../lib/transit/gbis.js')
    await assert.rejects(nearbyGbis({ latitude: 37.6071, longitude: 126.7071 }, 'mock-only-key'),
      (error) => error.status === 503 && error.code === 'BUDGET_UNAVAILABLE')
    assert.equal(fetches, 0)
    process.env.GBIS_BUDGET_ROUTES = '1001'
    assert.equal((await reserveGbisAttempt('getBusRouteListv2')).kind, 'unavailable')
  } finally {
    setBudgetStoreForTests(null)
    global.fetch = originalFetch
    if (originalLimit === undefined) delete process.env.GBIS_BUDGET_ROUTES
    else process.env.GBIS_BUDGET_ROUTES = originalLimit
  }
})

test('production without a durable shared store is blocked before any GBIS call', async () => {
  const previous = process.env.FUNCTIONS_EMULATOR
  delete process.env.FUNCTIONS_EMULATOR
  setBudgetStoreForTests(null)
  try { assert.equal((await reserveGbisAttempt('getBusLocationListv2')).kind, 'unavailable') }
  finally { if (previous === undefined) delete process.env.FUNCTIONS_EMULATOR; else process.env.FUNCTIONS_EMULATOR = previous }
})

test('Firestore mode refuses a non-demo emulator project without opening a database', async () => {
  const names = ['FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'GCLOUD_PROJECT', 'GBIS_BUDGET_STORE']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  setBudgetStoreForTests(null)
  Object.assign(process.env, {
    FUNCTIONS_EMULATOR: 'true', FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
    GCLOUD_PROJECT: 'bustrker', GBIS_BUDGET_STORE: 'firestore',
  })
  try { assert.equal((await reserveGbisAttempt('getBusLocationListv2')).kind, 'unavailable') }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('an unresponsive budget store times out without an external GBIS request', async () => {
  const originalFetch = global.fetch
  let fetches = 0
  global.fetch = async () => { fetches++; throw new Error('must not fetch') }
  setBudgetStoreForTests({ reserve: () => new Promise(() => undefined) })
  const { nearbyGbis } = require('../lib/transit/gbis.js')
  try {
    const started = performance.now()
    await assert.rejects(nearbyGbis({ latitude: 37.61637, longitude: 126.71637 }, 'mock-key'),
      (error) => error.status === 503 && error.code === 'BUDGET_UNAVAILABLE')
    assert.ok(performance.now() - started >= 11_000)
    assert.equal(fetches, 0)
  } finally { global.fetch = originalFetch; setBudgetStoreForTests(null) }
})

test('a malformed reservation response also fails closed', async () => {
  setBudgetStoreForTests({ reserve: async () => ({ allowed: true, used: 0, limit: 800 }) })
  try { assert.equal((await reserveGbisAttempt('getBusLocationListv2')).kind, 'unavailable') }
  finally { setBudgetStoreForTests(null) }
})

test('a GBIS 429 cooldown affects its service only and does not reserve a second attempt', async () => {
  const originalFetch = global.fetch
  const { searchGbisRoutes, nearbyGbis, resetGbisCooldownForTests } = require('../lib/transit/gbis.js')
  const store = new MemoryBudgetStore()
  setBudgetStoreForTests(store)
  resetGbisCooldownForTests()
  let requests = 0
  global.fetch = async () => {
    requests++
    if (requests === 1) return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ response: { msgHeader: { resultCode: 4 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(searchGbisRoutes('mockroute987', 'mock-only-key'), (error) => error.code === 'UPSTREAM_RATE_LIMITED')
    await assert.rejects(searchGbisRoutes('mockroute988', 'mock-only-key'), (error) => error.code === 'UPSTREAM_RATE_LIMITED')
    assert.equal((await nearbyGbis({ latitude: 37.6112, longitude: 126.7112 }, 'mock-only-key')).stops.length, 0)
    assert.equal(requests, 2)
    assert.equal((await store.reserve('routes', 2)).used, 2) // first 429 counted; cooldown did not count
  } finally { global.fetch = originalFetch; resetGbisCooldownForTests(); setBudgetStoreForTests(null) }
})
