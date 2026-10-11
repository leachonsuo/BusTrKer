const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, customRequire = require) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText
  const local = { exports: {} }
  new Function('module', 'exports', 'require', code)(local, local.exports, customRequire)
  return local.exports
}
const transitKey = (id) => `${id.provider}:${id.regionCode}:${id.value}`
const { splitRouteDirections } = load('src/transit/routeDirections.ts', (name) => name === './api' ? { transitKey } : require(name))
const { routePreview } = load('src/transit/routePreview.ts')
const { separateSharedStraightVertices } = load('src/transit/routeShape.ts')
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))

test('Goyang 11 preview reuses only its first ordered direction without changing coordinates', () => {
  const shape = separateSharedStraightVertices(fixture.shape.shape).shape
  const split = splitRouteDirections({ id: shape.routeId }, shape, fixture.stops.stops)
  assert.ok(split.directions)
  const preview = routePreview(shape, split)
  assert.equal(preview.source, 'first-direction')
  assert.equal(preview.directionLabel, '행신역 방면')
  assert.equal(preview.shape, split.directions[0].shape)
  assert.notEqual(preview.shape, split.directions[1].shape)
  assert.equal(preview.shape.points.length, 483)
  assert.deepEqual(preview.shape.points, shape.points.slice(0, 483))
})

test('another supported GBIS route uses its own first direction and ambiguous routes keep a full-shape fallback', () => {
  const id = (value) => ({ provider: 'gbis', regionCode: 'gyeonggi', value })
  const points = Array.from({ length: 7 }, (_, index) => ({ latitude: 37.6 + index * 0.001,
    longitude: 126.8 + index * 0.001 }))
  const shape = { routeId: id('2002'), points }
  const stops = [0, 2, 4, 6].map((pointIndex, index) => ({ id: id(String(3001 + index)), name: `정류장 ${index + 1}`,
    position: points[pointIndex], sequence: index + 1, turnYn: index === 2,
    turnSequence: index === 2 ? 3 : null }))
  const split = splitRouteDirections({ id: shape.routeId }, shape, stops)
  assert.ok(split.directions)
  const preview = routePreview(shape, split)
  assert.equal(preview.shape, split.directions[0].shape)
  assert.deepEqual(preview.shape.points, points.slice(0, 5))
  assert.equal(routePreview(shape, undefined), null, 'pending stops cannot be guessed')
  const unavailable = splitRouteDirections({ id: shape.routeId }, shape,
    stops.map((stop) => ({ ...stop, turnYn: false, turnSequence: null })))
  assert.equal(unavailable.directions, null)
  assert.deepEqual(routePreview(shape, unavailable), { shape, source: 'fallback-full-route', directionLabel: null })
  assert.equal(routePreview(shape, undefined, true).shape, shape, 'failed stops retain the full overview')
})
