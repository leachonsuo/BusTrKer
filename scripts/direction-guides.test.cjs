const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, customRequire = require) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, customRequire)
  return mod.exports
}

const { pickDirectionGuides } = load('src/map/directionGuides.ts')
const transitKey = (id) => `${id.provider}:${id.regionCode}:${id.value}`
const { splitRouteDirections } = load('src/transit/routeDirections.ts', (name) => name === './api' ? { transitKey } : require(name))
const { separateSharedStraightVertices } = load('src/transit/routeShape.ts')
const id = (value) => ({ provider: 'gbis', regionCode: 'gyeonggi', value })
const point = (latitude, longitude) => ({ latitude, longitude })
const screen = (p) => ({ x: (p.longitude - 126.8) * 100_000, y: (37.602 - p.latitude) * 100_000 })

function direction(key, points, sequence) {
  const a = { id: id(`${key}1`), name: `${key} start`, position: points[0], sequence, turnYn: false }
  const b = { id: id(`${key}2`), name: `${key} middle`, position: points[20], sequence: sequence + 1, turnYn: false }
  const c = { id: id(`${key}3`), name: `${key} end`, position: points.at(-1), sequence: sequence + 2, turnYn: false }
  return { key, label: `${key} direction`, startStop: a, endStop: c, stops: [a, b, c],
    shape: { routeId: id('route'), points }, stopSequenceRange: [sequence, sequence + 2],
    shapeIndexRange: [0, points.length - 1], splitConfidence: 'ordered-turn-and-shape' }
}

const east = Array.from({ length: 41 }, (_, i) => point(37.6, 126.8 + i * 0.0001))
const west = Array.from({ length: 41 }, (_, i) => point(37.6001, 126.804 - i * 0.0001))

test('screen-projected tangents point along visit order on parallel opposite directions', () => {
  const guides = pickDirectionGuides([direction('east', east, 1), direction('west', west, 4)], screen,
    550, 400, point(37.60005, 126.801), 20)
  assert.equal(guides.length, 2)
  assert.ok(Math.abs(guides[0].angle) < 1)
  assert.ok(Math.abs(Math.abs(guides[1].angle) - 180) < 1)
  assert.ok(guides.every((guide) => guide.position.latitude !== 37.60005), 'labels sit on route coordinates, not the user marker')
  const centered = pickDirectionGuides([direction('east', east, 1), direction('west', west, 4)], screen,
    550, 400, null, null)
  const user = point(37.60005, 126.8003)
  const nearEdge = pickDirectionGuides([direction('east', east, 1), direction('west', west, 4)], screen,
    550, 400, user, 20)
  const totalDistance = (items) => items.reduce((sum, guide) => sum + Math.hypot(
    (guide.position.longitude - user.longitude) * 88_000,
    (guide.position.latitude - user.latitude) * 111_320), 0)
  assert.ok(totalDistance(nearEdge) < totalDistance(centered),
    `nearby verified road positions take priority: near=${JSON.stringify(nearEdge)}, centered=${JSON.stringify(centered)}`)
})

test('missing or far user position falls back to safe visible road positions', () => {
  const pair = [direction('east', east, 1), direction('west', west, 4)]
  const without = pickDirectionGuides(pair, screen, 550, 400, null, null)
  const far = pickDirectionGuides(pair, screen, 550, 400, point(38.1, 127.2), 20)
  assert.equal(without.length, 2)
  assert.deepEqual(far, without)
  assert.equal(pickDirectionGuides(pair, screen, 220, 400, null, null).length, 0, 'too narrow for two legible labels')
})

test('two nearby shapes with the same travel heading are not presented as opposite journeys', () => {
  const eastAgain = east.map((p) => point(p.latitude + 0.0001, p.longitude))
  assert.deepEqual(pickDirectionGuides([direction('east', east, 1), direction('east-again', eastAgain, 4)],
    screen, 550, 400, null, null), [])
  const guides = pickDirectionGuides([direction('east', east, 1), direction('west', west, 4)],
    screen, 550, 400, point(37.6, 126.802), 10)
  assert.equal(guides.length, 2)
  assert.ok(guides.every((guide) => Math.hypot((guide.position.longitude - 126.802) * 88_000,
    (guide.position.latitude - 37.6) * 111_320) >= 20), 'user marker is not used as a guide anchor')
})

test('turn tangents are skipped while separate roads can still use their own positions', () => {
  const elbow = [...east.slice(0, 21), ...Array.from({ length: 20 }, (_, i) => point(37.6 - (i + 1) * 0.0001, 126.802))]
  const returnRoad = elbow.map((p) => point(p.latitude + 0.0008, p.longitude + 0.0008)).reverse()
  const guides = pickDirectionGuides([direction('elbow', elbow, 1), direction('return', returnRoad, 4)],
    screen, 550, 700, null, null)
  assert.equal(guides.length, 2)
  assert.notEqual(guides[0].position, elbow[20], 'a sharp corner is not represented as a single heading')
  const westFar = west.map((p) => point(p.latitude - 0.0022, p.longitude))
  const narrow = pickDirectionGuides([direction('east', east, 1), direction('west-far', westFar, 4)],
    screen, 390, 700, null, null)
  assert.equal(narrow.length, 2, 'separate roads can use separate rows on a mobile viewport')
})

test('unsafe repeated visits, turn-only positions and unverified directions have no fabricated guide', () => {
  const repeat = [...east.slice(0, 18), ...east.slice(2, 18).reverse(), ...east.slice(18)]
  const ambiguous = direction('repeat', repeat, 1)
  const other = direction('west', west, 4)
  const result = pickDirectionGuides([ambiguous, other], screen, 550, 400, null, null)
  for (const guide of result) if (guide.key === 'repeat') {
    assert.ok(!repeat.some((p, i) => repeat.some((q, j) => Math.abs(i - j) > 10 &&
      p.latitude === q.latitude && p.longitude === q.longitude && guide.position === p)))
  }
  assert.deepEqual(pickDirectionGuides([{ ...ambiguous, splitConfidence: 'unverified' }, other], screen, 550, 400, null, null), [])
  assert.deepEqual(pickDirectionGuides([other], screen, 550, 400, null, null), [])
})

test('occlusion and projection are respected without changing the underlying coordinates', () => {
  const pair = [direction('east', east, 1), direction('west', west, 4)]
  const rotated = (p) => ({ x: (37.602 - p.latitude) * 100_000,
    y: (p.longitude - 126.8) * 100_000 })
  const guides = pickDirectionGuides(pair, rotated, 400, 550, null, null)
  assert.equal(guides.length, 2)
  assert.ok(Math.abs(guides[0].angle - 90) < 1)
  assert.ok(Math.abs(guides[1].angle + 90) < 1)
  const blocked = [{ left: 0, top: 0, right: 550, bottom: 400 }]
  assert.deepEqual(pickDirectionGuides(pair, screen, 550, 400, null, null, blocked), [])
})

test('sanitized Goyang 11 split supplies ordered shapes without a new API request', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
  const shape = separateSharedStraightVertices(fixture.shape.shape).shape
  const split = splitRouteDirections({ id: shape.routeId }, shape, fixture.stops.stops)
  assert.ok(split.directions)
  const points = shape.points
  const westBound = Math.min(...points.map((p) => p.longitude))
  const eastBound = Math.max(...points.map((p) => p.longitude))
  const northBound = Math.max(...points.map((p) => p.latitude))
  const southBound = Math.min(...points.map((p) => p.latitude))
  const project = (p) => ({ x: 100 + (p.longitude - westBound) / (eastBound - westBound) * 1100,
    y: 80 + (northBound - p.latitude) / (northBound - southBound) * 700 })
  const guides = pickDirectionGuides(split.directions, project, 1300, 900, null, null)
  assert.equal(guides.length, 2)
  assert.deepEqual(guides.map((guide) => guide.key), split.directions.map((direction) => direction.key))
  for (const [index, guide] of guides.entries()) {
    assert.ok(split.directions[index].shape.points.includes(guide.position))
    assert.ok(Number.isFinite(guide.angle))
  }
})
