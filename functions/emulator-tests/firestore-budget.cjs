const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { initializeApp, deleteApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { FirestoreBudgetStore } = require('../lib/transit/firestore-budget.js')
const { ROLLING_WINDOW_MS, setBudgetStoreForTests } = require('../lib/transit/budget.js')
const { nearbyGbis } = require('../lib/transit/gbis.js')

const projectId = 'demo-bustracker-budget'
const host = process.env.FIRESTORE_EMULATOR_HOST
if (process.env.GCLOUD_PROJECT !== projectId || !/^(localhost|127\.0\.0\.1):\d+$/.test(host ?? '')) {
  throw new Error('Firestore tests require the local emulator and demo-bustracker-budget project')
}
const app = initializeApp({ projectId }, `budget-test-${randomUUID()}`)
const db = getFirestore(app)
const execFileAsync = promisify(execFile)
function collection() { return `bustracker_budget_test_${randomUUID().replace(/-/g, '')}` }
function timings(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1)),
    maxMs: Number(sorted.at(-1).toFixed(1)),
  }
}

test('0, 799, 800 and 50 concurrent reservations are globally atomic', async () => {
  const path = collection()
  const now = Date.now()
  const one = new FirestoreBudgetStore(db, () => now, path)
  assert.deepEqual(await one.reserve('stations', 800), { allowed: true, used: 1, limit: 800 })
  const attempts = Array.from({ length: 799 }, () => ({ id: randomUUID(), at: now }))
  await db.collection(path).doc('stations').set({ version: 1, lastSeenAt: now, attempts })
  let callbackRuns = 0
  const measuredDb = {
    collection: db.collection.bind(db),
    runTransaction: (callback, options) => db.runTransaction((transaction) => {
      callbackRuns++
      return callback(transaction)
    }, options),
  }
  const samples = await Promise.all(Array.from({ length: 50 }, async () => {
    const started = performance.now()
    const decision = await new FirestoreBudgetStore(measuredDb, Date.now, path).reserve('stations', 800)
    return { decision, ms: performance.now() - started }
  }))
  const decisions = samples.map((sample) => sample.decision)
  assert.equal(decisions.filter((item) => item.allowed).length, 1)
  assert.equal(decisions.filter((item) => !item.allowed).length, 49)
  assert.ok(decisions.every((item) => item.used === 800))
  const saved = (await db.collection(path).doc('stations').get()).data()
  assert.equal(saved.attempts.length, 800)
  assert.equal(new Set(saved.attempts.map((item) => item.id)).size, 800)
  const deniedStore = new FirestoreBudgetStore(db, Date.now, path)
  const firstDeniedStart = performance.now()
  assert.equal((await deniedStore.reserve('stations', 800)).allowed, false)
  const firstDeniedMs = performance.now() - firstDeniedStart
  const cachedDeniedStart = performance.now()
  assert.equal((await deniedStore.reserve('stations', 800)).allowed, false)
  const cachedDeniedMs = performance.now() - cachedDeniedStart
  assert.ok(callbackRuns >= 50)
  console.log('FIRESTORE_BUDGET_PERF', JSON.stringify({
    scenario: '50-at-799', ...timings(samples.map((sample) => sample.ms)),
    transactionCallbacks: callbackRuns, callbackRetries: callbackRuns - 50,
    firstDeniedMs: Number(firstDeniedMs.toFixed(1)), cachedDeniedMs: Number(cachedDeniedMs.toFixed(1)),
  }))
})

test('independent services, rolling boundary, expiration and backwards clock', async () => {
  const path = collection()
  let now = Date.parse('2026-10-10T14:59:59Z')
  const store = new FirestoreBudgetStore(db, () => now, path)
  for (const service of ['routes', 'stations', 'locations', 'arrivals']) {
    assert.equal((await store.reserve(service, 1)).allowed, true)
    assert.equal((await store.reserve(service, 1)).allowed, false)
  }
  now += 2_000 // KST midnight
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now = Date.parse('2026-10-10T23:59:59Z')
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now += 2_000 // UTC midnight
  assert.equal((await store.reserve('routes', 1)).allowed, false)
  now = Date.parse('2026-10-10T14:59:59Z') + ROLLING_WINDOW_MS
  assert.equal((await store.reserve('routes', 1)).allowed, true)
  assert.equal((await db.collection(path).doc('routes').get()).data().attempts.length, 1)
  now--
  await assert.rejects(store.reserve('routes', 1), /clock/)
})

test('separate Node processes share the same document and survive restart', async () => {
  const path = collection()
  const modulePath = require.resolve('../lib/transit/firestore-budget.js')
  const script = `
    if (process.env.GCLOUD_PROJECT !== 'demo-bustracker-budget' ||
        !/^(localhost|127\\.0\\.0\\.1):\\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) process.exit(3);
    const {initializeApp,deleteApp}=require('firebase-admin/app');
    const {getFirestore}=require('firebase-admin/firestore');
    const {FirestoreBudgetStore}=require(process.argv[1]);
    (async()=>{const app=initializeApp({projectId:process.env.GCLOUD_PROJECT});
      const db=getFirestore(app); const started=performance.now();
      const result=await new FirestoreBudgetStore(db, Date.now, process.argv[2]).reserve('locations',2);
      process.stdout.write(JSON.stringify({allowed:result.allowed,ms:performance.now()-started}));
      await db.terminate(); await deleteApp(app)})().catch(()=>process.exit(2));`
  const child = async () => JSON.parse((await execFileAsync(process.execPath, ['-e', script, modulePath, path], {
    cwd: __dirname, timeout: 60_000, env: process.env,
  })).stdout)
  const results = await Promise.all(Array.from({ length: 8 }, child))
  assert.equal(results.filter((result) => result.allowed).length, 2)
  assert.equal(results.filter((result) => !result.allowed).length, 6)
  assert.equal((await child()).allowed, false) // fresh process after earlier processes exited
  assert.equal((await db.collection(path).doc('locations').get()).data().attempts.length, 2)
  console.log('FIRESTORE_BUDGET_PERF', JSON.stringify({ scenario: '8-processes-at-0', ...timings(results.map((result) => result.ms)) }))
})

test('emulator conflict retries keep one final approval; malformed documents fail closed', async () => {
  const path = collection()
  const now = Date.now()
  await db.collection(path).doc('arrivals').set({ version: 1, lastSeenAt: now,
    attempts: [{ id: randomUUID(), at: now }] })
  const decisions = await Promise.all(Array.from({ length: 20 }, () =>
    new FirestoreBudgetStore(db, Date.now, path).reserve('arrivals', 2)))
  assert.equal(decisions.filter((item) => item.allowed).length, 1)
  assert.equal((await db.collection(path).doc('arrivals').get()).data().attempts.length, 2)
  await db.collection(path).doc('routes').set({ version: 1, lastSeenAt: now, attempts: [{ id: 'bad', at: now }] })
  await assert.rejects(new FirestoreBudgetStore(db, Date.now, path).reserve('routes', 800), /invalid/)
})

test('an acknowledgement lost after commit does not reserve twice on retry', async () => {
  const path = collection()
  let loseOnce = true
  const proxy = {
    collection: db.collection.bind(db),
    runTransaction: async (callback, options) => {
      const result = await db.runTransaction(callback, options)
      if (loseOnce) {
        loseOnce = false
        const error = new Error('mock lost acknowledgement')
        error.code = 10
        throw error
      }
      return result
    },
  }
  const result = await new FirestoreBudgetStore(proxy, Date.now, path).reserve('routes', 1)
  assert.deepEqual(result, { allowed: true, used: 1, limit: 1 })
  assert.equal((await db.collection(path).doc('routes').get()).data().attempts.length, 1)
})

test('mock GBIS failure consumes reservation; cache hit and request join do not', async () => {
  const originalFetch = global.fetch
  const originalLimit = process.env.GBIS_BUDGET_STATIONS
  const path = collection()
  let fetches = 0
  process.env.GBIS_BUDGET_STATIONS = '2'
  setBudgetStoreForTests(new FirestoreBudgetStore(db, Date.now, path))
  global.fetch = async () => {
    fetches++
    return new Response(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody: {
      busStationAroundList: { stationId: 123456, stationName: '모의 정류장', x: 126.7, y: 37.6 },
    } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const point = { latitude: 37.61234, longitude: 126.71234 }
    const [first, second] = await Promise.all([nearbyGbis(point, 'mock-key'), nearbyGbis(point, 'mock-key')])
    assert.equal(first.stops.length, 1)
    assert.equal(second.stops.length, 1)
    assert.equal((await nearbyGbis(point, 'mock-key')).stops.length, 1)
    assert.equal(fetches, 1)
    assert.equal((await db.collection(path).doc('stations').get()).data().attempts.length, 1)
    global.fetch = async () => { fetches++; throw new Error('mock offline') }
    await assert.rejects(nearbyGbis({ latitude: 37.61335, longitude: 126.71335 }, 'mock-key'),
      (error) => error.code === 'UPSTREAM_NETWORK_ERROR')
    assert.equal((await db.collection(path).doc('stations').get()).data().attempts.length, 2)
    await assert.rejects(nearbyGbis({ latitude: 37.61436, longitude: 126.71436 }, 'mock-key'),
      (error) => error.code === 'INTERNAL_BUDGET_EXHAUSTED' && error.status === 429)
    assert.equal(fetches, 2)
  } finally {
    global.fetch = originalFetch
    setBudgetStoreForTests(null)
    if (originalLimit === undefined) delete process.env.GBIS_BUDGET_STATIONS
    else process.env.GBIS_BUDGET_STATIONS = originalLimit
  }
})

test('transaction storage outage is 503 and sends no GBIS request', async () => {
  const originalFetch = global.fetch
  const { reserveGbisAttempt } = require('../lib/transit/budget.js')
  let fetches = 0
  global.fetch = async () => { fetches++; throw new Error('must not fetch') }
  setBudgetStoreForTests(new FirestoreBudgetStore({
    collection: () => ({ doc: () => ({}) }),
    runTransaction: async () => { throw new Error('mock storage outage') },
  }))
  try {
    assert.equal((await reserveGbisAttempt('getBusStationAroundListv2')).kind, 'unavailable')
    await assert.rejects(nearbyGbis({ latitude: 37.61537, longitude: 126.71537 }, 'mock-key'),
      (error) => error.code === 'BUDGET_UNAVAILABLE' && error.status === 503)
    assert.equal(fetches, 0)
  } finally { global.fetch = originalFetch; setBudgetStoreForTests(null) }
})

test('configured Firestore mode selects the demo emulator without a test-store override', async () => {
  const originalMode = process.env.GBIS_BUDGET_STORE
  const originalEmulator = process.env.FUNCTIONS_EMULATOR
  const originalLimit = process.env.GBIS_BUDGET_ARRIVALS
  process.env.GBIS_BUDGET_STORE = 'firestore'
  process.env.FUNCTIONS_EMULATOR = 'true'
  process.env.GBIS_BUDGET_ARRIVALS = '1'
  const { reserveGbisAttempt } = require('../lib/transit/budget.js')
  try {
    assert.equal((await reserveGbisAttempt('getBusArrivalListv2')).kind, 'reserved')
    assert.equal((await reserveGbisAttempt('getBusArrivalListv2')).kind, 'exhausted')
  } finally {
    for (const [name, value] of [
      ['GBIS_BUDGET_STORE', originalMode], ['FUNCTIONS_EMULATOR', originalEmulator],
      ['GBIS_BUDGET_ARRIVALS', originalLimit],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test.after(async () => { await db.terminate(); await deleteApp(app) })
