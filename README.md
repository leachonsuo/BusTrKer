# BusTracker — 로컬 UI 개선 및 배포 전 검증

고양시에서 시작하는 카카오 지도 기반 버스 앱입니다. 주변 정류장, 도착정보, 노선 검색·실제 노선형상·경유 정류장에 더해 GBIS 운행 차량 목록과 확인된 정류장 간 운행 구간을 표시합니다. **GBIS에는 GPS 좌표가 없으므로 강조선은 실제 차량의 한 점 위치가 아닙니다.** 초정밀 GPS의 신선도와 시간대가 검증되지 않아 GPS 마커에 사용하지 않습니다.

2026-10-09의 3-3단계 재검증에서 고양시 11번은 GBIS와 초정밀의 기·종점 및 경유 정류장 104곳의 ID·순서가 모두 일치했고, 당시 GBIS 차량 17대의 전체 차량번호도 초정밀 자료와 일치했습니다. 그러나 **그 17건의 GPS 수집시각은 한국 시간으로 해석해도 모두 5분을 넘었고, 공식 명세는 수집시각의 시간대를 명시하지 않습니다.** 따라서 GPS 버스 마커를 추가하지 않았습니다. 3-2단계의 정류장 구간 강조와 60초 갱신은 계속 작동합니다.

## 5-2A단계 상태

사용자가 공공데이터포털 계정에서 확인한 **개발계정 일일 한도**는 GBIS 노선·정류소·위치·도착정보 서비스별 각각 **1,000회**입니다. 검색·상세·형상·경유 정류장은 하나의 **노선 조회 서비스** 예산으로 합칩니다. 초정밀 5,000회와 TAGO 위치 10,000회는 진단용 승인 한도이며 서비스 자동 조회에는 연결하지 않습니다. 내부 기본 예산은 GBIS 서비스별 **최근 24시간에 800번의 외부 요청 시도**입니다. 이는 공식 한도/초기화 시각이 아닌 보수적인 내부 설정입니다. `functions/.env.local`의 `GBIS_BUDGET_ROUTES`, `GBIS_BUDGET_STATIONS`, `GBIS_BUDGET_LOCATIONS`, `GBIS_BUDGET_ARRIVALS`로 1~1,000 사이에서 조정할 수 있지만, 외부 테스트·다른 앱 사용량을 확인하기 전에는 800을 올리지 마세요.

기본 로컬 Functions 에뮬레이터는 Git 제외된 `functions/.budget.local.json` 파일에 예약 기록을 남깁니다. Firestore 모드는 `GBIS_BUDGET_STORE=firestore`를 **명시적으로** 설정했을 때만 선택합니다. `functions/src/transit/firestore-budget.ts`는 서비스별 한 문서에 최근 24시간 예약의 UUID와 시각을 저장하고, Firestore 트랜잭션 커밋 뒤에만 외부 요청을 허용합니다. 로컬 Firestore 모드는 `demo-` 프로젝트와 로컬 Firestore Emulator가 모두 있어야 합니다. 캐시 적중·진행 중 요청 병합은 새 예약을 쓰지 않고, 실패·시간초과 요청은 환불하지 않습니다. Firestore 장애·설정 오류는 `503 BUDGET_UNAVAILABLE`로 닫힙니다. 운영에서 모드를 설정하지 않으면 GBIS 데이터 경로는 계속 503으로 차단됩니다. 기존 `/api/health`는 유지됩니다.

2026-10-10 읽기 전용 Firebase CLI 조회로 `bustrker`의 Firestore `(default)` 데이터베이스가 **Standard·서울 `asia-northeast3`**임을 확인했습니다. 사용자가 제시한 운영 Rules는 전체 클라이언트 읽기·쓰기 차단이며, 이 작업에서 Rules를 변경하지 않았습니다. Functions 실행 서비스 계정과 IAM은 조회되지 않았고 운영 `PUBLIC_DATA_SERVICE_KEY` Secret 메타데이터 조회는 **404(미등록)**였습니다. 따라서 현재 공개 배포는 진행하지 않습니다.

예산이 소진되면 서비스별 한국어 안내와 `429 INTERNAL_BUDGET_EXHAUSTED`를 반환하며, 해당 외부 호출은 보내지 않습니다. 차량·도착정보의 자동 반복 조회는 이 오류에서 멈춥니다. GBIS 자체 429와 내부 예산 초과는 별도 코드/계측으로 구분합니다. 60초 차량 갱신, 20초 서버 캐시, 120/180초 재시도, 탭 비활성·오프라인 중지는 유지합니다. 운영 한계와 대안은 [배포 계획](docs/deployment-plan.md), 구현 구조는 [API 아키텍처](docs/api-architecture.md)에 정리했습니다. **이 단계에서 실제 배포, 요금제/Secret/Firestore 운영 설정 변경, Git commit/push는 하지 않았습니다.**

## 5-2B 운영 설정 준비

`functions/.env.bustrker`에는 비밀이 아닌 `GBIS_BUDGET_STORE=firestore`와 네 서비스의 800회 한도만 준비했습니다. Firebase CLI는 배포 대상 프로젝트 ID의 `.env.<project_ID>`를 Functions 환경변수로 읽습니다. 이 파일은 Git 제외 대상이므로 다른 컴퓨터에서 배포할 때도 별도로 준비해야 합니다. `functions/.env.local`에는 `GBIS_BUDGET_STORE=file`을 넣어 기존 `bustrker` Functions Emulator가 계속 로컬 파일 예산을 쓰게 했습니다. 에뮬레이터에서는 `.env.local`이 프로젝트별 파일보다 우선합니다. 두 파일 모두 서버 인증키를 포함하지 않습니다. 운영 키는 승인 후 Firebase Secret Manager에 별도로 등록하고 `api` Function을 다시 배포해야 적용됩니다.

Node.js 22.23.3에서 프런트·Functions 타입 검사와 빌드, Functions 테스트 **34/34**, 노선 구간 **4/4**, 차량 폴링 **6/6**, 로컬 보안 QA **3/3**, demo Firestore Emulator **8/8**이 통과했습니다. 두 차례 로컬 측정에서 50개 동시 예약의 개별 평균은 3.5~3.6초·p95는 4.0~4.2초·최대는 4.0~4.2초였고, 트랜잭션 콜백 재실행은 각 50회였습니다. 8개 별도 프로세스의 예약 구간은 평균 5.9~6.5초·p95 6.6~6.8초였습니다. 이는 **로컬 에뮬레이터 측정**이며 운영 Firestore 지연·비용을 보장하지 않습니다. 자세한 배포 조건과 롤백 절차는 [배포 계획](docs/deployment-plan.md)에 있습니다.

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

Firestore 공유 예산을 **실제 GBIS 호출 없이** 검사하려면 루트에서 다음 명령을 실행합니다. Java 21 이상과 Firebase CLI가 필요하며, 명령은 운영 프로젝트 대신 `demo-bustracker-budget`과 로컬 18080 포트만 사용합니다. 50개 동시 예약, 여러 Node 프로세스, 재시작·경계·장애·캐시를 모의 응답으로 검사합니다.

```powershell
firebase emulators:exec --only firestore --project demo-bustracker-budget "npm --prefix functions run test:firestore"
```

Firestore를 사용하는 수동 Functions 에뮬레이터 실행은 별도 demo 프로젝트에서 `functions/.env.local`의 `GBIS_BUDGET_STORE=firestore`와 로컬 Firestore Emulator를 함께 설정한 뒤 진행합니다. 위 자동 시험은 운영 Firestore나 실제 GBIS 키를 사용하지 않습니다. 기본 `bustrker` 로컬 실행은 파일 예산 모드를 유지합니다.

상단에서 **버스 노선** 모드로 바꾸고 번호를 입력하면 검색 결과가 나옵니다. 방향이 검증된 노선을 선택하면 첫 운행 방향의 실제 형상을 얇은 미리보기 선으로 표시하고, 동일한 방향 선택 패널을 모든 위치에서 제공합니다. 지도 위 선택 안내는 실제 진행 방향이 확실하고 화면에 공간이 있을 때만 나타납니다. 방향을 선택하면 그 방향의 경로·정류장·검증된 차량 구간만 표시합니다. 방향을 확정할 수 없는 노선은 전체 형상과 전체 방문 순서의 정류장 목록을 보여 주며 방향별 차량 구간은 표시하지 않습니다. 최대 5개 노선을 동시에 선택할 수 있고 숨김·표시·삭제, 노선별 색상과 기본 파란색 복원을 사용할 수 있습니다. 방향 변경은 이미 받은 상세·형상·정류장·차량 자료를 재사용합니다. 지도 우측의 **노선 전체 보기**로 표시 중인 경로를 한 화면에 맞출 수 있습니다. 정류장 도착정보의 버스번호를 눌러 같은 GBIS `routeId`로 노선을 추가할 수도 있습니다. 모바일에서는 하단의 **버스 노선** 버튼으로 목록을 접고 펼칩니다.

방향을 선택하면 그 방향의 경유 정류장 순서 목록을 펼칩니다. 순서는 GBIS `stationSeq`를 따르고, `turnYn=true`인 정류장이 있을 때만 회차 지점을 표시합니다. 방향 분리가 불가능하면 전체 방문 순서 목록을 제공합니다. 목록의 정류장을 누르면 해당 위치로 지도가 이동하고 선택한 방문 순서와 마커가 강조됩니다. 도착정보의 버스번호를 누르면 도착정보 패널에서 노선 목록으로 전환해 해당 노선과 정류장 순서를 엽니다. 같은 정류장 ID가 노선에서 여러 번 나오면 방문 순서를 임의로 고르지 않고 모두 표시합니다. 이미 선택한 노선은 다시 요청하지 않고 활성화하며, 숨긴 노선은 표시 상태로 복원합니다.

지도 방향 표시는 레벨 5 이하에서만 작은 `›` 형태로 표시하고 화면 픽셀 간격과 중복 방지 한도를 적용합니다. 굵은 선과 버스 아이콘은 **검증된 정류장 사이 구간**에만 표시합니다. 아이콘의 위치는 구간을 설명하기 위한 대표 위치이며 정확한 차량 GPS가 아닙니다. 같은 구간의 차량은 개수로 묶습니다. 차량 조회가 실패하거나 2분을 넘기면 현재 구간과 아이콘을 지웁니다.

방향 선택 화면에서는 미리보기 경로가 보이도록 지도를 맞추고, 선택 후에는 선택한 방향의 경로에 맞춥니다. 지도에서 경로를 누르거나 노선 카드의 번호를 누르면 해당 노선을 강조합니다. 얇은 선은 선택한 방향의 기본 노선형상, 굵은 선은 확인된 운행 구간이며, 같은 구간에 여러 차량이 있으면 차량 수를 표시합니다. **목록 접기**로 PC 지도를 넓힐 수 있고, 모바일에서는 하단 목록을 접거나 패널을 확장할 수 있습니다.

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
node scripts/qa-route-ui-mock.mjs
node scripts/qa-four-routes-browser.mjs
node scripts/qa-api-security.cjs
node scripts/bench-api.cjs
node scripts/bench-budget-mock.cjs
```

`npm test`는 실제 확인한 GBIS JSON 구조의 단건·다건·오류 응답을 검증합니다. 실제 외부 API 호출 성공은 위의 에뮬레이터 요청으로 따로 확인해야 합니다. PC와 모바일에서 노선 검색, 경로/화살표, 여러 노선, 숨김·복원·삭제, 경유 정류장과 도착정보, 차량 목록을 확인하세요. 로컬 Chrome DevTools 포트 9223이 준비되어 있으면 `node scripts/qa-browser.cjs`와 `node scripts/qa-vehicles.cjs 11`로 자동 화면 점검도 할 수 있습니다. `node scripts/qa-vehicles.cjs 11 --poll`은 60초 주기의 두 번째 요청까지 확인합니다. 11번 노선의 차량 수는 시간에 따라 달라질 수 있습니다. API 응답과 전국 공급자 확장 방식은 [docs/api-architecture.md](docs/api-architecture.md)에 정리했습니다.

`qa-route-ui-mock.mjs`는 로컬 Chrome과 5173 포트를 사용하고 `/api`에 명시적인 모의 응답만 제공하는 화면 회귀 검사입니다. 실제 GBIS·Firebase 요청을 보내지 않습니다. 도착정보에서 노선 열기, 경유 정류장·회차, 확인된 구간 아이콘, 정류장 클릭 후 지도 이동, 중복 노선 재선택, PC·모바일, 차량 조회 오류와 회차 정보 미제공 상태를 검사합니다. 스크린샷은 운영 데이터 증거가 아니라 레이아웃 확인용입니다.

`qa-four-routes-browser.mjs`는 로컬 Chrome에서 실제 Kakao 지도 SDK를 사용하고, 저장된 비식별 GBIS 11·30·036·799 형상·정류장 자료를 로컬 `/api`에 제공합니다. 방향 선택·재선택, 차량 구간, 799 전체 경로 대체 표시, 색상 복원 및 브라우저 요청 수를 검사합니다. 30번 차량은 합성 검증 자료이고 036번은 0대 응답입니다. 이 테스트는 외부 GBIS나 Firebase Functions를 호출하지 않으며, 실제 운영 차량 검증으로 해석하면 안 됩니다. 로컬 Kakao JavaScript 키와 Chrome이 필요합니다.

`qa-api-security.cjs`와 `bench-api.cjs`는 로컬 Hosting/Functions 에뮬레이터가 실행 중일 때 사용합니다. 후자는 동일 차량 API 요청 10건의 집계와 `/api/_metrics`의 **한 에뮬레이터 프로세스** 차이를 보여 주며 전체 인스턴스 호출 수로 해석할 수 없습니다. `/api/_metrics`는 에뮬레이터에만 존재합니다. 지도 객체·처리시간 집계는 개발 빌드의 `window.__BUS_TRACKER_MAP_METRICS__`에서 볼 수 있습니다. 둘 다 키, 차량번호 목록, GBIS 원본 응답을 기록하지 않습니다.

`bench-budget-mock.cjs`는 Functions 빌드 뒤 실행하며 실제 GBIS 키를 읽거나 공공데이터 API를 호출하지 않습니다. 로컬 모의 HTTP 응답과 가상 시계로 10·50·100명의 같은/서로 다른 3개 노선, 15·30·60분 차량 조회를 재현합니다. 출력의 평균·p95는 **이 컴퓨터의 모의 코드 경로 지연**이며 Firebase 운영 성능이 아닙니다. 정류장·도착·노선 초기 조회와 실제 브라우저 렌더링은 이 벤치마크에서 제외합니다. 현재 에뮬레이터의 `bench-api.cjs`는 실제 GBIS를 호출할 수 있으므로 일일 승인 한도를 확인한 뒤에만 제한적으로 실행하세요.

배포 전에는 실제 예상 트래픽으로 다중 인스턴스 부하 테스트를 하고, 공공데이터포털의 승인 서비스·호출 한도와 Firebase 요금제/리전을 확인해야 합니다. 공개 API에 인증은 없으므로 운영 지표로 비정상 트래픽을 판단한 뒤 공용 IP 이용자를 고려한 제한 방식을 선택하세요. 이번 단계에서는 결제 설정 변경·클라우드 배포를 수행하지 않았습니다.

## 5-1단계 배포 준비 상태

2026-10-10 기준 현재 `firebase.json`은 Hosting의 `/api/**`를 서울 `asia-northeast3`의 Node.js 22 `api` Function으로 전달하고, 나머지 경로는 React 앱으로 보냅니다. 개발 서버의 Vite `/api` 프록시는 로컬 에뮬레이터용입니다. 5-1단계의 잠정 배포 방식은 **기존 Firebase Hosting + Functions 유지**입니다. 실제 배포, 요금제 변경, 운영 Secret 등록은 하지 않았습니다. Firebase Functions 배포에는 Blaze 결제 계정이 필요하므로 프로젝트의 현재 요금제와 비용 책임자 승인이 먼저 필요합니다. Blaze 무료 사용량은 무과금을 보장하지 않습니다.

사용자 수와 이용 시간별 호출량, GBIS 승인 한도 확인 항목, Firebase/Cloudflare 비교, 비용 근거, 보안·장애 대응, 5-2단계 실행 체크리스트는 [배포 계획](docs/deployment-plan.md)에 정리했습니다. 배포 전에는 운영 `PUBLIC_DATA_SERVICE_KEY`를 Firebase Secret Manager에 **개발용과 별도로** 등록하고, Kakao JavaScript SDK의 운영 도메인을 허용하며, 공공데이터포털에서 현재 키의 서비스별 승인 및 실제 호출 한도를 확인해야 합니다. 서버 키를 `VITE_` 변수나 브라우저 번들에 넣지 않습니다. 사용자 승인 전 배포 명령을 실행하지 않습니다.
