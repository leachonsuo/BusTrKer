const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'transit', 'routeSegments.ts'), 'utf8')
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
const compiled = ts.transpileModule(source, { compilerOptions }).outputText
const local = { exports: {} }
new Function('module', 'exports', 'require', compiled)(local, local.exports, require)
const { verifiedRoadSection, groupVehicleSections } = local.exports
const progressSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'transit', 'vehicleProgress.ts'), 'utf8')
const progressModule = { exports: {} }
new Function('module', 'exports', 'require', ts.transpileModule(progressSource, { compilerOptions }).outputText)(progressModule, progressModule.exports, require)
const { vehicleTransitions } = progressModule.exports
const p = (longitude) => ({ latitude: 37.6, longitude })
const stop = (sequence, longitude) => ({ sequence, id: { value: String(sequence) }, position: p(longitude) })
const vehicle = { sectionVerified: true, stationSequence: 2, currentStopId: { value: '2' }, nextStopId: { value: '3' } }

test('ordered GBIS stops anchor an actual road-shape section', () => {
  const points = [p(126.8), p(126.801), p(126.802), p(126.803)]
  const section = verifiedRoadSection({ points }, [stop(1, 126.8), stop(2, 126.801), stop(3, 126.802), stop(4, 126.803)], vehicle)
  assert.ok(section && section.length >= 2)
  assert.ok(Math.abs(section[0].longitude - 126.801) < 0.00001)
  assert.ok(Math.abs(section.at(-1).longitude - 126.802) < 0.00001)
})

test('uncertain stop identity, distant stops, and conflicting loop anchors are not drawn', () => {
  const points = [p(126.8), p(126.801), p(126.802)]
  let reason
  assert.equal(verifiedRoadSection({ points }, [stop(2, 126.801), stop(3, 126.802)], { ...vehicle, currentStopId: { value: '9' } },
    (value) => { reason = value }), null)
  assert.equal(reason, 'stop_identity')
  assert.equal(verifiedRoadSection({ points }, [stop(2, 126.801), stop(3, 126.9)], vehicle,
    (value) => { reason = value }), null)
  assert.equal(reason, 'end_anchor_too_far')
  const loop = [p(126.8), p(126.801), p(126.802), p(126.801), p(126.8), p(126.801), p(126.802)]
  assert.equal(verifiedRoadSection({ points: loop }, [stop(2, 126.8), stop(3, 126.801)], vehicle,
    (value) => { reason = value }), null)
  assert.equal(reason, 'ambiguous_loop')
})

test('successive observations are joined by vehicle ID, not row order', () => {
  const routeId = { value: '2001' }
  const prior = [{ vehicleId: '8', routeId, stationSequence: 2, stateCode: 2 }, { vehicleId: '9', routeId, stationSequence: 4, stateCode: 1 }]
  const next = [{ vehicleId: '9', routeId, stationSequence: 4, stateCode: 1 }, { vehicleId: '8', routeId, stationSequence: 3, stateCode: 1 }]
  assert.deepEqual(vehicleTransitions(prior, next), { '8': { fromSequence: 2, toSequence: 3, fromState: 2, toState: 1 } })
})

test('two vehicles on one section share one drawn path, other routes remain separate', () => {
  const path = [p(126.8), p(126.801)]
  const sections = [{ key: 'a:1', routeKey: 'a', stationSequence: 4, path }, { key: 'a:2', routeKey: 'a', stationSequence: 4, path },
    { key: 'b:1', routeKey: 'b', stationSequence: 4, path }]
  const groups = groupVehicleSections(sections)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].map((item) => item.key), ['a:1', 'a:2'])
  assert.deepEqual(groups[1].map((item) => item.key), ['b:1'])
})

test('sanitized Goyang 11 production shape still matches verified vehicles after reference replacement', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
  const verified = captured.vehicles.vehicles.filter((item) => item.sectionVerified)
  assert.equal(captured.shape.shape.points.length, 972)
  assert.equal(captured.stops.stops.length, 104)
  assert.equal(verified.length, 7)
  const matched = (shape, stops) => verified.filter((item) => verifiedRoadSection(shape, stops, item)).length
  assert.equal(matched(captured.shape.shape, captured.stops.stops), 7)
  assert.equal(matched(structuredClone(captured.shape.shape), structuredClone(captured.stops.stops)), 7)
  const mismatched = verified.map((vehicle) => ({ ...vehicle, currentStopId: { ...vehicle.currentStopId, value: '0' } }))
  const reasons = []
  assert.equal(mismatched.filter((vehicle) => verifiedRoadSection(captured.shape.shape, captured.stops.stops, vehicle,
    (reason) => reasons.push(reason))).length, 0)
  assert.deepEqual(reasons, Array(7).fill('stop_identity'))
})
