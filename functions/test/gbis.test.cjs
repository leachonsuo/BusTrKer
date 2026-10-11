const test = require('node:test')
const assert = require('node:assert/strict')
const { MemoryBudgetStore, setBudgetStoreForTests } = require('../lib/transit/budget.js')
setBudgetStoreForTests(new MemoryBudgetStore())
const { parseNearbyStops, parseArrivals, parseRouteSearch, parseRouteDetail, parseRouteShape, parseRouteStops, parseVehiclePositions, nearbyGbis, vehiclesGbisRoute, TransitApiError, resetGbisCooldownForTests } = require('../lib/transit/gbis.js')

test('GBIS 주변 정류장: 공식 msgBody 목록을 변환하고 중복 ID를 제거한다', () => {
  const raw = {
    msgHeader: { resultCode: 0, queryTime: '2026-10-09 09:00:00' },
    msgBody: { busStationAroundList: [
      { stationId: 1001, stationName: '테스트 정류장', x: 126.832, y: 37.658, mobileNo: 12345, distance: 120 },
      { stationId: 1001, stationName: '테스트 정류장', x: 126.832, y: 37.658, mobileNo: 12345, distance: 120 },
    ] },
  }
  const stops = parseNearbyStops(raw)
  assert.equal(stops.length, 1)
  assert.deepEqual(stops[0].id, { provider: 'gbis', regionCode: 'gyeonggi', value: '1001' })
  assert.deepEqual(stops[0].position, { latitude: 37.658, longitude: 126.832 })
  assert.equal(stops[0].mobileNo, '12345')
})

test('GBIS 위치 필드가 빈 값이면 정류장을 지도에 올리지 않는다', () => {
  assert.throws(() => parseNearbyStops({ msgHeader: { resultCode: 0 }, msgBody: { busStationAroundList: { stationId: 1001, stationName: '테스트', x: '', y: 37.6 } } }), TransitApiError)
})

test('GBIS 결과 없음 코드는 빈 목록, 다른 실패 코드는 오류이다', () => {
  assert.deepEqual(parseNearbyStops({ msgHeader: { resultCode: 4 } }), [])
  assert.throws(() => parseNearbyStops({ msgHeader: { resultCode: 2 } }), (error) => error.code === 'UPSTREAM_ERROR')
  assert.throws(() => parseNearbyStops({ msgHeader: { resultCode: 0 }, msgBody: {} }), (error) => error.code === 'INVALID_UPSTREAM_RESPONSE')
})

test('GBIS 도착정보의 상태와 두 차량 예정을 분리한다', () => {
  const raw = { msgHeader: { resultCode: 0 }, msgBody: { busArrivalList: {
    stationId: 1001, routeId: 2001, routeName: '100', flag: 'RUN', predictTime1: 4, locationNo1: 2, predictTime2: 9, locationNo2: 5,
  } } }
  const arrivals = parseArrivals(raw, '1001')
  assert.equal(arrivals[0].operationStatus, 'running')
  assert.deepEqual(arrivals[0].visits, [{ minutesUntilArrival: 4, stopsAway: 2 }, { minutesUntilArrival: 9, stopsAway: 5 }])
  assert.throws(() => parseArrivals(raw, '9999'), (error) => error.code === 'INVALID_UPSTREAM_RESPONSE')
})

test('실제 GBIS JSON의 response 감싸개와 배열형 주변 정류장을 변환한다', () => {
  const raw = { response: {
    comMsgHeader: {},
    msgHeader: { queryTime: '2026-10-09 09:00:00', resultCode: 0, resultMessage: '정상' },
    msgBody: { busStationAroundList: [
      { stationId: 1001, stationName: '테스트 정류장', x: 126.832, y: 37.6584, mobileNo: 12345, distance: 120 },
    ] },
  } }
  assert.deepEqual(parseNearbyStops(raw)[0].position, { latitude: 37.6584, longitude: 126.832 })
})

test('실제 GBIS JSON의 response 감싸개와 객체형 도착정보를 변환한다', () => {
  const raw = { response: {
    comMsgHeader: {}, msgHeader: { resultCode: 0 }, msgBody: { busArrivalList: {
      stationId: 1001, routeId: 2001, routeName: '100', flag: 'RUN', predictTime1: 4, locationNo1: 2,
    } },
  } }
  assert.deepEqual(parseArrivals(raw, '1001')[0].visits, [{ minutesUntilArrival: 4, stopsAway: 2 }])
})

test('결과 없음과 잘못된 위치 및 잘못된 감싸개를 구별한다', () => {
  assert.deepEqual(parseNearbyStops({ response: { msgHeader: { resultCode: 4 } } }), [])
  assert.deepEqual(parseArrivals({ response: { msgHeader: { resultCode: 23 } } }, '1001'), [])
  assert.throws(() => parseNearbyStops({ response: { msgHeader: { resultCode: 20 } } }), (error) => error.code === 'UPSTREAM_ERROR')
  assert.throws(() => parseNearbyStops({ response: {} }), (error) => error.code === 'INVALID_UPSTREAM_RESPONSE' && error.stage === 'msgHeader')
  assert.throws(() => parseNearbyStops({ response: { msgHeader: {}, msgBody: {} } }), (error) => error.code === 'INVALID_UPSTREAM_RESPONSE' && error.stage === 'result-code')
  assert.throws(() => parseNearbyStops({ response: { msgHeader: { resultCode: 0 }, msgBody: { busStationAroundList: null } } }), (error) => error.code === 'INVALID_UPSTREAM_RESPONSE' && error.stage === 'list-rows')
})

test('공공데이터 게이트웨이 인증 오류를 응답 구조 오류와 구별한다', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => new Response(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: {
    errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30',
  } } }), { status: 403, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(nearbyGbis({ latitude: 37.6584, longitude: 126.832 }, 'invalid-key'),
      (error) => error.code === 'UPSTREAM_AUTH_ERROR')
  } finally {
    global.fetch = originalFetch
  }
})

const wrapped = (name, value) => ({ response: { comMsgHeader: {}, msgHeader: { resultCode: 0 }, msgBody: { [name]: value } } })

test('GBIS 위치 단일 객체, 배열, 결과 없음과 중복 차량을 처리한다', () => {
  const stops = [119, 120, 121].map((sequence) => ({ sequence, id: { provider: 'gbis', regionCode: 'gyeonggi', value: String(1000 + sequence) } }))
  const row = { routeId: 229000277, vehId: 7031, stationId: 1119, stationSeq: 119, stateCd: 2 }
  const vehicle = parseVehiclePositions(wrapped('busLocationList', row), '229000277', stops)[0]
  assert.equal(vehicle.vehicleId, '7031')
  assert.equal(vehicle.sectionVerified, true)
  assert.equal(vehicle.nextStopId.value, '1120')
  assert.equal(vehicle.observedAt, null)
  assert.equal(parseVehiclePositions(wrapped('busLocationList', [row, row]), '229000277', stops).length, 1)
  assert.deepEqual(parseVehiclePositions({ response: { msgHeader: { resultCode: 4 } } }, '229000277', stops), [])
})

test('정류장 불일치 및 미확인 상태는 구간을 표시하지 않는다', () => {
  const stops = [1, 2].map((sequence) => ({ sequence, id: { provider: 'gbis', regionCode: 'gyeonggi', value: String(1000 + sequence) } }))
  const row = { routeId: 2001, vehId: 3001, stationId: 1001, stationSeq: 1, stateCd: 2 }
  assert.equal(parseVehiclePositions(wrapped('busLocationList', { ...row, stationId: 9999 }), '2001', stops)[0].sectionVerified, false)
  assert.equal(parseVehiclePositions(wrapped('busLocationList', { ...row, stateCd: 0 }), '2001', stops)[0].sectionVerified, false)
  assert.equal(parseVehiclePositions(wrapped('busLocationList', { ...row, stateCd: 1 }), '2001', stops)[0].sectionVerified, false)
  assert.equal(parseVehiclePositions(wrapped('busLocationList', row), '2001', [{ ...stops[0], turnYn: true }, stops[1]])[0].sectionVerified, false)
  assert.throws(() => parseVehiclePositions(wrapped('busLocationList', { ...row, routeId: 9999 }), '2001', stops), (error) => error.stage === 'vehicle-fields')
  assert.throws(() => parseVehiclePositions(wrapped('busLocationList', { ...row, vehId: '' }), '2001', stops), (error) => error.stage === 'vehicle-fields')
})

test('동일 노선 동시 차량 요청은 외부 요청을 합치고 빈 차량이면 정류장을 추가 조회하지 않는다', async () => {
  const originalFetch = global.fetch
  let count = 0
  global.fetch = async () => {
    count++
    return new Response(JSON.stringify({ response: { msgHeader: { resultCode: 4 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const [a, b] = await Promise.all([vehiclesGbisRoute('999999991', 'test-key'), vehiclesGbisRoute('999999991', 'test-key')])
    assert.equal(count, 1)
    assert.deepEqual(a.vehicles, [])
    assert.deepEqual(a, b)
  } finally { global.fetch = originalFetch }
})

test('공공데이터 호출량 초과 응답은 재시도 간격 조정 가능한 429로 구분한다', async () => {
  const originalFetch = global.fetch
  let requests = 0
  global.fetch = async () => { requests++; return new Response(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: {
    errMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR', returnReasonCode: '22',
  } } }), { status: 403, headers: { 'content-type': 'application/json' } }) }
  try {
    await assert.rejects(vehiclesGbisRoute('999999992', 'test-key'),
      (error) => error.code === 'UPSTREAM_RATE_LIMITED' && error.status === 429)
    await assert.rejects(vehiclesGbisRoute('999999993', 'test-key'),
      (error) => error.code === 'UPSTREAM_RATE_LIMITED' && error.status === 429)
    assert.equal(requests, 1, 'the per-process 429 cooldown prevents a second upstream call')
  } finally { global.fetch = originalFetch; resetGbisCooldownForTests() }
})

test('GBIS 노선 검색은 실제 routeId로 단건·다건을 구분한다', () => {
  const row = { routeId: 2001, routeName: '11', startStationName: '기점', endStationName: '종점', routeTypeName: '일반', regionName: '고양' }
  assert.equal(parseRouteSearch(wrapped('busRouteList', row))[0].id.value, '2001')
  const routes = parseRouteSearch(wrapped('busRouteList', [row, { ...row, routeId: 2002 }, row]))
  assert.deepEqual(routes.map((route) => route.id.value), ['2001', '2002'])
  assert.deepEqual(parseRouteSearch({ response: { msgHeader: { resultCode: 4 } } }), [])
  assert.throws(() => parseRouteSearch(wrapped('busRouteList', { routeName: '11' })), (error) => error.stage === 'route-fields')
})

test('GBIS 상세정보는 요청 routeId와 대조한다', () => {
  const raw = wrapped('busRouteInfoItem', { routeId: 2001, routeName: '11', startStationName: '기점' })
  assert.equal(parseRouteDetail(raw, '2001').startName, '기점')
  assert.throws(() => parseRouteDetail(raw, '2002'), (error) => error.stage === 'route-detail-id')
  assert.equal(parseRouteDetail({ response: { msgHeader: { resultCode: 4 } } }, '2001'), null)
})

test('GBIS 노선형상은 lineSeq로 정렬하고 WGS84 경도를 x로 읽는다', () => {
  const raw = wrapped('busRouteLineList', [
    { lineSeq: 3, x: 126.834, y: 37.66 }, { lineSeq: 1, x: 126.832, y: 37.658 }, { lineSeq: 2, x: 126.833, y: 37.659 },
  ])
  assert.deepEqual(parseRouteShape(raw, '2001').points, [
    { latitude: 37.658, longitude: 126.832 }, { latitude: 37.659, longitude: 126.833 }, { latitude: 37.66, longitude: 126.834 },
  ])
  assert.equal(parseRouteShape({ response: { msgHeader: { resultCode: 4 } } }, '2001'), null)
  assert.throws(() => parseRouteShape(wrapped('busRouteLineList', [{ lineSeq: 1, x: 200, y: 37.6 }]), '2001'), (error) => error.stage === 'route-line-fields')
  assert.throws(() => parseRouteShape(wrapped('busRouteLineList', [{ lineSeq: 1, x: 126.8, y: 37.6 }, { lineSeq: 1, x: 126.9, y: 37.7 }]), '2001'), (error) => error.stage === 'route-line-fields')
})

test('GBIS 경유 정류장은 stationSeq 순서와 회차점을 유지한다', () => {
  const raw = wrapped('busRouteStationList', [
    { stationSeq: 2, stationId: 1002, stationName: '둘째', x: 126.833, y: 37.659, turnYn: 'Y', turnSeq: 2 },
    { stationSeq: 1, stationId: 1001, stationName: '첫째', x: 126.832, y: 37.658, turnYn: 'N', turnSeq: 0 },
  ])
  const stops = parseRouteStops(raw)
  assert.deepEqual(stops.map((stop) => stop.id.value), ['1001', '1002'])
  assert.equal(stops[1].turnYn, true)
  assert.throws(() => parseRouteStops(wrapped('busRouteStationList', { stationSeq: 1, stationId: 1001, stationName: 'A', x: '', y: 37.6 })), (error) => error.stage === 'route-stop-fields')
})
