# 버스트래커 API 아키텍처

## 현재 단계

2단계는 GBIS의 주변 정류장과 정류장별 도착정보만 연결한다. 버스 GPS, 노선 경로, TAGO 및 전국 초정밀 API는 호출하지 않는다. `/api/health`의 `transitData: "not-connected"`는 기존 계약대로 유지한다. 이 값은 실시간 연동 상태를 판정하지 않는다. 키가 없으면 데이터 경로는 503을 반환하며 프런트는 오류를 표시한다.

## 이번 단계의 공식 GBIS 명세

| 기능 | 공식 요청 | JSON 응답에서 사용한 필드 |
| --- | --- | --- |
| [주변 정류장](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusStationSearcharound) | `https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationAroundListv2`; `serviceKey`, WGS84 `x`(경도), `y`(위도), `format=json` | 공공데이터포털 [Swagger](https://www.data.go.kr/data/15080666/openapi.do)의 `msgHeader.queryTime/resultCode/resultMessage`, `msgBody.busStationAroundList`의 `stationId`, `stationName`, `x`, `y`, `mobileNo`, `distance` |
| [정류장 도착정보](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusArrivalStation) | `https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalListv2`; `serviceKey`, `stationId`, `format=json` | 공공데이터포털 [Swagger](https://www.data.go.kr/data/15080346/openapi.do)의 `msgHeader`, `msgBody.busArrivalList`의 `routeId`, `routeName`, `routeDestName`, `flag`, `predictTime1/2`, `locationNo1/2`, `stationId` |

2026-10-09 로컬 승인 키 호출에서 주변 정류장 응답은 HTTP 200, `application/json;charset=UTF-8`였다. 실제 JSON 최상위 필드는 `response`이며 그 안에 `comMsgHeader`, `msgHeader`, `msgBody`가 있다. `msgHeader.resultCode`는 숫자 `0`, `msgBody.busStationAroundList`는 배열이었고 이 좌표에서 39건이 반환되었다. 공식 사이트 표에는 `busStationList`로 적혀 있지만 **실제 이 오퍼레이션은 `busStationAroundList`**를 사용했다. 도착정보 응답도 같은 `response` 감싸개를 사용하며 `msgBody.busArrivalList`는 확인한 정류장에서 단일 객체였다. 파서는 두 목록의 객체와 배열을 모두 검증하여 처리한다.

GBIS 결과코드 `0`은 성공, `4`는 결과 없음으로 처리한다. 공식 공통 코드표의 `23`은 도착정보 없음으로 도착정보 조회에서 빈 목록으로 처리한다. `20`은 잘못된 위치이므로 빈 목록으로 바꾸지 않고 오류를 반환한다. 잘못된 키를 사용한 실제 호출은 HTTP 403, `application/json`, 최상위 `OpenAPI_ServiceResponse.cmmMsgHeader`에 문자열 `returnReasonCode: "30"` 및 `errMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"`를 반환했다. 서버는 이를 응답 구조 오류와 구분해 `UPSTREAM_AUTH_ERROR`로 처리한다. `flag`의 공식 값 `RUN`/`PASS`는 운행 중, `STOP`은 운행 종료, `WAIT`는 회차 대기로 매핑한다. `predictTime1/2`는 분, `locationNo1/2`는 몇 정거장 전을 뜻한다. 누락되거나 음수인 값은 표시하지 않는다. `queriedAt`은 서버가 **실제로 외부 요청을 완료한 시각**이며 캐시가 재사용되면 원래 시각을 유지한다. 이는 차량 위치 갱신 시각이 아니다.

로컬 에뮬레이터에서만 `GBIS_DIAGNOSTIC` 로그가 API 이름, HTTP 상태, Content-Type, 최상위 필드명, 결과코드, 게이트웨이 오류 유형, `msgBody` 필드명과 파싱 실패 단계를 남긴다. 키, 요청 URL, 응답 본문은 기록하지 않는다. 에뮬레이터 밖에서는 이 로그를 출력하지 않는다. `node functions/scripts/inspect-gbis.cjs`는 `functions/.secret.local`을 읽어 동일한 안전한 구조 정보만 출력하는 로컬 점검 도구다. 실제 응답의 행 값이나 키는 출력하지 않는다.

로컬 검증: `npm --prefix functions run typecheck`, `npm --prefix functions run build`, `npm --prefix functions test`, `firebase emulators:start --only hosting,functions --project bustrker` 후 `http://127.0.0.1:5000/api/stops/nearby?lat=37.6584&lng=126.8320`을 호출한다. 2026-10-09 검증에서는 정류장 39건, 그중 첫 정류장의 `/api/stops/{stationId}/arrivals` 응답 1건이 확인되었다. `lat=0&lng=0`은 GBIS 결과코드 20으로 서버가 502 `UPSTREAM_ERROR`를 반환했고 잘못된 위도 문자열은 400 `INVALID_COORDINATES`였다.

## 서버와 데이터 계약

`/api/stops/nearby?lat=37.6584&lng=126.8320` → `{ source, queriedAt, stops }`.

`/api/stops/{stationId}/arrivals` → `{ source, queriedAt, arrivals }`.

`functions/src/transit/domain.ts`의 `TransitId`는 `provider + regionCode + value`로 구성된다. 정류장, 노선, 도착예정의 공통 타입을 공급자별 응답과 분리했다. `gbis.ts`는 GBIS 요청, 결과코드 검사, 응답 검증, 변환을 담당하고 `gbisStopProvider()`가 공통 계약을 구현한다. 서울·인천·TAGO 공급자는 각자의 ID와 응답을 별도 어댑터에서 변환해야 한다. 공급자 간 ID 동일성을 가정하지 않는다.

서버는 좌표를 소수 셋째 자리로 묶어 동일 검색의 중복 요청을 줄인다. 주변 정류장 캐시는 45초, 도착정보 캐시는 10초이며 진행 중인 동일 요청도 공유한다. 상위 API 호출 제한은 8초다. 프런트는 지도 `idle` 이벤트를 320ms 디바운싱하고, 지도 중심이 바뀌면 이전 fetch를 취소한다. 서버 응답이 실패하면 이전 정류장·도착정보를 현재 정보처럼 유지하지 않는다. 목록은 최대 50건, 마커는 확대 수준에 따라 최대 35개이며 동일 정류장 ID와 동일 좌표의 마커를 중복 표시하지 않는다.

## 인증키와 로컬 경로

브라우저는 `/api/`만 호출한다. Vite 개발 서버의 `/api` 프록시는 `127.0.0.1:5000` Firebase Hosting 에뮬레이터로 전달한다. Hosting은 기존 SPA 리라이트보다 먼저 `/api/**`를 `asia-northeast3`의 `api` Cloud Function으로 보낸다. 배포는 하지 않았다.

공공데이터 서비스키는 Functions의 `PUBLIC_DATA_SERVICE_KEY` Secret으로만 읽는다. 에뮬레이터에서는 Git 제외된 `functions/.secret.local`에 같은 이름으로 설정한다. 공공데이터포털의 **일반 인증키(디코딩된 값)**를 넣어야 하며, `URLSearchParams`가 요청 URL에 맞게 인코딩한다. 키를 `VITE_` 변수, React, 문서, 콘솔 로그에 넣지 않는다. 카카오 JavaScript 키 `VITE_KAKAO_MAP_APP_KEY`는 SDK 특성상 브라우저에 보이므로 [카카오 개발자 콘솔](https://developers.kakao.com/)에서 허용 도메인을 제한한다.

## 이후 단계의 공식 명세 메모

- [GBIS 노선 조회](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRoute)는 `routeId`, `routeName`을 제공하고, [노선 형상](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRouteLine)은 `lineSeq`, `x`, `y`를 제공한다.
- [GBIS 위치 조회](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusLocation)는 `stationId`, `stationSeq`, `vehId`, `stateCd` 등을 제공하지만 GPS 좌표 필드는 없다. GPS 마커의 근거로 사용하지 않는다.
- [전국 초정밀](https://www.data.go.kr/data/15157601/openapi.do) 공식 Swagger는 `/mst_info`, `/ps_info`, `/rtm_loc_info`를 정의한다. 실시간 위치에는 `lat`, `lot`, `gthrDt`, `rteId`, `vhclNo` 등이 있다. 실제 단건/다건 응답은 별도 검증이 필요하다.
- [TAGO 위치](https://www.data.go.kr/data/15098533/openapi.do)의 `getRouteAcctoBusLcList`는 `cityCode`, `routeId`로 조회하고 선택적 `gpslati`, `gpslong` 및 `nodeid` 등을 제공한다. TAGO ID를 GBIS ID와 동일시하지 않는다.
