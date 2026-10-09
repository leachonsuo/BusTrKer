# BusTracker — 4-2단계 성능·안정성 개선

고양시에서 시작하는 카카오 지도 기반 버스 앱입니다. 주변 정류장, 도착정보, 노선 검색·실제 노선형상·경유 정류장에 더해 GBIS 운행 차량 목록과 확인된 정류장 간 운행 구간을 표시합니다. **GBIS에는 GPS 좌표가 없으므로 강조선은 실제 차량의 한 점 위치가 아닙니다.** 초정밀 GPS의 신선도와 시간대가 검증되지 않아 GPS 마커에 사용하지 않습니다.

2026-10-09의 3-3단계 재검증에서 고양시 11번은 GBIS와 초정밀의 기·종점 및 경유 정류장 104곳의 ID·순서가 모두 일치했고, 당시 GBIS 차량 17대의 전체 차량번호도 초정밀 자료와 일치했습니다. 그러나 **그 17건의 GPS 수집시각은 한국 시간으로 해석해도 모두 5분을 넘었고, 공식 명세는 수집시각의 시간대를 명시하지 않습니다.** 따라서 GPS 버스 마커를 추가하지 않았습니다. 3-2단계의 정류장 구간 강조와 60초 갱신은 계속 작동합니다.

## 준비

Node.js 22 이상과 Firebase CLI를 준비합니다. 이 저장소의 기존 `.firebaserc`는 `bustrker` 프로젝트를 가리킵니다. **실제 배포는 이 단계에서 하지 않습니다.**

```powershell
npm install
cd functions
npm install
cd ..
```

1. 루트 `.env.example`을 `.env.local`로 복사하고 `VITE_KAKAO_MAP_APP_KEY`에 카카오 Maps JavaScript 키를 입력합니다. 카카오 개발자 콘솔의 JavaScript SDK 허용 도메인에 `http://localhost:5173`과 `http://127.0.0.1:5173`, `http://localhost:5000`을 등록합니다.
2. `functions/.secret.local`을 만들어 아래 형식으로 공공데이터포털의 **일반 인증키(디코딩된 값)**를 저장합니다. 정류소·도착정보, **GBIS 버스노선 조회와 버스위치정보 조회** API 활용신청이 승인되어 있어야 합니다. 기존 키로 모두 호출된다면 별도 키는 필요하지 않습니다. 이 파일은 Git 제외 대상이며, 키 값을 채팅이나 로그에 올리지 않습니다.

```dotenv
PUBLIC_DATA_SERVICE_KEY=여기에_발급받은_일반_인증키
```

## 로컬 실행

터미널 A:

```powershell
cd functions
npm run build
cd ..
firebase emulators:start --only hosting,functions --project bustrker
```

터미널 B:

```powershell
npm run dev
```

브라우저에서 **`http://localhost:5173`**을 엽니다. Vite는 `/api` 요청을 Hosting 에뮬레이터 `127.0.0.1:5000`으로 프록시합니다. 빌드된 앱을 확인하려면 `npm run build` 후 `http://localhost:5000`을 엽니다. 카카오 지도 키의 허용 도메인에 사용한 주소가 등록되어 있어야 합니다. 위치 권한을 허용하면 현재 위치로 이동하고, 거부하면 고양시 기본 지도 중심 주변을 조회합니다. 지도 이동 후에도 현재 중심을 기준으로 다시 조회합니다.

상단에서 **버스 노선** 모드로 바꾸고 번호를 입력하면 검색 결과가 나옵니다. 노선을 선택하면 실제 노선형상과 방향 화살표가 표시됩니다. 최대 5개를 동시에 선택할 수 있으며, 숨김·표시·삭제와 경유 정류장 펼치기를 사용할 수 있습니다. 지도 우측의 **노선 전체 보기**로 표시 중인 경로를 한 화면에 맞출 수 있습니다. 정류장 도착정보의 버스번호를 눌러 같은 GBIS `routeId`로 노선을 추가할 수도 있습니다. 모바일에서는 하단의 **버스 노선** 버튼으로 목록을 접고 펼칩니다.

4-1단계 화면에서는 첫 노선을 추가할 때만 경로에 맞춰 지도를 이동합니다. 이후 노선을 추가해도 지도 중심은 유지하며, **노선 전체 보기**로 직접 화면을 맞출 수 있습니다. 지도에서 경로를 누르거나 노선 카드의 번호를 누르면 해당 노선을 강조합니다. 얇은 선은 전체 노선형상, 굵은 선은 확인된 운행 구간이며, 같은 구간에 여러 차량이 있으면 차량 수를 표시합니다. **목록 접기**로 PC 지도를 넓힐 수 있고, 모바일에서는 하단 목록을 접거나 패널을 확장할 수 있습니다.

선택해 표시 중인 노선만 60초 간격으로 GBIS 차량 위치를 조회합니다. 차량 수와 목록, 서버 조회 시각을 표시하며 차량을 선택하면 확인된 운행 구간을 지도에 맞춥니다. `stateCd=2`인 정류소 출발 데이터가 노선의 `stationSeq`·`stationId`와 일치하고 다음 정류장 및 도로형상 구간을 확인할 때만 굵은 선을 그립니다. 위치를 확정할 수 없는 차량은 목록에만 남습니다. 브라우저가 숨겨지거나 노선을 숨기면 주기 조회를 중단하고, 수동 **차량 새로고침**도 사용할 수 있습니다. 실패나 2분을 넘긴 자료는 현재 위치처럼 강조하지 않습니다.

4-2단계에서는 노선마다 요청과 타이머를 하나씩 관리합니다. 탭 비활성화·오프라인·노선 숨김·삭제 시 해당 작업을 취소하고 복귀 시 필요한 요청만 재개합니다. 수동 새로고침은 진행 중인 요청과 합치고, 방금 조회한 노선은 10초 동안 재요청을 제한하며 화면에 이유를 알립니다. 일시적 실패는 기본 120초, 연속 실패는 180초에 최대 10초 지터를 더해 재시도합니다. 429는 재시도 시점 전 수동 호출도 제한하고, 인증/설정 오류는 자동 재시도를 멈춥니다. 조회 실패 시 이전 운행 구간을 현재 위치로 유지하지 않습니다.

서버의 데이터별 TTL은 주변 정류장 45초, 도착정보 10초, 노선 검색 5분, 노선 상세·경유 정류장 30분, 노선형상 1시간, 차량 20초입니다. 같은 Functions 프로세스 안에서는 캐시 적중과 진행 중 요청 병합이 여러 사용자에게 적용됩니다. 캐시는 최대 300개 항목의 프로세스 메모리이며 다른 인스턴스와 공유되지 않습니다. 따라서 실제 배포의 호출 절감률과 수용 인원은 부하 테스트 전까지 보장할 수 없습니다. 자세한 시나리오는 [API 아키텍처](docs/api-architecture.md)를 참고하세요.

차량 카드에는 구간 확인·미확인 차량 수와 최근 **서버 조회** 경과 시간을 표시합니다. 차량 목록과 경유 정류장은 각각 펼칠 수 있습니다. 차량 조회 오류의 상세 내용은 카드의 **오류 내용**에서 확인할 수 있습니다. 조회 시각은 GPS 측정 시각이 아니며, 화면의 선과 화살표도 차량의 정확한 GPS 좌표를 뜻하지 않습니다.

## 실제 API 확인

```powershell
curl.exe -i "http://localhost:5000/api/health"
curl.exe -i "http://localhost:5000/api/stops/nearby?lat=37.6584&lng=126.8320"
curl.exe -i "http://localhost:5000/api/stops/실제_stationId/arrivals"
curl.exe -i "http://localhost:5000/api/routes/search?q=11"
curl.exe -i "http://localhost:5000/api/routes/실제_routeId"
curl.exe -i "http://localhost:5000/api/routes/실제_routeId/shape"
curl.exe -i "http://localhost:5000/api/routes/실제_routeId/stops"
curl.exe -i "http://localhost:5000/api/routes/실제_routeId/vehicles"
```

`실제_stationId`는 주변 정류장 응답의 `stops[].id.value`, `실제_routeId`는 노선 검색 응답의 `routes[].id.value`로 바꿉니다. 노선형상 응답의 `shape.points`가 2개 이상이고, 화면에 해당 경로가 표시되는지 확인하세요. 승인된 키가 없으면 503 `API_KEY_NOT_CONFIGURED`, 상위 API가 거절하거나 예상 형식과 다르면 502 오류가 납니다. 호출 제한은 429, 시간초과는 504로 구분하며 화면에 실패 상태를 표시합니다. `/api/health`의 `transitData`는 기존 계약대로 `not-connected`를 유지하며 노선 연동 상태 판정에 사용하지 않습니다.

2026-10-09 새벽 로컬 검증에 사용한 고양시 야간 노선은 `9709N` (`routeId=229000277`)과 `N5700` (`routeId=241007274`)입니다. 운행 시간에 따라 빈 목록이 정상일 수 있습니다. `node functions/scripts/verify-live-location.cjs`는 두 노선의 정류장 순번과 도로 구간 산출 결과를 **차량 식별자·인증키·전체 응답 없이** 검사합니다. `node scripts/inspect-public-swagger.cjs`, `node functions/scripts/verify-precision-access.cjs mst_info 4128000000`, `node functions/scripts/verify-tago-access.cjs`는 각각 공식 명세와 제한된 접근 상태를 확인합니다.

3-3단계의 제한된 실제 데이터 진단은 Functions 빌드 후 아래 명령으로 재실행할 수 있습니다. 스크립트는 서버 측 `functions/.secret.local`만 사용하며 인증키·전체 응답·차량번호를 출력하지 않습니다. **전체 고양시 GPS 조회를 자동 폴링하지 마세요.**

```powershell
npm --prefix functions run build
node functions/scripts/audit-precision.cjs
node functions/scripts/audit-route-match.cjs
node functions/scripts/audit-vehicle-match.cjs
node functions/scripts/audit-tago-goyang.cjs
```

`audit-precision.cjs --repeat`는 첫 페이지를 65초 뒤 한 번만 더 조회해 수집시각 변경 건수를 확인합니다. 2026-10-09 19:22 KST 고양시 전체 위치 658건 중 한국 시간 **가정하에** 2분 이내 2건, 10분 초과 656건이었고, 유효 좌표는 655건이었습니다. 시간대 표기가 없어 이를 서비스의 최신 GPS로 확정하지 않습니다. 11번의 정확한 차량번호 대응 17건은 모두 5분 초과였습니다. TAGO 위치 API의 고양시 코드는 `31100`으로 확인했지만 TAGO 노선정보 API는 현재 키에 403을 반환해 노선 ID와 차량 GPS를 확인할 수 없었습니다.

## 검사

```powershell
npm run typecheck
npm run build
cd functions
npm run typecheck
npm run build
npm test
cd ..
node --test scripts/route-segments.test.cjs
node --test scripts/vehicle-polling.test.cjs
node scripts/qa-api-security.cjs
node scripts/bench-api.cjs
```

`npm test`는 실제 확인한 GBIS JSON 구조의 단건·다건·오류 응답을 검증합니다. 실제 외부 API 호출 성공은 위의 에뮬레이터 요청으로 따로 확인해야 합니다. PC와 모바일에서 노선 검색, 경로/화살표, 여러 노선, 숨김·복원·삭제, 경유 정류장과 도착정보, 차량 목록을 확인하세요. 로컬 Chrome DevTools 포트 9223이 준비되어 있으면 `node scripts/qa-browser.cjs`와 `node scripts/qa-vehicles.cjs 11`로 자동 화면 점검도 할 수 있습니다. `node scripts/qa-vehicles.cjs 11 --poll`은 60초 주기의 두 번째 요청까지 확인합니다. 11번 노선의 차량 수는 시간에 따라 달라질 수 있습니다. API 응답과 전국 공급자 확장 방식은 [docs/api-architecture.md](docs/api-architecture.md)에 정리했습니다.

`qa-api-security.cjs`와 `bench-api.cjs`는 로컬 Hosting/Functions 에뮬레이터가 실행 중일 때 사용합니다. 후자는 동일 차량 API 요청 10건의 집계와 `/api/_metrics`의 **한 에뮬레이터 프로세스** 차이를 보여 주며 전체 인스턴스 호출 수로 해석할 수 없습니다. `/api/_metrics`는 에뮬레이터에만 존재합니다. 지도 객체·처리시간 집계는 개발 빌드의 `window.__BUS_TRACKER_MAP_METRICS__`에서 볼 수 있습니다. 둘 다 키, 차량번호 목록, GBIS 원본 응답을 기록하지 않습니다.

배포 전에는 실제 예상 트래픽으로 다중 인스턴스 부하 테스트를 하고, 공공데이터포털의 승인 서비스·호출 한도와 Firebase 요금제/리전을 확인해야 합니다. 공개 API에 인증은 없으므로 운영 지표로 비정상 트래픽을 판단한 뒤 공용 IP 이용자를 고려한 제한 방식을 선택하세요. 이번 단계에서는 결제 설정 변경·클라우드 배포를 수행하지 않았습니다.
