const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadLocal(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const local = { exports: {} }
  new Function('module', 'exports', 'require', compiled)(local, local.exports, require)
  return local.exports
}

const { separateSharedStraightVertices } = loadLocal('src/transit/routeShape.ts')
const { verifiedRoadSection } = loadLocal('src/transit/routeSegments.ts')
const { inspectRegion, intersections } = require('./diagnose-route-shape-detail.cjs')
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
const original = fixture.shape.shape
const meters = (a, b) => Math.hypot((a.latitude - b.latitude) * 111_320,
  (a.longitude - b.longitude) * 111_320 * Math.cos(a.latitude * Math.PI / 180))

test('11번 왕복 직진 구간의 공통 중심점만 두 차로로 분리하고 순번을 유지한다', () => {
  const source = JSON.stringify(original)
  const { shape, correctedPairs } = separateSharedStraightVertices(original)
  assert.equal(correctedPairs, 58)
  assert.equal(shape.points.length, 972)
  assert.deepEqual(shape.routeId, original.routeId)
  assert.equal(JSON.stringify(original), source, 'input must remain immutable')
  const changed = shape.points.flatMap((point, index) => point.latitude !== original.points[index].latitude ||
    point.longitude !== original.points[index].longitude ? [index] : [])
  assert.equal(changed.length, correctedPairs * 2)
  assert.ok(changed.every((index) => meters(shape.points[index], original.points[index]) <= 8.01))
  for (const index of [2, 42, 61, 344, 416, 548, 910, 929, 969]) {
    assert.deepEqual(shape.points[index], original.points[index], `real turn/junction ${index} must remain`)
  }
  for (const [outbound, inbound] of [[11, 960], [18, 953], [71, 900]]) {
    assert.deepEqual(original.points[outbound], original.points[inbound])
    assert.ok(meters(shape.points[outbound], shape.points[inbound]) >= 4)
  }
  assert.equal(separateSharedStraightVertices(shape).correctedPairs, 0, 'normalization must be idempotent')
})

test('교차로와 회차처럼 왕복이 실제로 만나는 좌표는 유지한다', () => {
  const { shape } = separateSharedStraightVertices(original)
  for (const [outbound, inbound] of [[2, 969], [42, 929], [61, 910], [344, 626], [416, 548]]) {
    assert.deepEqual(shape.points[outbound], original.points[outbound])
    assert.deepEqual(shape.points[inbound], original.points[inbound])
  }
  const singlePass = { routeId: original.routeId, points: original.points.slice(0, 80) }
  assert.equal(separateSharedStraightVertices(singlePass).shape, singlePass)
  const otherProvider = { ...original, routeId: { ...original.routeId, provider: 'tago' } }
  assert.equal(separateSharedStraightVertices(otherProvider).shape, otherProvider)
  const unverifiedRoute = { ...original, routeId: { ...original.routeId, value: '219000002' } }
  assert.equal(separateSharedStraightVertices(unverifiedRoute).shape, unverifiedRoute)
})

test('보정 형상에서도 실제 11번 검증 차량 7대의 구간 매칭이 유지된다', () => {
  const { shape } = separateSharedStraightVertices(original)
  const verified = fixture.vehicles.vehicles.filter((vehicle) => vehicle.sectionVerified)
  assert.equal(verified.length, 7)
  for (const vehicle of verified) {
    const before = verifiedRoadSection(original, fixture.stops.stops, vehicle)
    const after = verifiedRoadSection(shape, fixture.stops.stops, vehicle)
    assert.ok(before && before.length >= 2)
    assert.ok(after && after.length >= 2)
    assert.ok(meters(before[0], after[0]) <= 8.01)
    assert.ok(meters(before.at(-1), after.at(-1)) <= 8.01)
  }
})

test('the large third-circle detour is ordered source geometry, not a new correction or jump', () => {
  const { shape, correctedPairs } = separateSharedStraightVertices(original)
  const detail = inspectRegion('thirdLarge')
  assert.equal(correctedPairs, 58)
  assert.deepEqual(detail.passes, [[336, 349], [615, 638]])
  assert.deepEqual([344, 620, 626].map((index) => original.points[index]),
    [original.points[344], original.points[344], original.points[344]])
  assert.deepEqual(original.points[340], original.points[630])
  assert.deepEqual([344, 620, 623, 626, 630].map((index) => shape.points[index]),
    [344, 620, 623, 626, 630].map((index) => original.points[index]))
  const length = (start, end) => Array.from({ length: end - start }, (_, offset) =>
    meters(original.points[start + offset], original.points[start + offset + 1])).reduce((sum, value) => sum + value, 0)
  assert.ok(length(620, 623) > 185 && length(620, 623) < 200)
  assert.ok(length(623, 626) > 185 && length(623, 626) < 200)
  assert.deepEqual(detail.stops.map((stop) => stop.sequence), [36, 37, 67, 68])
  assert.ok(detail.stops.find((stop) => stop.sequence === 36).nearestIndexInPass < 344)
  assert.ok(detail.stops.find((stop) => stop.sequence === 68).nearestIndexInPass > 626)
  assert.equal(detail.intersections.filter((entry) => entry.kind === 'interior').length, 0)
  assert.equal(detail.correctedIntersections.filter((entry) => entry.kind === 'interior').length, 0)
  assert.deepEqual(detail.rows.filter((row) => row.movedMeters > 0).map((row) => row.index), [347, 617])
})

test('each marked smaller circle keeps road turns and separates only previously verified points', () => {
  const regions = [
    ['first', [283, 686]], ['second', [300, 670]],
    ['thirdSmall', [319, 651, 659]], ['thirdMiddle', []],
  ]
  for (const [name, moved] of regions) {
    const report = inspectRegion(name)
    assert.deepEqual(report.rows.filter((row) => row.movedMeters > 0).map((row) => row.index), moved, name)
    assert.equal(report.correctedIntersections.filter((entry) => entry.kind === 'interior').length, 0, name)
  }
  const { shape } = separateSharedStraightVertices(original)
  for (const index of [294, 676, 327, 644, 335, 635, 340, 630, 344, 620, 623, 626]) {
    assert.deepEqual(shape.points[index], original.points[index], `preserve original bend or uncertain shared vertex ${index}`)
  }
})

test('all 58 existing pair corrections preserve the global path order without strict X crossings', () => {
  const { shape } = separateSharedStraightVertices(original)
  for (const [label, points] of [['source', original.points], ['adjusted', shape.points]]) {
    const crossings = intersections(points, [[0, points.length - 1]])
    assert.equal(crossings.filter((entry) => entry.kind === 'interior').length, 0, label)
  }
})
