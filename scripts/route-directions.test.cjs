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
const directions = load('src/transit/routeDirections.ts', (name) => name === './api' ? { transitKey } : require(name))
const { separateSharedStraightVertices } = load('src/transit/routeShape.ts')
const { verifiedRoadSection } = load('src/transit/routeSegments.ts')
const { analyze } = require('./diagnose-route-directions.cjs')
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
const route = { id: fixture.shape.shape.routeId }
const shape = separateSharedStraightVertices(fixture.shape.shape).shape
const stops = fixture.stops.stops
const route30Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-30-sanitized.json'), 'utf8'))
const route799Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gbis-229000071-sanitized.json'), 'utf8'))
const route036Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gbis-241293003-sanitized.json'), 'utf8'))

test('GBIS 799 keeps the full-route fallback when two turn boundaries both fit ordered visits', () => {
  const { detail, shape, stops } = route799Fixture
  assert.equal(detail.route.id.value, '229000071')
  assert.equal(shape.shape.points.length, 1466)
  assert.equal(stops.stops.length, 149)
  assert.equal(stops.stops.filter((stop) => stop.turnYn).length, 1)
  const split = directions.splitRouteDirections(detail.route, shape.shape, stops.stops)
  assert.equal(split.directions, null)
  assert.equal(split.code, 'AMBIGUOUS_TURN_MATCH')
  const diagnosis = analyze(route799Fixture)
  assert.deepEqual(diagnosis.turnBoundaries.map((group) => group.some((candidate) =>
    candidate.outbound.completePathExists && candidate.inbound.completePathExists)), [true, true])
})

test('GBIS 036 selects the sole turn boundary supported by all ordered visits', () => {
  const { detail, shape, stops } = route036Fixture
  assert.equal(detail.route.id.value, '241293003')
  assert.equal(detail.route.name, '036')
  assert.equal(shape.shape.points.length, 752)
  assert.equal(stops.stops.length, 69)
  const original = JSON.stringify({ shape, stops })
  const split = directions.splitRouteDirections(detail.route, shape.shape, stops.stops)
  assert.equal(split.reason, null)
  assert.deepEqual(split.directions.map((direction) => direction.stopSequenceRange), [[1, 35], [35, 69]])
  assert.deepEqual(split.directions.map((direction) => direction.shapeIndexRange), [[0, 369], [369, 751]])
  assert.equal(JSON.stringify({ shape, stops }), original)
  const diagnosis = analyze(route036Fixture)
  assert.deepEqual(diagnosis.turnBoundaries.map((group) => group.some((candidate) =>
    candidate.outbound.completePathExists && candidate.inbound.completePathExists)), [true, false])
  assert.ok(diagnosis.turnBoundaries[1][0].inbound.firstUnreachable.nearest.errorMeters > 35)
  const [outbound, inbound] = split.directions
  const vehicleAt = (sequence) => ({ routeId: detail.route.id, stationSequence: sequence,
    currentStopId: stops.stops[sequence - 1].id, nextStopId: stops.stops[sequence].id, sectionVerified: true })
  for (const sequence of [33, 34, 35, 36, 37, 38]) {
    const vehicle = vehicleAt(sequence)
    const direction = sequence < 35 ? outbound : inbound
    const other = sequence < 35 ? inbound : outbound
    assert.equal(directions.vehicleBelongsToDirection(vehicle, direction), true)
    assert.equal(directions.vehicleBelongsToDirection(vehicle, other), false)
    let rejection = null
    const path = verifiedRoadSection(direction.shape, direction.stops, vehicle, (reason) => { rejection = reason })
    if (sequence === 35 || sequence === 36) {
      assert.equal(path, null)
      assert.equal(rejection, 'ambiguous_loop')
    } else assert.ok(path)
  }
})

test('GBIS 30 splits at its observed turn despite repeated nearby shape visits', () => {
  const route30 = route30Fixture.detail.route
  const shape30 = route30Fixture.shape.shape
  const stops30 = route30Fixture.stops.stops
  assert.equal(route30.id.value, '229000010')
  assert.equal(shape30.points.length, 2836)
  assert.equal(stops30.length, 245)
  const original = JSON.stringify({ shape30, stops30 })
  const split = directions.splitRouteDirections(route30, shape30, stops30)
  assert.equal(split.reason, null)
  assert.deepEqual(split.directions.map((direction) => direction.stopSequenceRange), [[1, 123], [123, 245]])
  assert.deepEqual(split.directions.map((direction) => direction.shapeIndexRange), [[0, 1423], [1423, 2835]])
  assert.equal(JSON.stringify({ shape30, stops30 }), original)
  const vehicleAt = (sequence) => ({ routeId: route30.id, stationSequence: sequence,
    currentStopId: stops30[sequence - 1].id, nextStopId: stops30[sequence].id, sectionVerified: true })
  const [outbound, inbound] = split.directions
  for (const sequence of [30, 31, 35, 36, 37]) {
    const vehicle = vehicleAt(sequence)
    assert.equal(directions.vehicleBelongsToDirection(vehicle, outbound), true)
    assert.equal(directions.vehicleBelongsToDirection(vehicle, inbound), false)
  }
  for (const sequence of [129, 130, 131, 132, 210, 211, 212]) {
    const vehicle = vehicleAt(sequence)
    assert.equal(directions.vehicleBelongsToDirection(vehicle, inbound), true)
    assert.equal(directions.vehicleBelongsToDirection(vehicle, outbound), false)
  }
  for (const sequence of [30, 31, 37, 129, 130, 131, 132, 212]) {
    const direction = sequence < 123 ? outbound : inbound
    assert.ok(verifiedRoadSection(direction.shape, direction.stops, vehicleAt(sequence)))
  }
  for (const sequence of [35, 36, 210, 211]) {
    const direction = sequence < 123 ? outbound : inbound
    let rejection = null
    assert.equal(verifiedRoadSection(direction.shape, direction.stops, vehicleAt(sequence), (reason) => { rejection = reason }), null)
    assert.equal(rejection, 'ambiguous_loop')
  }
})

test('GBIS 30 still falls back for missing turn, distant stop, or no ordered candidate chain', () => {
  const route30 = route30Fixture.detail.route
  const shape30 = route30Fixture.shape.shape
  const stops30 = route30Fixture.stops.stops
  const withoutTurn = stops30.map((stop) => ({ ...stop, turnYn: false, turnSequence: null }))
  assert.equal(directions.splitRouteDirections(route30, shape30, withoutTurn).code, 'NO_TURN_BOUNDARY')
  const farStop = stops30.map((stop) => stop.sequence === 31 ? { ...stop,
    position: { ...stop.position, latitude: stop.position.latitude + 0.01 } } : stop)
  assert.equal(directions.splitRouteDirections(route30, shape30, farStop).code, 'STOP_TOO_FAR')
  const reversed = stops30.map((stop) => stop.sequence === 30 ? { ...stop, position: stops30[31].position } :
    stop.sequence === 32 ? { ...stop, position: stops30[29].position } : stop)
  assert.equal(directions.splitRouteDirections(route30, shape30, reversed).code, 'STOP_SHAPE_SEQUENCE_MISMATCH')
})

test('saved 30 and 036 visits keep full-shape validation before direction display filtering', () => {
  for (const [fixture, safe, ambiguous] of [
    [route30Fixture, [30, 129], [35, 36, 210, 211]],
    [route036Fixture, [33, 38], [35, 36]],
  ]) {
    const route = fixture.detail.route, shape = fixture.shape.shape, stops = fixture.stops.stops
    const split = directions.splitRouteDirections(route, shape, stops)
    assert.ok(split.directions)
    const vehicleAt = (sequence) => ({ routeId: route.id, stationSequence: sequence,
      currentStopId: stops[sequence - 1].id, nextStopId: stops[sequence].id, sectionVerified: true })
    for (const sequence of safe) {
      const vehicle = vehicleAt(sequence)
      const matching = split.directions.filter((direction) => directions.vehicleBelongsToDirection(vehicle, direction))
      assert.equal(matching.length, 1)
      assert.ok(verifiedRoadSection(shape, stops, vehicle), `${route.name} ${sequence}: full route`)
      assert.ok(verifiedRoadSection(matching[0].shape, matching[0].stops, vehicle), `${route.name} ${sequence}: selected direction`)
    }
    for (const sequence of ambiguous) {
      const vehicle = vehicleAt(sequence)
      let reason = null
      assert.equal(verifiedRoadSection(shape, stops, vehicle, (code) => { reason = code }), null)
      assert.equal(reason, 'ambiguous_loop')
    }
  }
})

test('Goyang 11 uses its unique observed turn and all 104 ordered visits', () => {
  const source = JSON.stringify({ shape, stops })
  const split = directions.splitRouteDirections(route, shape, stops)
  assert.equal(split.reason, null)
  const [outbound, inbound] = split.directions
  assert.deepEqual(outbound.shapeIndexRange, [0, 482])
  assert.deepEqual(inbound.shapeIndexRange, [482, 971])
  assert.deepEqual(outbound.stopSequenceRange, [1, 52])
  assert.deepEqual(inbound.stopSequenceRange, [52, 104])
  assert.equal(outbound.label, '행신역 방면')
  assert.equal(inbound.label, '성석동 방면')
  assert.equal(outbound.stops.length, 52)
  assert.equal(inbound.stops.length, 53)
  assert.deepEqual(outbound.shape.points.at(-1), inbound.shape.points[0])
  assert.equal(JSON.stringify({ shape, stops }), source)
})

test('unsupported turn metadata or inconsistent visit order never creates a direction', () => {
  const noTurn = stops.map((stop) => ({ ...stop, turnYn: false, turnSequence: null }))
  assert.equal(directions.splitRouteDirections(route, shape, noTurn).directions, null)
  const twoTurns = stops.map((stop) => ({ ...stop, turnYn: stop.sequence === 52 || stop.sequence === 53 }))
  assert.equal(directions.splitRouteDirections(route, shape, twoTurns).directions, null)
  const swapped = [...stops]
  ;[swapped[35], swapped[36]] = [swapped[36], swapped[35]]
  swapped[35] = { ...swapped[35], sequence: 36 }
  swapped[36] = { ...swapped[36], sequence: 37 }
  assert.equal(directions.splitRouteDirections(route, shape, swapped).directions, null)
  assert.equal(directions.splitRouteDirections(route, { ...shape, routeId: { ...route.id, value: 'other' } }, stops).directions, null)
})

test('boarding distance is calculated from actual ordered stops, without auto-selecting a direction', () => {
  const [outbound, inbound] = directions.splitRouteDirections(route, shape, stops).directions
  const point = outbound.stops[31].position
  const closest = directions.nearestBoardingStop(outbound, point)
  assert.equal(closest.stop.sequence, 32)
  assert.equal(closest.meters, 0)
  const east = (meters) => ({ latitude: point.latitude, longitude: point.longitude + meters / (111_320 * Math.cos(point.latitude * Math.PI / 180)) })
  for (const meters of [100, 500, 600, 2000]) {
    assert.ok(Math.abs(directions.distanceMeters(point, east(meters)) - meters) < 0.1)
  }
  const singleBoarding = { ...outbound, stops: [outbound.stops[31], outbound.endStop] }
  for (const meters of [100, 500, 600]) assert.equal(directions.hasNearbyBoardingStop([singleBoarding], east(meters), 30), true)
  assert.equal(directions.hasNearbyBoardingStop([singleBoarding], east(600.2), 30), false)
  assert.equal(directions.hasNearbyBoardingStop([singleBoarding], east(2000), 30), false)
  assert.equal(directions.hasNearbyBoardingStop([singleBoarding], point, 200), false)
  assert.equal(directions.hasNearbyBoardingStop([singleBoarding], null, null), false)
  assert.equal(inbound.stops[0].sequence, 52)
})

test('only verified vehicles with matching consecutive visit identities belong to their direction', () => {
  const [outbound, inbound] = directions.splitRouteDirections(route, shape, stops).directions
  const verified = fixture.vehicles.vehicles.filter((vehicle) => vehicle.sectionVerified)
  assert.deepEqual(verified.filter((vehicle) => directions.vehicleBelongsToDirection(vehicle, outbound)).map((vehicle) => vehicle.stationSequence), [6, 18])
  assert.deepEqual(verified.filter((vehicle) => directions.vehicleBelongsToDirection(vehicle, inbound)).map((vehicle) => vehicle.stationSequence), [65, 67, 70, 77, 96])
  for (const direction of [outbound, inbound]) for (const vehicle of verified.filter((item) => directions.vehicleBelongsToDirection(item, direction))) {
    assert.ok(verifiedRoadSection(shape, stops, vehicle))
    assert.ok(verifiedRoadSection(direction.shape, direction.stops, vehicle))
    assert.equal(directions.vehicleBelongsToDirection({ ...vehicle, nextStopId: null }, direction), false)
    assert.equal(directions.vehicleBelongsToDirection({ ...vehicle, sectionVerified: false }, direction), false)
    assert.equal(directions.vehicleBelongsToDirection({ ...vehicle, routeId: { ...vehicle.routeId, value: 'other' } }, direction), false)
  }
})

test('repeated stop IDs remain separate visits and direction arrows follow each ordered shape', () => {
  const repeated = stops.map((stop) => stop.sequence === 65 ? { ...stop, id: stops[5].id } : stop)
  const split = directions.splitRouteDirections(route, shape, repeated)
  assert.ok(split.directions)
  const [outbound, inbound] = split.directions
  assert.equal(outbound.stops[5].id.value, inbound.stops.find((stop) => stop.sequence === 65).id.value)
  const original = fixture.vehicles.vehicles.find((vehicle) => vehicle.stationSequence === 65 && vehicle.sectionVerified)
  const repeatedVisitVehicle = { ...original, currentStopId: stops[5].id }
  assert.equal(directions.vehicleBelongsToDirection(repeatedVisitVehicle, inbound), true)
  assert.equal(directions.vehicleBelongsToDirection(repeatedVisitVehicle, outbound), false)
  assert.equal(directions.boardingDirectionArrow(outbound, outbound.stops[5])?.length, 1)
  assert.equal(directions.boardingDirectionArrow(inbound, inbound.stops[13])?.length, 1)
  assert.equal(directions.boardingDirectionArrow(outbound, outbound.endStop), null)
})
