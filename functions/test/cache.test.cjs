const { test } = require('node:test')
const assert = require('node:assert/strict')
process.env.BUSTRACKER_TEST_METRICS = '1'
const { cached, cacheSizes } = require('../lib/transit/cache.js')
const { metricsSnapshot, resetMetricsForTests } = require('../lib/transit/metrics.js')

test('ten simultaneous requests use one loader; valid TTL hits and expiry reloads', async () => {
  resetMetricsForTests()
  let calls = 0
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const load = async () => { calls++; await barrier; return { value: calls } }
  const pending = Array.from({ length: 10 }, () => cached('gbis:vehicles:concurrent-test', 25, load))
  release()
  const values = await Promise.all(pending)
  assert.equal(calls, 1)
  assert.ok(values.every((item) => item.value === 1))
  assert.equal((await cached('gbis:vehicles:concurrent-test', 25, load)).value, 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await cached('gbis:vehicles:concurrent-test', 25, load)).value, 2)
  const metrics = metricsSnapshot()
  assert.equal(metrics['cacheJoin:vehicles'].count, 9)
  assert.equal(metrics['cacheHit:vehicles'].count, 1)
  assert.equal(metrics['cacheMiss:vehicles'].count, 2)
  assert.equal(cacheSizes().pending, 0)
})

test('failed loader is neither cached nor left in flight', async () => {
  let calls = 0
  const key = 'gbis:arrivals:failure-test'
  await assert.rejects(cached(key, 1000, async () => { calls++; throw new Error('temporary') }), /temporary/)
  assert.equal(await cached(key, 1000, async () => { calls++; return 'recovered' }), 'recovered')
  assert.equal(calls, 2)
  assert.equal(cacheSizes().pending, 0)
})

test('the process cache remains bounded', async () => {
  for (let index = 0; index < 310; index++) await cached(`gbis:route-shape:bound-${index}`, 10000, async () => index)
  assert.ok(cacheSizes().entries <= 300)
})
