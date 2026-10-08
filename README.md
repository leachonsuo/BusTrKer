# BusTracker — 2단계

고양시에서 시작하는 카카오 지도 기반 버스 정류장 앱입니다. 지도 중심 주변의 GBIS 정류장과 선택한 정류장의 도착정보를 표시합니다. 차량 GPS와 노선 경로는 다음 단계의 범위입니다.

## 준비

Node.js 22 이상과 Firebase CLI를 준비합니다. 이 저장소의 기존 `.firebaserc`는 `bustrker` 프로젝트를 가리킵니다. **실제 배포는 이 단계에서 하지 않습니다.**

```powershell
npm install
cd functions
npm install
cd ..
```

1. 루트 `.env.example`을 `.env.local`로 복사하고 `VITE_KAKAO_MAP_APP_KEY`에 카카오 Maps JavaScript 키를 입력합니다. 카카오 개발자 콘솔의 JavaScript SDK 허용 도메인에 `http://localhost:5173`과 `http://127.0.0.1:5173`, `http://localhost:5000`을 등록합니다.
2. `functions/.secret.local`을 만들어 아래 형식으로 공공데이터포털의 **일반 인증키(디코딩된 값)**를 저장합니다. 정류소 조회와 버스도착정보 조회 API의 활용신청이 승인되어 있어야 합니다. 이 파일은 Git 제외 대상이며, 키 값을 채팅이나 로그에 올리지 않습니다.

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

브라우저에서 `http://localhost:5173`을 엽니다. Vite는 `/api` 요청을 Hosting 에뮬레이터 `127.0.0.1:5000`으로 프록시합니다. 빌드된 앱을 확인하려면 `npm run build` 후 `http://localhost:5000`을 엽니다. 두 주소에서 같은 서버 API를 사용합니다. 위치 권한을 허용하면 현재 위치로 이동하고, 거부하면 고양시 기본 지도 중심 주변을 조회합니다. 지도 이동 후에도 현재 중심을 기준으로 다시 조회합니다.

## 실제 API 확인

```powershell
curl.exe -i "http://localhost:5000/api/health"
curl.exe -i "http://localhost:5000/api/stops/nearby?lat=37.6584&lng=126.8320"
curl.exe -i "http://localhost:5000/api/stops/실제_stationId/arrivals"
```

마지막 명령의 `실제_stationId`는 주변 정류장 응답의 `stops[].id.value` 숫자로 바꿉니다. 정류장·도착정보가 200으로 반환되고 화면에도 일치하는 값이 표시되는지 확인하세요. 승인된 키가 없으면 503 `API_KEY_NOT_CONFIGURED`, API가 거절하거나 예상 형식과 다르면 502 오류가 나며 화면에 실패 상태가 표시됩니다. `/api/health`의 `transitData`는 실제 연동을 검증하기 전까지 `not-connected`로 유지합니다.

## 검사

```powershell
npm run typecheck
npm run build
cd functions
npm run typecheck
npm test
```

`npm test`는 공식 GBIS Swagger의 필드명을 사용한 파서 계약 테스트입니다. 실제 외부 API 호출 성공은 위의 에뮬레이터 요청으로 따로 확인해야 합니다. API 응답과 전국 공급자 확장 방식은 [docs/api-architecture.md](docs/api-architecture.md)에 정리했습니다.
