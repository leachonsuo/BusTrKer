// Bounded, local-only GBIS simulation. No public-data key or live GBIS request is used.
process.env.BUSTRACKER_TEST_METRICS = '1'
const assert = require('node:assert/strict')
const http = require('node:http')
const { performance } = require('node:perf_hooks')
const { MemoryBudgetStore, setBudgetStoreForTests } = require('../functions/lib/transit/budget.js')
const { vehiclesGbisRoute, resetGbisCooldownForTests } = require('../functions/lib/transit/gbis.js')
const { metricsSnapshot, resetMetricsForTests } = require('../functions/lib/transit/metrics.js')

const usersList = [10, 50, 100]
const minutesList = [15, 30, 60]
const emptyVehicles = JSON.stringify({ response: { msgHeader: { resultCode: 4 } } })

async function main() {
  const mock = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(emptyVehicles)
  })
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const address = mock.address()
  const mockUrl = `http://127.0.0.1:${address.port}/gbis-mock`
  const originalFetch = global.fetch
  const originalNow = Date.now
  let mockCalls = 0
  global.fetch = (_url, options) => { mockCalls++; return originalFetch(mockUrl, options) }
  let virtualNow = Date.parse('2026-10-10T00:00:00Z')
  Date.now = () => virtualNow

  try {
    let scenario = 0
    for (const sameRoutes of [true, false]) for (const users of usersList) for (const minutes of minutesList) {
      scenario++
      setBudgetStoreForTests(new MemoryBudgetStore(undefined, () => virtualNow))
      resetGbisCooldownForTests()
      resetMetricsForTests()
      mockCalls = 0
      const timings = []
      const outcomes = { ok: 0, limited: 0, otherError: 0 }
      let peakHeapBytes = process.memoryUsage().heapUsed
      const firstRouteId = 10_000_000 + scenario * 1_000_000
      const started = performance.now()
      for (let minute = 0; minute < minutes; minute++) {
        // Three waves expose both in-flight joining and the 20-second cache TTL.
        for (const [wave, offset] of [0, 10_000, 25_000].entries()) {
          virtualNow = Date.parse('2026-10-10T00:00:00Z') + minute * 60_000 + offset
          const requests = []
          for (let user = wave; user < users; user += 3) for (let route = 0; route < 3; route++) {
            const routeId = String(firstRouteId + (sameRoutes ? route : user * 3 + route))
            requests.push((async () => {
              const begin = performance.now()
              try { await vehiclesGbisRoute(routeId, 'mock-only-key'); outcomes.ok++ }
              catch (error) {
                if (error && (error.code === 'INTERNAL_BUDGET_EXHAUSTED' || error.code === 'UPSTREAM_RATE_LIMITED')) outcomes.limited++
                else outcomes.otherError++
              } finally { timings.push(performance.now() - begin) }
            })())
          }
          await Promise.all(requests)
          peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
        }
      }
      const metrics = metricsSnapshot()
      const sorted = timings.sort((a, b) => a - b)
      const requests = sorted.length
      const summary = {
        kind: sameRoutes ? 'same-3-routes' : 'distinct-3-per-user', users, minutes,
        serverRequests: requests, mockGbisCalls: mockCalls,
        cacheHits: metrics['cacheHit:vehicles']?.count ?? 0,
        inFlightJoins: metrics['cacheJoin:vehicles']?.count ?? 0,
        reserved: metrics['budgetReserved:locations']?.count ?? 0,
        budgetDenied: metrics['budgetDenied:locations']?.count ?? 0,
        successRate: Number((outcomes.ok / requests).toFixed(4)),
        failureRate: Number(((outcomes.limited + outcomes.otherError) / requests).toFixed(4)),
        serverErrors: outcomes.otherError,
        averageMs: Number((sorted.reduce((sum, value) => sum + value, 0) / requests).toFixed(2)),
        p95Ms: Number(sorted[Math.ceil(requests * 0.95) - 1].toFixed(2)),
        peakHeapMiB: Number((peakHeapBytes / 1024 / 1024).toFixed(1)),
        elapsedMs: Math.round(performance.now() - started),
      }
      assert.equal(requests, users * minutes * 3)
      assert.ok(mockCalls <= 800)
      assert.equal(mockCalls, summary.reserved)
      assert.equal(outcomes.otherError, 0)
      process.stdout.write(`${JSON.stringify(summary)}\n`)
    }
  } finally {
    global.fetch = originalFetch
    Date.now = originalNow
    setBudgetStoreForTests(null)
    await new Promise((resolve) => mock.close(resolve))
  }
}

main().catch((error) => { process.stderr.write(`Mock benchmark failed: ${error.message}\n`); process.exitCode = 1 })
