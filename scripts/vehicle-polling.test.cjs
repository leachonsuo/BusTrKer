const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { Module } = require('node:module')
const { resolve, dirname } = require('node:path')

const source = resolve(__dirname, '../src/transit/vehiclePolling.ts')
const compiled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const moduleUnderTest = new Module(source)
moduleUnderTest.filename = source
moduleUnderTest.paths = Module._nodeModulePaths(dirname(source))
moduleUnderTest._compile(compiled, source)
const { VehiclePollingController } = moduleUnderTest.exports

const route = (value) => ({ key: `gbis:gyeonggi:${value}`, id: { provider: 'gbis', regionCode: 'gyeonggi', value }, visible: true })
const data = (value) => ({ routeId: route(value).id, vehicles: [], queriedAt: new Date().toISOString(), source: 'gbis' })
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fakeClock() {
  let now = 1_000
  let serial = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

test('adding a second route does not cancel or restart the first in-flight request', async () => {
  const clock = fakeClock()
  const calls = []
  const updates = []
  const controller = new VehiclePollingController((id, signal) => new Promise((resolve) => calls.push({ id: id.value, signal, resolve })),
    (key, event) => updates.push([key, event?.status ?? null]), clock.now, clock.setTimer, clock.clearTimer, () => 0)
  controller.setRoutes([route('1')])
  clock.advance(0)
  controller.setRoutes([route('1'), route('2')])
  clock.advance(0)
  assert.deepEqual(calls.map((call) => call.id), ['1', '2'])
  assert.equal(calls[0].signal.aborted, false)
  calls[0].resolve(data('1'))
  calls[1].resolve(data('2'))
  await flush()
  assert.ok(updates.some(([key, status]) => key.endsWith(':1') && status === 'ready'))
  controller.setRoutes([])
})

test('rapid manual refresh coalesces with an in-flight request and respects recent data', async () => {
  const clock = fakeClock()
  let calls = 0
  let resolveRequest
  const controller = new VehiclePollingController(() => { calls++; return new Promise((resolve) => { resolveRequest = resolve }) },
    () => {}, clock.now, clock.setTimer, clock.clearTimer, () => 0)
  controller.setRoutes([route('1')])
  clock.advance(0)
  assert.equal(controller.refresh().busy, 1)
  assert.equal(controller.refresh().busy, 1)
  assert.equal(calls, 1)
  resolveRequest(data('1'))
  await flush()
  assert.equal(controller.refresh().recent, 1)
  clock.advance(60_000)
  assert.equal(calls, 2)
  controller.setRoutes([])
})

test('hidden tabs stop timers and late removed-route responses are ignored', async () => {
  const clock = fakeClock()
  const calls = []
  const updates = []
  const controller = new VehiclePollingController((id, signal) => new Promise((resolve) => calls.push({ id: id.value, signal, resolve })),
    (key, event) => updates.push([key, event?.status ?? null]), clock.now, clock.setTimer, clock.clearTimer, () => 0)
  controller.setRoutes([route('1')])
  clock.advance(0)
  controller.setVisible(false)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(clock.pending(), 0)
  controller.setVisible(true)
  clock.advance(0)
  assert.equal(calls.length, 2)
  controller.setRoutes([])
  calls[1].resolve(data('1'))
  await flush()
  assert.equal(updates.at(-1)[1], null)
  assert.equal(clock.pending(), 0)
})

test('429 backs off one route while another continues; authentication blocks automatic retry', async () => {
  const clock = fakeClock()
  const calls = []
  const controller = new VehiclePollingController((id) => {
    calls.push(id.value)
    if (id.value === '1') return Promise.reject(Object.assign(new Error('limited'), { status: 429 }))
    if (id.value === '3') return Promise.reject(Object.assign(new Error('auth'), { status: 502, code: 'UPSTREAM_AUTH_ERROR' }))
    return Promise.resolve(data(id.value))
  }, () => {}, clock.now, clock.setTimer, clock.clearTimer, () => 0)
  controller.setRoutes([route('1'), route('2'), route('3')])
  clock.advance(0)
  await flush()
  assert.equal(controller.refresh().rateLimited, 1)
  clock.advance(60_000)
  await flush()
  assert.equal(calls.filter((id) => id === '2').length, 2)
  assert.equal(calls.filter((id) => id === '1').length, 1)
  assert.equal(calls.filter((id) => id === '3').length, 1)
  clock.advance(60_000)
  await flush()
  assert.equal(calls.filter((id) => id === '1').length, 2)
  assert.equal(calls.filter((id) => id === '3').length, 1)
  controller.setRoutes([])
})

test('offline aborts in-flight work and reconnect schedules one request without overlapping timers', async () => {
  const clock = fakeClock()
  const calls = []
  const updates = []
  const controller = new VehiclePollingController((id, signal) => new Promise((resolve) => calls.push({ id: id.value, signal, resolve })),
    (_key, event) => updates.push(event), clock.now, clock.setTimer, clock.clearTimer, () => 0)
  controller.setRoutes([route('1')])
  clock.advance(0)
  controller.setOnline(false)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(clock.pending(), 0)
  assert.equal(controller.refresh().unavailable, true)
  assert.equal(updates.at(-1).status, 'error')
  controller.setOnline(true)
  controller.setOnline(true)
  assert.equal(clock.pending(), 1)
  clock.advance(10_000)
  assert.equal(calls.length, 2)
  calls[0].resolve(data('1'))
  calls[1].resolve(data('1'))
  await flush()
  assert.equal(updates.at(-1).status, 'ready')
  assert.equal(clock.pending(), 1)
  controller.setRoutes([])
  assert.equal(clock.pending(), 0)
})
