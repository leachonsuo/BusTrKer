const test = require('node:test')
const assert = require('node:assert/strict')
const { parseNearbyStops, parseArrivals, nearbyGbis, TransitApiError } = require('../lib/transit/gbis.js')

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
