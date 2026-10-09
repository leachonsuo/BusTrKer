const test = require('node:test')
const assert = require('node:assert/strict')
const { parsePrecisionLocations, assessFixAge, assessRouteMatch, assessVehicleMatch } = require('../lib/transit/precisionEvidence.js')

const rawRow = { rteId: '219000001', vhclNo: '경기 70 바 1234', gthrDt: '2026-10-09 17:00:00',
  lat: '37.6000', lot: '126.8000', oprDrct: '157' }
const response = (item) => ({ header: { resultCode: 'K0' }, body: { totalCount: Array.isArray(item) ? item.length : 1,
  items: { item } } })

test('precision parser accepts observed single/array JSON and rejects invalid coordinates', () => {
  assert.equal(parsePrecisionLocations(response(rawRow))[0].position.longitude, 126.8)
  assert.equal(parsePrecisionLocations(response([rawRow, { ...rawRow, vhclNo: '경기70바5678' }])).length, 2)
  assert.throws(() => parsePrecisionLocations(response({ ...rawRow, lat: 91 })), /coordinate invalid/)
  assert.throws(() => parsePrecisionLocations({ header: { resultCode: 'K10' } }), /invalid or unsuccessful/)
})

test('timestamp without a confirmed zone cannot be fresh; invalid, future and stale values are blocked', () => {
  const now = Date.parse('2026-10-09T08:01:00Z')
  assert.equal(assessFixAge(rawRow.gthrDt, now, null).status, 'timezone-unknown')
  assert.equal(assessFixAge(rawRow.gthrDt, now, 540).status, 'fresh')
  assert.equal(assessFixAge('2026-10-09T17:00:00+09:00', now, null).status, 'fresh')
  assert.equal(assessFixAge('2026-10-09 17:02:00', now, 540).status, 'future')
  assert.equal(assessFixAge('2026-10-09 16:50:00', now, 540).status, 'stale')
  assert.equal(assessFixAge('2026-02-30 17:00:00', now, 540).status, 'invalid')
  assert.equal(assessFixAge('2026-10-09 17:00:00', now, null).observedAt, null)
})

test('route identity needs region, endpoints and every stop ID in order', () => {
  const gbis = { regionCode: '4128000000', number: '11', start: '성석동', end: '행신역', stopIds: ['1', '2', '3'] }
  assert.equal(assessRouteMatch(gbis, { ...gbis, stopIds: ['1', '2', '3'] }), 'verified')
  assert.equal(assessRouteMatch(gbis, { ...gbis, stopIds: ['1', '3', '2'] }), 'candidate')
  assert.equal(assessRouteMatch(gbis, { ...gbis, regionCode: '1111000000' }), 'unverified')
})

test('vehicle verification requires full unique plate, fresh time and path/section agreement', () => {
  const fix = parsePrecisionLocations(response(rawRow))[0]
  const path = [{ latitude: 37.6, longitude: 126.799 }, { latitude: 37.6, longitude: 126.801 }]
  const input = { fix, gbisPlate: '경기70바1234', routeEvidence: 'verified', matchingGbisPlates: 1,
    matchingPrecisionPlates: 1, routePath: path, currentSection: path,
    nowMs: Date.parse('2026-10-09T08:01:00Z'), confirmedOffsetMinutes: 540 }
  assert.equal(assessVehicleMatch(input), 'verified')
  assert.equal(assessVehicleMatch({ ...input, confirmedOffsetMinutes: null }), 'candidate')
  assert.equal(assessVehicleMatch({ ...input, gbisPlate: '70바1234' }), 'unverified')
  assert.equal(assessVehicleMatch({ ...input, gbisPlate: '1234', fix: { ...fix, vehicleNumber: '1234' } }), 'unverified')
  assert.equal(assessVehicleMatch({ ...input, matchingPrecisionPlates: 2 }), 'candidate')
  assert.equal(assessVehicleMatch({ ...input, currentSection: null }), 'candidate')
  assert.equal(assessVehicleMatch({ ...input, fix: { ...fix, position: { latitude: 38.2, longitude: 126.8 } } }), 'candidate')
})
