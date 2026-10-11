# 버스트래커 API 아키텍처

## 현재 단계

3-2단계까지 기존 정류장·도착정보와 노선 기능에 GBIS 차량 위치 목록 및 검증된 정류장 간 운행 구간을 추가했다. 3-3단계에서는 초정밀 GPS 신선도, 고양시 11번의 노선·차량 대응, TAGO 접근 상태를 검증했다. 대응되는 차량번호를 찾았지만 GPS 시각이 오래되고 시간대도 명시되지 않아 현재 위치 마커는 활성화하지 않는다. 4-2단계에서는 호출량·지도 갱신·오류 복구를 개선했으며 GPS 공급자를 새로 연결하지 않았다. `/api/health`의 `transitData: "not-connected"`는 기존 계약대로 유지한다. 이 값은 실시간 연동 상태를 판정하지 않는다. 키가 없으면 데이터 경로는 503을 반환하며 프런트는 오류를 표시한다.

이번 로컬 UI 개선은 서버 API 계약과 GBIS 구간 검증 규칙을 바꾸지 않는다. 정류장 도착정보의 `routeId`를 기존 노선 상세·형상·경유 정류장 API에 전달하며, 이미 선택된 노선이면 브라우저의 기존 결과를 다시 사용한다. 경유 목록은 `stationSeq` 순서로 렌더링하고 명시적인 `turnYn=true`가 있을 때만 회차 지점을 구분한다. 차량 아이콘은 `sectionVerified`이고 신선한 차량 정보에 대해 `verifiedRoadSection()`이 실제 도로 형상의 구간을 반환한 경우에만 그 구간의 대표 위치에 표시한다. 이 대표 위치는 GPS 좌표가 아니다. 같은 노선과 출발 `stationSeq`의 검증된 차량은 한 아이콘에 대수를 표시한다. 지도는 레벨 5 이하에서만 방향 기호와 구간 아이콘을 그리며, 줌·이동 시 화면 좌표로 다시 배치한다. 실패·오래된 차량 응답은 구간 선, 목록 아이콘, 지도 아이콘을 모두 제거한다.

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

### 3-1단계 GBIS 노선 계약

| 기능 | 공식 GBIS 명세와 요청 | 실제 확인한 `response.msgBody` |
| --- | --- | --- |
| [노선번호 검색](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRoute) | `getBusRouteListv2`, `serviceKey`, `keyword`, `format=json` | `busRouteList` 배열. `routeId`, `routeName`, `startStationId/Name`, `endStationId/Name`, `routeTypeName`, `regionName` |
| [노선 상세](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRouteInfo) | `getBusRouteInfoItemv2`, `serviceKey`, `routeId`, `format=json` | `busRouteInfoItem` 단일 객체. 검색 결과와 동일한 식별자·이름·기종점 필드 포함 |
| [노선형상](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRouteLine) | `getBusRouteLineListv2`, `serviceKey`, `routeId`, `format=json` | `busRouteLineList` 배열. `lineSeq`, `x`(경도), `y`(위도) |
| [경유 정류장](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusRouteStation) | `getBusRouteStationListv2`, `serviceKey`, `routeId`, `format=json` | `busRouteStationList` 배열. `stationSeq`, `stationId`, `stationName`, `x`, `y`, `turnYn`, `turnSeq` 등 |

2026-10-09 승인 키의 `keyword=11` 실제 검색은 HTTP 200 JSON, 최상위 `response`, 숫자형 `resultCode: 0`, 98건을 반환했다. 이 중 고양 운행 노선 1건은 상세 단일 객체, 형상 753개 좌표, 경유 정류장 49개였다. 형상 순서와 정류장 순서는 각각 오름차순이며 형상 좌표의 무효값·중복 순번은 없었다. 그 노선에서 첫 형상점과 첫 정류장은 약 7m, 마지막 형상점과 마지막 정류장은 약 4m 떨어져 있었다. 모든 노선의 방향 일치를 보장하는 근거로 확장하지 않고 화살표는 제공된 `lineSeq` 순서만 따른다.

서버 경로는 `/api/routes/search?q=11`, `/api/routes/{routeId}`, `/api/routes/{routeId}/shape`, `/api/routes/{routeId}/stops`이다. 반환 데이터는 공급자별 응답 필드를 `Route`, `RouteShape`, `RouteStop` 공통 타입으로 변환한다. `routeId`는 `provider + regionCode + value` 전체로 비교한다. 노선 검색 결과는 5분, 상세와 경유 정류장은 30분, 노선형상은 1시간 캐시하며 진행 중 동일 요청을 공유한다. 잘못된 `routeId`와 검색어는 서버에서 400으로 차단한다. 공식 결과코드 `4`는 검색·상세·형상·경유 목록에서 빈 결과로 처리하며, 다른 오류·인증 거부·잘못된 응답은 구분하여 반환한다. 누락된 좌표로 임의 경로를 만들지 않는다.

프런트는 검색 입력을 360ms 디바운싱하고 이전 검색 요청을 중단한다. 같은 검색어의 결과는 브라우저에서 5분 재사용한다. 노선별 상세·형상·경유 정류장은 독립적으로 로딩하고 삭제 시 요청을 중단한다. 지도는 형상의 `lineSeq` 정렬 좌표를 Kakao `Polyline`에 전달한다. 다만 확인된 고양시 GBIS 11번(`219000001`)에서 두 방향의 직진 차로가 동일한 한 좌표로 수렴했다 다시 벌어지는 경우, 해당 두 점만 각 방향의 바로 앞뒤 좌표가 이루는 선분으로 투영한다. 같은 좌표가 정확히 두 번 나타나고, 짧은 인접 구간·작은 회전각·반대 진행 방향·양쪽의 같은 방향 꺾임·분리된 투영점 조건이 모두 맞을 때만 적용한다. 점 개수와 순서는 유지하고 회차·교차로는 그대로 둔다. 다른 노선은 검증 전이므로 원형상을 유지한다. 검증 차량의 도로 구간도 이 표시 형상에 매칭하며 75m 등의 검증 정책은 바꾸지 않는다. 2026-10-10 고양시 11번 972점 스냅샷에서는 84개 왕복 공통 좌표 중 58쌍만 보정했고 검증 차량 7대의 구간 매칭이 유지됐다. 새로운 노선이 추가되면 표시 중인 노선의 전체 범위를 한 번 맞추고, 지도 이동 때 자동으로 다시 맞추지 않는다. **노선 전체 보기** 버튼으로 사용자가 다시 맞출 수 있다. 화살표는 지도 화면 좌표로 변환한 각 형상 구간의 접선 방향에 맞춘 `CustomOverlay`이며, 확대 수준별 간격·최대 개수를 제한하고 지도가 멈춘 뒤 다시 배치한다. 표시 상태를 끄면 경로와 화살표를 함께 제거하고, 복원 시 메모리의 형상을 사용한다. 지도상의 노선 경유 정류장은 현재 활성 노선만 확대 수준에 따라 일부 표시하고, 인근 정류장과 같은 ID/좌표는 중복 표시하지 않는다.

`functions/src/transit/domain.ts`의 `TransitId`는 `provider + regionCode + value`로 구성된다. 정류장, 노선, 도착예정, 노선형상의 공통 타입을 공급자별 응답과 분리했다. `gbis.ts`는 GBIS 요청, 결과코드 검사, 응답 검증, 변환을 담당하고 `gbisStopProvider()`가 공통 계약을 구현한다. 서울·인천·TAGO 공급자는 각자의 ID와 응답을 별도 어댑터에서 변환해야 한다. 공급자 간 ID 동일성을 가정하지 않는다.

서버는 좌표를 소수 셋째 자리로 묶어 동일 검색의 중복 요청을 줄인다. 주변 정류장 캐시는 45초, 도착정보 캐시는 10초이며 진행 중인 동일 요청도 공유한다. 상위 API 호출 제한은 8초다. 프런트는 지도 `idle` 이벤트를 320ms 디바운싱하고, 지도 중심이 바뀌면 이전 fetch를 취소한다. 서버 응답이 실패하면 이전 정류장·도착정보를 현재 정보처럼 유지하지 않는다. 목록은 최대 50건, 마커는 확대 수준에 따라 최대 35개이며 동일 정류장 ID와 동일 좌표의 마커를 중복 표시하지 않는다.

## 인증키와 로컬 경로

브라우저는 `/api/`만 호출한다. Vite 개발 서버의 `/api` 프록시는 `127.0.0.1:5000` Firebase Hosting 에뮬레이터로 전달한다. Hosting은 기존 SPA 리라이트보다 먼저 `/api/**`를 `asia-northeast3`의 `api` Cloud Function으로 보낸다. 배포는 하지 않았다.

공공데이터 서비스키는 Functions의 `PUBLIC_DATA_SERVICE_KEY` Secret으로만 읽는다. 에뮬레이터에서는 Git 제외된 `functions/.secret.local`에 같은 이름으로 설정한다. 공공데이터포털의 **일반 인증키(디코딩된 값)**를 넣어야 하며, `URLSearchParams`가 요청 URL에 맞게 인코딩한다. 키를 `VITE_` 변수, React, 문서, 콘솔 로그에 넣지 않는다. 카카오 JavaScript 키 `VITE_KAKAO_MAP_APP_KEY`는 SDK 특성상 브라우저에 보이므로 [카카오 개발자 콘솔](https://developers.kakao.com/)에서 허용 도메인을 제한한다.

## 공식 명세 초기 검토 (3-2단계 기록)

- [GBIS 위치 조회](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusLocation)는 `stationId`, `stationSeq`, `vehId`, `stateCd` 등을 제공하지만 GPS 좌표 필드는 없다. GPS 마커의 근거로 사용하지 않는다.
- [전국 초정밀](https://www.data.go.kr/data/15157601/openapi.do) 공식 Swagger는 `/mst_info`, `/ps_info`, `/rtm_loc_info`를 정의한다. 실시간 위치에는 `lat`, `lot`, `gthrDt`, `rteId`, `vhclNo` 등이 있다. 실제 단건/다건 응답은 별도 검증이 필요하다.
- [TAGO 위치](https://www.data.go.kr/data/15098533/openapi.do)의 `getRouteAcctoBusLcList`는 `cityCode`, `routeId`로 조회하고 선택적 `gpslati`, `gpslong` 및 `nodeid` 등을 제공한다. TAGO ID를 GBIS ID와 동일시하지 않는다.

## 3-2단계 GBIS 운행 차량

[GBIS 공식 위치정보 명세](https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusLocation)의 `getBusLocationListv2`를 `serviceKey`, `routeId`, `format=json`으로 서버에서만 호출한다. 2026-10-09 로컬 승인 키로 운행 중인 고양시 `9709N`과 `N5700` 노선에서 HTTP 200, `application/json;charset=UTF-8`, 최상위 `response`, 숫자형 `msgHeader.resultCode=0`, 단일 객체형 `msgBody.busLocationList`를 확인했다. 필드는 `routeId`, `vehId`, `stationId`, `stationSeq`, `stateCd` 및 차량 부가정보다. GPS 좌표나 위치 수집 시각은 없다. 같은 날 다른 노선에서는 결과코드 4와 본문 부재를 확인했고 이를 정상적인 빈 차량 목록으로 변환한다. 단일 객체와 배열 모두 검증하고 `vehId` 중복은 제거한다. 조회 실패를 빈 목록으로 바꾸지 않는다.

서버 경로는 `/api/routes/{routeId}/vehicles`이며 `{ routeId, source, queriedAt, vehicles }`를 반환한다. `VehiclePosition`의 `kind: "stop-progress"`는 GPS와 구별된다. `observedAt`은 실제 데이터에 없으므로 `null`이다. `queriedAt`은 외부 위치 조회 완료 시각이다. 차량 상태 `stateCd=2`(정류소 출발)이고 `stationSeq`에 해당하는 정류장 ID가 응답의 `stationId`와 일치하며 다음 순번 정류장이 있고 현재 정류장이 회차점이 아닐 때만 `sectionVerified=true`로 표시한다. `stateCd=1`은 정류소 도착, `stateCd=0`은 교차로 통과이며 이 둘은 위치 구간을 단정하지 않는다. 실제 9709N 차량에서 119번 정류장 출발(`stateCd=2`) 후 120번 정류장 도착(`stateCd=1`)으로 변한 관측이 이 해석을 뒷받침했다. 위치 목록은 20초 캐시하며 동일한 진행 중 요청을 합친다. 상위 API 인증·형식·네트워크·시간초과 및 호출 제한 오류를 구분한다.

프런트의 `verifiedRoadSection`은 출발·다음 정류장 좌표를 GBIS `lineSeq` 순서의 실제 노선형상에 투영한다. 각 정류장과 선 사이 거리는 최대 75m, 앞뒤 정류장의 진행 순서 및 가능한 구간 길이를 검사하며, 회차·중복 좌표에서 다른 후보 구간이 비슷한 점수라면 선을 생략한다. 출발점부터 다음 정류장까지 기존 도로 형상 좌표만 잘라 별도 굵은 자홍색 Polyline으로 그린다. 9709N 실시간 데이터에서 125→126번 정류장 구간이 형상 13개 좌표로 검증되었다. 방향 화살표는 기본 노선에만 배치하고, 굵은 운행 구간과 겹치는 후보는 생략한다. 차량 갱신 시 기본 노선선을 다시 만들지 않는다. 같은 노선·같은 구간의 여러 차량은 선을 한 번만 그리고 차량 목록에서 각각 구분한다. 차량을 선택하면 해당 구간에 지도를 맞추고 선을 강조한다. 브라우저는 같은 `vehId`의 이전 조회와 새 조회를 연결해 정류장 순번 또는 상태코드가 달라지면 그 변화를 목록에 표시한다. 재조회 중에는 마지막 정상 snapshot을 그대로 표시하며 기존 120초 만료 판정은 유지한다. 개발 모드에서 구간 수가 양수에서 0으로 바뀌면 `BUS_TRACKER_SECTION_DROP` 로그에 감소 원인·직전/현재 집계·조회 경과 시간만 기록한다.

표시 중인 노선만 60초 간격으로 조회하며, 숨김·삭제·브라우저 비활성화 시 관련 조회 타이머와 요청을 중단한다. 수동 새로고침을 지원한다. 실패 시 이전 차량 목록과 선을 즉시 제거하고, 오래된 응답은 요청 취소로 무시한다. 2분 이상 지난 조회 결과는 위치 강조에 쓰지 않으며 조회 시각을 화면에 표기한다. 호출 실패 시 간격을 120초, 180초까지 늘린다. GBIS의 `queryTime`도 측정 시각이 아닌 요청 시각이므로 GPS 측정 시각처럼 표시하지 않는다.

2026-10-09 오후 에뮬레이터의 고양시 11번(`routeId=219000001`) 위치 조회는 HTTP 200으로 차량 16대, 그중 GBIS 정류소 출발 상태와 경유 정류장이 일치하는 차량 8대를 반환했다. 브라우저에서 해당 노선의 차량 16대 목록, 구간 선택, PC·모바일 지도 및 60초 뒤 두 번째 위치 요청을 확인했다. 이 숫자는 조회 순간의 값이며 항상 운행 중이라는 뜻은 아니다.

## GPS 공급자 초기 검증 상태 (3-2단계 기록)

[전국 초정밀 API](https://www.data.go.kr/data/15157601/openapi.do)의 페이지 내장 Swagger를 2026-10-09 확인했다. 호스트는 `apis.data.go.kr/B551982/rte`, 경로는 `/mst_info`, `/ps_info`, `/rtm_loc_info`, 요청에는 `serviceKey`, `pageNo`, `numOfRows`, `type`, 선택적 `stdgCd`가 있다. 위치 항목에는 `rteId`, `vhclNo`, `gthrDt`, `lat`, `lot`, `oprDrct`, `oprSpd`, `evtType`가 정의되어 있다. 로컬 키로 `stdgCd=4128000000`을 질의한 실제 `mst_info`는 HTTP 200, 코드 `K0`, 고양시 노선 53건, `rtm_loc_info`도 HTTP 200, 코드 `K0`, 실시간 위치 664건을 반환했다. 실제 행 필드명도 Swagger와 일치했다. 고양시 위치정보 첫 100건에서는 좌표·차량번호·수집시각이 모두 존재했지만 수집시각이 조회 시각보다 약 1시간 40분~30일 오래되어 2분 이내 자료는 0건이었다. 이 표본은 현재 GPS로 표시할 수 없다. 그러나 조사한 운행 중 GBIS `9709N`과 `N5700`의 노선번호는 초정밀 고양시 노선 기본정보 53건에 없었다. 서로 다른 공급자의 노선 ID를 동일하다고 가정할 수 없고, 현재 운행 차량과 동일한 `vhclNo` 대응도 입증하지 못했다. 따라서 GPS 좌표·방향각의 차량 마커는 연결하지 않았다. 향후 후보 노선에서 기종점·경유 정류장 및 차량번호 정규화를 함께 검증하고 `gthrDt`의 신선도와 좌표 범위를 확인한 뒤 별도 precision 어댑터로 제공한다. 전국 데이터를 주기적으로 전량 조회하지 않는다.

[TAGO 위치 API](https://www.data.go.kr/data/15098533/openapi.do)는 `cityCode`와 TAGO `routeId`를 요구하고 GPS 필드는 선택 사항이다. 공식 명세의 샘플 도시·노선 ID로 로컬 키의 접근을 한 번 검사해 HTTP 200, 결과코드 `00`, 0건을 받았다. 이는 키 접근만 확인하며 **고양시 운행 및 GPS 제공 증거는 아니다.** 고양시의 TAGO 도시코드와 TAGO 노선 ID는 [TAGO 노선정보 API](https://www.data.go.kr/data/15098529/openapi.do)의 도시코드·노선번호 목록으로 확인해야 한다. GBIS 번호 또는 ID를 TAGO에 그대로 넘기지 않고, 노선·차량 매칭 전까지 TAGO 어댑터와 GPS 마커는 활성화하지 않는다.

## 3-3단계 GPS 재검증 (2026-10-09)

이 절의 측정은 위 3-2단계 표본 조사보다 최신이다. [초정밀 공식 API](https://www.data.go.kr/data/15157601/openapi.do)의 내장 Swagger를 다시 읽었다. `/rtm_loc_info`의 `gthrDt` 설명은 수집일시지만 시간대·UTC 오프셋이 없다. 실제 값 658건은 모두 `YYYY-MM-DD HH:mm:ss` 형식이고 시간대 표기는 0건이다. `totDt`는 집계일시로 별도 필드이므로 수집시각을 대체하지 않는다. 공식 페이지의 업데이트 주기는 “실시간”이지만 초·분 단위의 보장 갱신 간격은 명시되지 않는다. 방향각 `oprDrct`의 기준축·회전 방향도 검증되지 않아 아이콘 회전에 사용하지 않는다.

`stdgCd=4128000000`, 페이지 크기 200, 4페이지의 고양시 **전체 658건**을 조회했다. 아래 표는 2026-10-09 10:22:42 UTC(19:22:42 KST) 재조회 결과다. 신선도는 **시간대가 없는 값에 +09:00을 적용해 본 조건부 계산**이며 서비스의 실제 최신 GPS 판정이 아니다. UTC로 해석하면 18건이 서버 시각보다 미래가 되어 +09:00 해석을 지지하는 정황은 있지만 시간대 확정 근거로 삼지 않는다.

| 수집시각 경과 (+09:00 가정) | 건수 |
| --- | ---: |
| 0~2분 | 2 |
| 2~5분 | 0 |
| 5~10분 | 0 |
| 10분 초과 | 656 |
| 해석 불가 | 0 |

가장 최근 건은 조회 시각보다 약 14초 전이었다. 유효한 위도·경도는 655건이고 3건은 좌표 검증에 실패했다. `rteId`와 전체 차량번호 조합의 중복 행은 0건이었다. 앞선 첫 전체 조회에서는 +09:00 가정하에 2분 이내 2건, 5~10분 2건, 10분 초과 654건이었다. 그 첫 페이지 200건을 65초 뒤 한 번만 재조회했을 때 같은 차량번호 200건 중 수집시각 변경은 1건이었다. 이어진 재조회에서는 4초 미래인 행도 관찰되어 해당 행을 현재 위치에서 제외했다. 실제 관측은 제한된 시점의 표본이며 공급자의 공식 갱신 주기로 일반화하지 않는다. 공식 페이지의 개발계정 신청 가능 트래픽은 5,000회이며, 운영 중인 화면에서 시 전체 페이지를 60초마다 조회하는 방식은 사용하지 않는다.

고양시 11번 노선은 GBIS `routeId=219000001`과 초정밀 `rteId=219000001`이 같았다. **ID 같음만으로 매칭하지 않았다.** 실제 `mst_info` 52개 노선 중 11번 후보는 1개였고 양쪽 기점 `성석동`, 종점 `행신역`이 같았다. `ps_info` 3,791건을 페이지 크기 500으로 8페이지 확인한 결과, 11번의 경유 정류장 104곳은 GBIS와 초정밀의 정류장 ID·정규화 이름·순서가 모두 일치했다. 초정밀 `drcGbnCd`는 해당 자료에서 공백이므로 별도 방향코드 증거로 쓰지 않는다. 이 근거로 **11번 노선 대응은 검증됨**으로 분류한다. 외부 정보가 변하면 재검증해야 하며 다른 노선의 ID 동일성을 가정하지 않는다.

실제 조회 순간 GBIS 11번 차량 17대에는 `plateNo`가 있었고, 초정밀 11번 행은 29건에 `vhclNo`가 있었다. 전체 차량번호를 공백·기호 차이만 정규화해 비교하자 GBIS 차량 17대가 모두 초정밀 11번과 일대일로 일치했다. 이 17건의 GPS 좌표는 GBIS 노선형상에서 1~13m 떨어져 있었으므로 **차량 식별 대응은 강한 후보**다. 하지만 이들의 수집시각은 +09:00 가정하에서도 약 17시간 55분~23일 전으로 모두 5분을 넘는다. 수집 당시 차량이 현재와 같은 노선·구간에 있었는지도 확인할 수 없다. 따라서 **현재 위치로 검증된 차량은 0대**이고 GPS 마커는 추가하지 않았다. `functions/src/transit/precisionEvidence.ts`는 JSON 형식, 좌표, 달력·미래 시각, 시간대, 전체 번호 일치, 중복, 노선 경유 정류장과 구간 거리의 검증 규칙을 순수 함수로 제공한다. 공급자의 시간대 근거가 없으면 최신 위치 판정을 내리지 않는다. 이 모듈은 현재 서비스의 자동 GPS 조회 경로에 연결되지 않는다.

TAGO 위치 서비스의 `getCtyCodeList` 실제 응답은 HTTP 200, 결과코드 `00`, 도시 138건이며 고양시 `cityCode=31100`을 확인했다. [TAGO 노선정보 API](https://www.data.go.kr/data/15098529/openapi.do)의 도시코드·노선번호 조회는 현재 `PUBLIC_DATA_SERVICE_KEY`에 HTTP 403, 공공데이터 게이트웨이 코드 `30`을 반환했다. 이 API의 활용승인/키 등록을 확인해야 고양시 TAGO `routeId`를 조회할 수 있다. 승인 전에는 GBIS ID를 TAGO에 넣어 위치 조회를 시도하지 않는다. [TAGO 위치 공식 응답 명세](https://www.data.go.kr/data/15098533/openapi.do)는 `gpslati`, `gpslong`, `vehicleno`를 선택·필수 필드로 구분하지만 수집시각 필드는 제시하지 않는다. 따라서 노선 ID가 확인되더라도 별도의 신선도 근거 없이는 현재 GPS 마커의 대체 공급자가 될 수 없다. 고양시 TAGO 차량 위치 응답 자체는 **미검증**이다.

진단 재실행은 Functions 빌드 뒤 `node functions/scripts/audit-precision.cjs`, `node functions/scripts/audit-route-match.cjs`, `node functions/scripts/audit-vehicle-match.cjs`, `node functions/scripts/audit-tago-goyang.cjs`를 차례로 사용한다. 첫 명령에 `--repeat`를 추가하면 65초 뒤 첫 페이지만 한 번 더 확인한다. 각 스크립트는 `functions/.secret.local`에서만 키를 읽고 요청 URL·키·원본 응답·차량번호를 출력하지 않는다. 현재 서비스의 GBIS 20초 서버 캐시와 표시 노선 60초 조회는 그대로 유지한다. 초정밀·TAGO의 실시간 브라우저 조회, GPS 마커와 방향 회전은 신선도·시간대·공급자별 필터 및 호출량 근거가 갖춰질 때까지 비활성 상태다.

## 4-2단계: 호출량과 안정성 (2026-10-10)

### 실제 호출·캐시 경로

브라우저는 주변 정류장을 지도 중심 좌표의 소수 셋째 자리 변화에 맞춰 조회하고, 도착정보는 선택 정류장에서 60초마다 조회한다. 노선 검색은 300ms 입력 디바운스와 브라우저 5분·최대 30개 검색 캐시를 사용한다. 선택된 노선의 상세·형상·경유 정류장은 해당 노선 추가 시 불러온다. 차량은 **보이는 노선별** 60초 주기다. 새 노선을 추가해도 기존 노선의 요청을 취소하거나 타이머를 재시작하지 않는다. 숨김·삭제·탭 비활성화·오프라인에서는 해당 요청/타이머를 중단하고 복귀 때 필요한 요청만 재개한다. 브라우저 `AbortController`는 이미 시작된 서버 측 GBIS 호출을 취소하지 않는다.

Functions의 `cached()`는 GBIS 공급자 접두사와 작업 종류, 정류장/노선 ID 또는 반올림한 좌표를 키로 사용한다. 현재 공급자는 GBIS이며 지역은 경기도로 고정되어 있다. 이후 공급자를 추가할 때는 공급자·지역 네임스페이스를 키에 포함해야 한다. 유효한 항목은 TTL 동안 재사용하고, 같은 키의 동시 요청은 하나의 Promise에 합친다. 실패는 저장하지 않는다. 만료 항목은 조회 시 제거하고, 300개를 넘으면 만료 항목을 우선 제거한 뒤 가장 오래 사용하지 않은 항목을 제거한다. 데이터 종류별 TTL은 기존 정책 그대로다.

| 데이터 | 서버 TTL | 브라우저 동작 |
| --- | ---: | --- |
| 주변 정류장 | 45초 | 지도 중심 변화에 따라 조회 |
| 정류장 도착정보 | 10초 | 선택 시 및 활성 탭에서 60초 주기 |
| 노선 검색 | 5분 | 입력 디바운스, 브라우저 5분 캐시 |
| 노선 상세·경유 정류장 | 30분 | 노선 추가 시 조회 |
| 노선형상 | 1시간 | 노선 추가 시 조회 |
| 운행 차량 | 20초 | 보이는 노선별 60초 주기 |

이 캐시는 **Functions 프로세스 메모리**다. 같은 인스턴스에서 여러 사용자·탭이 키를 공유하고 동시 요청 병합도 동작하지만, 다른 인스턴스·재시작과는 공유되지 않는다. 20초 차량 TTL은 브라우저 60초 주기보다 짧으므로 한 사용자가 한 노선을 계속 보는 경우 대개 새 GBIS 요청이 필요하다. 여러 사용자가 같은 노선을 비슷한 시각에 보면 절감 효과가 있으나, 인스턴스 분산과 요청 위상에 따라 달라진다. Firestore/Redis 공유 캐시는 현재 도입하지 않았다. 외부 호출 한도 초과가 실제 운영 지표에서 확인되면 예상 비용·쓰기/읽기 부하·복구 절차를 비교한 후 결정한다.

### 오류·재시도·계측

잘못된 좌표/검색어는 400, 미지원 경로는 404, 인증키/설정 실패는 503 또는 `UPSTREAM_AUTH_ERROR`, GBIS 호출 제한은 429, 외부 API 오류는 502, 시간초과는 504로 기존 API 계약에 맞춰 반환한다. 성공한 **빈 차량 목록**과 오류는 별도 상태다. 서버는 실제 GBIS 429 뒤 해당 프로세스에서 30초 동안 새로운 GBIS 요청을 억제한다. 브라우저는 노선마다 독립적으로 일시적 실패 후 120초, 연속 실패 후 180초에 0~10초 지터를 더한다. 429 후에는 해당 노선의 수동 재조회도 재시도 시각까지 제한한다. 인증·설정 오류는 자동 재시도를 멈추지만 사용자가 수동으로 재조회할 수 있다. 실패 시 이전 차량 목록/운행 구간을 지우고, 정상 복구 때 다시 표시한다. `queriedAt`은 외부 조회 완료 시각이며 GPS 측정시각이 아니다. 2분을 넘긴 결과는 현재 구간 강조에 사용하지 않는다.

에뮬레이터의 `GET /api/_metrics`는 한 프로세스의 HTTP 요청·오류, GBIS 외부 호출·오류, 캐시 적중·미적중·진행 중 요청 병합을 집계한다. HTTP/GBIS 지연은 평균·p50·p95를 보여 준다. 원시 ID·차량번호·키·응답 본문은 저장하지 않는다. 이 엔드포인트는 실제 배포에서는 404다. `node scripts/bench-api.cjs [숫자 routeId]`로 동일 차량 요청 10건을 재현할 수 있다. 에뮬레이터도 여러 작업 프로세스를 사용할 수 있으므로 이 한 프로세스 지표를 전체 호출 수로 간주하면 안 된다. 개발 빌드의 `window.__BUS_TRACKER_MAP_METRICS__`는 지도·선·오버레이·마커·리스너의 생성/제거와 최근 128개 처리시간 샘플을 집계한다. 기본 선과 운행 구간은 키별로 재사용하고, 화살표는 확대 수준·경로 샘플이 바뀔 때만 필요한 것을 갱신한다. 실제 GBIS 도로 좌표와 구간 판정 규칙은 변경하지 않았다.

### 호출량 시나리오 — 보장 성능이 아닌 계산

가정: 사용자당 **표시 중인 노선 3개**, 앱을 열고 1시간 동안 유지, 각 노선 차량 요청을 즉시 시작한 뒤 60초마다 조회한다. 지도 이동·추가 검색·재시도는 제외한다. 첫 진입의 정류장 1회 + 검색 1회 + 노선별 상세/형상/정류장 각 1회 = **차량 외 초기 브라우저 요청 11건/사용자**로 둔다. 정류장 도착정보를 열지 않는 경우다. 추가 동작이 있으면 실제 호출은 증가한다.

| 동시 사용자 | 차량 브라우저 요청/분 | 차량 요청/시간 | 첫 1시간 Functions 실행(초기 11건 포함) | 20분 이용(초기 포함) | 24시간 연속 이용(초기 포함) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 180 | 191 | 71 | 4,331 |
| 10 | 30 | 1,800 | 1,910 | 710 | 43,310 |
| 50 | 150 | 9,000 | 9,550 | 3,550 | 216,550 |
| 100 | 300 | 18,000 | 19,100 | 7,100 | 433,100 |

첫 시간의 브라우저 총요청과 Functions 실행은 표의 첫 1시간 값과 같다. **서버 캐시 적중도 Functions 실행으로 계산**된다. 캐시 읽기/쓰기는 현재 프로세스 메모리 작업이며 별도 데이터베이스 작업은 0건이다. 외부 GBIS 호출은 표의 브라우저 요청 수와 같지 않다. 모든 사용자가 **같은 3개 노선**을 보며 한 인스턴스에 모이면, 차량 외부 호출은 이론상 동시 위상에서 약 **3건/분**, 20초 TTL 안에 요청이 세 무리로 흩어지면 최대 약 **9건/분**이다. 반대로 모든 사용자의 노선이 다르거나 인스턴스가 분산되면 절감이 작아져 차량 요청 **3U건/분(U=사용자 수)**에 가까워진다. 인스턴스 I개에서 같은 노선의 외부 호출 상한은 단순 모델상 `min(3U, 9I)`건/분이지만, 실제 GBIS 지연·캐시 축출·인스턴스 수·요청 시각·오류에 따라 달라진다. 초기 11U건도 정적 캐시에 적중하면 절감될 수 있으나 여기서는 보수적으로 외부 호출로 본다. **10·50·100명을 실제로 수용한다는 검증 결과가 아니다.**

Firebase 무료/유료 구분과 실제 비용은 Functions 실행 수 하나로 확정할 수 없다. [Firebase 요금제](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans), [Functions 확장/동시성](https://firebase.google.com/docs/functions/manage-functions), [Functions 할당량](https://firebase.google.com/docs/functions/quotas), [Hosting의 Functions 연결](https://firebase.google.com/docs/hosting/serverless-overview)을 배포 직전에 다시 확인해야 한다. 예상 월 사용시간, 네트워크 송출량, 인스턴스 동시성 및 공공데이터포털 승인 서비스의 실제 호출 제한을 확인한 뒤 요금제를 선택한다. 현재 요금제·클라우드 자원은 변경하지 않았다.

### 배포 전 점검

로컬 에뮬레이터에서 타입·빌드·계약 테스트, 브라우저 PC/모바일 및 60초 갱신은 검사할 수 있지만, 다중 인스턴스와 10/50/100명 부하, 장시간 모바일 화면 잠금, 실제 과금은 검증되지 않았다. 실제 예상 트래픽으로 지연·429/502/504·캐시 적중률·인스턴스 수를 측정하고 운영 제한을 정해야 한다. 공개 API는 로그인 없이 호출 가능하고 CORS가 서버 간 호출을 막지 못한다. 무조건적인 IP 단위 제한은 학교/공용망 사용자를 함께 막을 수 있으므로, 필요하면 우선 지표에 근거한 전역/노선별 제한과 사용자 영향 및 비용을 검토한다. 서버 Secret은 계속 Functions에서만 읽고, `VITE_` 변수나 브라우저 번들에 포함하지 않는다.

## 5-1단계: 운영 배포 설계 (2026-10-10)

잠정 선택은 기존 Firebase Hosting + 2세대 Cloud Functions다. 운영 `https://bustrker.web.app`의 `/api/**`는 `firebase.json`의 첫 rewrite에 의해 `asia-northeast3`의 `api` Function으로, 정적 SPA는 다음 rewrite에 의해 `dist/index.html`로 전달된다. `localhost:5173`의 Vite 프록시는 로컬에서만 `127.0.0.1:5000` Hosting 에뮬레이터로 보낸다. 운영 브라우저는 기존 상대 `/api`를 유지하므로 별도 교차 출처 CORS 구성이 필요 없다. 직접 Function URL로 들어오는 호출은 CORS 설정과 관계없이 가능할 수 있어 공개 API 보호를 CORS에 의존하지 않는다. 5-1에서는 실제 배포나 Firebase 프로젝트 설정을 변경하지 않았다.

`defineSecret('PUBLIC_DATA_SERVICE_KEY')`로 바인딩한 키만 Functions에서 읽는다. `functions/.secret.local`은 에뮬레이터 전용이며 운영 Secret Manager에 자동 등록되지 않는다. Kakao `VITE_KAKAO_MAP_APP_KEY`는 브라우저에 보이는 JavaScript 키이므로 허용 도메인을 운영 주소까지 확인해야 한다. 서버는 키 누락·인증 실패·429·502·504를 구분하고 원본 GBIS URL/응답과 Secret을 로그 또는 클라이언트 오류에 넣지 않는다. HTTP API에는 `Cache-Control: no-store`를 설정한다. 이 헤더는 서버의 메모리 TTL과 다른 계층이다. `queriedAt`은 서버 조회 시각이며 차량 GPS 시각이 아니다.

현재 캐시는 300개 항목의 **프로세스 메모리**이고 인스턴스 간 공유되지 않는다. Functions/Workers 요청 수는 캐시 적중에서도 1회씩 발생한다. 캐시는 GBIS 호출과 대기시간을 줄일 뿐 서버 실행 요청량을 없애지 않는다. 20초 차량 TTL과 클라이언트의 노선당 60초 주기에서 같은 노선을 여러 사용자가 비슷한 시각에 조회할수록 절감이 크다. 인스턴스가 늘거나 재시작하면 절감이 줄고 GBIS 호출량이 늘 수 있다. 현재 전역 요청 제한, 인스턴스 상한, 운영 집계 엔드포인트는 없으며 `/api/_metrics`는 에뮬레이터에서만 열린다. GBIS 승인 한도를 확인하고 모의 부하 시험을 한 뒤 노선별·전역 요청 예산, 서버 인스턴스 수와 관측 방식을 정해야 한다.

브라우저는 지도 이동/검색을 디바운스하고 탭 비활성·오프라인·숨긴 노선에서 차량 폴링을 중단한다. 서버는 동일 키 진행 중 요청을 합치고 GBIS 호출을 8초 뒤 중단하며 GBIS 429 뒤 해당 프로세스에서 30초 억제한다. 이것은 다중 인스턴스 전역 제한이 아니다. 공개 API의 입력 검증과 서버 키 격리는 유지하되, IP·Origin 단독 제한으로 남용을 모두 막을 수는 없다. 실제 운영 지표에서 요청 폭주와 GBIS 429를 구분한 뒤 다중 인스턴스에도 유효한 정책을 추가한다. 정상적인 빈 차량 목록과 오류를 구분하고 실패 또는 2분 초과 데이터를 현재 운행 구간으로 표시하지 않는다.

Cloudflare 대안으로 이관할 경우 기존 Firebase Hosting의 Function rewrite를 외부 Worker 프록시로 간주할 수 없다. Firebase Hosting 유지형은 별도 Worker API 주소, 프런트 API base URL, CORS 및 별도 Secret이 필요하다. 전면 이관형은 Workers Static Assets에서 `/api/*`를 Worker에 보내고 같은 출처 SPA를 제공할 수 있지만 서버 진입점과 캐시/계측을 이관·검증해야 한다. 이 단계에서는 어느 쪽도 구현하지 않았다. 요금·호출량 계산·공식 출처·장애 대응·5-2단계 체크리스트는 [deployment-plan.md](deployment-plan.md)를 참고한다.

## 5-2A단계: GBIS 호출 예약과 실패 동작 (2026-10-10)

**사용자 계정에서 확인한 개발계정 한도:** 경기도 버스노선 조회, 정류소 조회, 버스위치정보 조회, 버스도착정보 조회는 **각 서비스별 일 1,000회**다. 전국 초정밀 위치 5,000회와 TAGO 위치 10,000회는 현재 서비스의 자동 조회에 쓰지 않는다. GBIS 노선의 `getBusRouteListv2`, `getBusRouteInfoItemv2`, `getBusRouteLineListv2`, `getBusRouteStationListv2`는 하나의 **노선 조회** 예산으로 묶는다. `getBusStationAroundListv2`, `getBusLocationListv2`, `getBusArrivalListv2`는 각각 정류소, 위치, 도착정보 예산을 사용한다. 계정 밖의 스크립트/앱 사용량과 공급자의 실제 차감·초당 제한·초기화 시각은 별도로 확인해야 한다.

`functions/src/transit/budget.ts`는 API 명칭을 이 네 서비스로 명시적으로 매핑하며, 알 수 없는 새 API는 호출하지 않는다. 내부 기본 상한은 서비스마다 **최근 24시간 800회**다. `GBIS_BUDGET_ROUTES`, `GBIS_BUDGET_STATIONS`, `GBIS_BUDGET_LOCATIONS`, `GBIS_BUDGET_ARRIVALS`로 1~1,000 사이를 설정하며 잘못된 값은 실패로 닫는다. 최근 24시간 창은 **공식 리셋 시각에 대한 주장이나 5-2B 활성화 승인**이 아니다. 외부 호출 직전에 원자적 예약이 성공해야 `fetch`를 실행한다. 성공, GBIS 오류, 네트워크 오류, 타임아웃은 모두 예약된 요청 시도로 남고 환불하지 않는다. 내부 재시도를 추가한다면 매 시도마다 별도 예약해야 한다. 캐시 적중·같은 키의 진행 중 요청 합치기·서비스별 30초 GBIS 429 억제 중에는 새 외부 요청도 예약도 없다.

기본 에뮬레이터의 `FileBudgetStore`는 Git 제외된 `functions/.budget.local.json`을 사용한다. 같은 파일을 쓰는 로컬 프로세스에만 공유되며 운영에서는 선택할 수 없다. `GBIS_BUDGET_STORE=firestore`를 명시하면 `FirestoreBudgetStore`가 선택된다. 에뮬레이터에서는 로컬 `FIRESTORE_EMULATOR_HOST`와 `demo-` 프로젝트 ID가 필수다. 운영에서는 명시적 모드·프로젝트 ID가 없거나 DB 연결이 실패하면 `503 BUDGET_UNAVAILABLE`로 닫힌다. 예약이 12초를 넘겨도 503으로 닫히며, 늦게 완료된 DB 트랜잭션이 예산을 소비할 수는 있어도 GBIS 요청을 보내지는 않는다. 자동 메모리 전환은 없다. 메모리 캐시는 300항목/기존 TTL 그대로이며 예산 원장과 별개다.

예산이 90% 또는 100%에 도달하면 서비스명·사용량·상한만 안전하게 경고한다. 에뮬레이터 `/_metrics`의 `budgetReserved:*`, `budgetDenied:*`, `budgetUnavailable:*`는 브라우저 HTTP 수·`upstream:*` GBIS 시도 수·기존 캐시 적중/병합 수와 별개다. 원시 ID·키·요청 URL은 기록하지 않는다. 내부 소진은 `429 INTERNAL_BUDGET_EXHAUSTED`, GBIS 자체 429는 `429 UPSTREAM_RATE_LIMITED`, 저장소/설정 문제는 `503 BUDGET_UNAVAILABLE`다. 서비스별 한국어 오류가 사용자에게 전달된다. 차량·도착정보는 내부 소진 및 저장소 오류에서 자동 갱신을 멈추고 과거 운행 구간을 현재처럼 유지하지 않는다. 수동 재시도나 새 탭에서 서버 요청은 할 수 있지만, 예약 거부 시 외부 GBIS 호출은 없다.

Firestore 어댑터는 기본 데이터베이스의 `bustracker_gbis_budget_v1/{routes|stations|locations|arrivals}` 네 문서를 쓴다. 각 문서는 `version: 1`, `lastSeenAt`(epoch ms), `attempts: [{id: UUID, at: epoch ms}]`로 구성된다. 트랜잭션에서 문서를 읽고 형식·Firestore `readTime`·최근 24시간 목록·한도를 확인한 다음 승인 시에만 만료 기록을 제거한 배열을 기록한다. 커밋 성공 뒤에만 기존 `requestGbis`가 `fetch`한다. 트랜잭션 충돌 재시도에서 같은 UUID를 재사용해 승인 재실행이 중복 예약을 만들지 않도록 한다. 거절에는 쓰기가 없고 인스턴스별 최대 10초 거절 캐시는 **거절만** 재사용한다. 전역 승인에는 매번 Firestore 커밋이 필요하다. 저장소 장애·문서 손상·시계 역행은 모두 503이다. [공식 트랜잭션 문서](https://firebase.google.com/docs/firestore/manage-data/transactions).

`firebase emulators:exec --only firestore --project demo-bustracker-budget "npm --prefix functions run test:firestore"`는 로컬 demo 프로젝트/18080 포트만 사용한다. 시험 진입 시 project ID와 `FIRESTORE_EMULATOR_HOST`를 검증하며 운영 연결 가능성이 있으면 중단한다. Firestore Emulator는 이 저장소에 배포용 rules 파일이 없어 테스트 중 기본 허용 규칙을 쓴다. 이는 **운영 보안 검증이 아니다**. 2026-10-10 읽기 전용 조회에서 운영 `bustrker`의 `(default)` Firestore가 Standard·서울로 확인됐다. 사용자가 제시한 운영 Rules는 모든 클라이언트 읽기·쓰기 차단이며 변경하지 않았다. Admin SDK는 Rules를 우회하므로 Functions 서비스 계정의 Firestore IAM을 따로 확인해야 한다. 현재 코드에는 `serviceAccount` 옵션이 없고 실제 함수 목록 조회가 실패했으므로 실행 주체와 권한은 미확인이다. 운영 Secret 메타데이터는 404(미등록)였다. 운영 DB 문서·Rules·IAM·Secret을 이 단계에서 변경하지 않았다. 비용과 배포 조건은 [배포 계획](deployment-plan.md)에 있다.

## 5-2B 운영 환경 구분

`functions/.env.bustrker`는 CLI가 배포 시 로드할 **비밀이 아닌** `GBIS_BUDGET_STORE=firestore` 및 네 서비스의 800회 설정을 담는다. `functions/.env.local`은 Functions Emulator에서 이 값을 `file`로 덮어써 기존 로컬 원장을 유지한다. `functions/.secret.local`은 에뮬레이터의 GBIS 키 전용이고 운영 키는 Secret Manager에 별도 등록한다. 두 환경 파일은 Git 제외 대상이다. 운영에서는 `GCLOUD_PROJECT=bustrker`를 런타임이 제공해야 `createFirestoreBudgetStore()`가 Admin SDK를 초기화하고 기본 `(default)` DB를 선택한다. 배포 전 실제 런타임 서비스 계정과 `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.create`, `datastore.entities.update` 권한을 확인한다. 클라이언트 전체 차단 Rules와 서버 IAM은 다른 계층이다.

## 공통 GBIS 방향 표시의 로컬 검증

프런트의 `splitRouteDirections()`는 전체 형상과 전체 방문 순서, 공식 회차 표시를 35m 기준으로 검증한다. 같은 입력은 노선별 캐시에 보관한다. 분리 성공 시 첫 방향의 좌표 배열만 선택 전 미리보기로 쓰고, 선택 후에는 해당 방향 형상과 방문 순서만 지도·목록에 전달한다. 지도 안내 화살표는 각 방향의 실제 형상 순서와 화면 접선으로 계산하며, 사용자 위치는 배치 후보의 우선순위에만 사용한다. 회차 경계를 확정하지 못하면 원본 전체 형상과 전체 정류장 목록을 보여 주고 방향 선택·방향별 차량 강조·지도 안내 화살표는 생략한다. 미리보기 형상은 차량 검증에 사용하지 않는다.

차량은 기존 `sectionVerified`·전체 형상 `verifiedRoadSection()`·선택 방향 방문 순서·선택 방향 형상 검증을 모두 통과해야 지도와 목록의 운행 구간에 나타난다. 75m와 `ambiguous_loop`, 60초 조회 및 120초 만료 정책은 유지한다. 방향 선택 전에는 차량 조회를 시작하지 않으며 방향을 다시 고를 때 기존 노선의 최신 응답을 재사용한다. 노선 기본색은 브라우저 로컬 저장소에 노선 ID별로 저장하고, 구간 대비색은 기존 OKLab 후보 팔레트에서 결정한다. 방향 선택 전 한 방향 미리보기는 고정 파란색이고, 방향 분리 실패 시 전체 개요선에는 사용자 지정 색을 낮은 강조도로 적용한다. 색상 변경은 차량 구간 좌표를 변경하지 않는다.

저장된 비식별 GBIS 자료와 실제 Kakao 지도 SDK를 사용한 로컬 Chrome 검사에서는 11·30·036번이 두 방향으로 분리되고 799번은 `AMBIGUOUS_TURN_MATCH`로 전체 보기로 남았다. 11번 차량은 저장된 응답, 30번 차량은 합성 검증 자료, 036번은 0대 응답, 799번은 차량 요청 없음으로 검사했다. 각 노선의 상세·형상·정류장은 브라우저에서 1회씩 조회했고 방향 선택 후 차량 요청은 노선당 1회, 재선택에서는 추가 0회였다. 이 호출 수는 로컬 fixture 서버의 브라우저 요청 수이며 실제 GBIS 상위 호출 수가 아니다. 저장 자료가 없는 다른 노선 구조와 네 노선의 현재 실시간 운행 상태는 미검증이다. 재현 명령은 `node scripts/qa-four-routes-browser.mjs`이며 실제 GBIS를 호출하지 않는다.
