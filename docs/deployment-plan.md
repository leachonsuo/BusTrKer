# BusTracker 5-1단계 — 배포·비용·보안 계획

확인일: **2026-10-10**. 이 문서는 현재 저장소와 아래 공식 자료에 근거한 **배포 전 설계**다. 실제 배포, 요금제 변경, 운영 Secret 등록, 부하 검증은 하지 않았다. 가격은 미화이며 세금·환율·계정별 크레딧은 제외한다. 정책은 5-2단계 직전에 다시 확인한다.

## 결론과 배포 준비 상태

**잠정 선택: A안, Firebase Hosting + 2세대 Cloud Functions 유지.** 현재 `firebase.json`의 `/api/**` → 서울 `api` Function → SPA 순서, Node.js 22 런타임, 브라우저의 상대 `/api` 경로가 서로 맞는다. 백엔드를 옮기면 절약할 가능성이 있는 소액의 호출 비용에 비해 API 이관, CORS, Secret, 도메인, QA 비용이 크다. 학교 동아리의 작은 공개 서비스라면 기존 구조의 운영 비용을 먼저 관측하는 편이 현실적이다. **Cloud Functions 운영 배포에는 Blaze와 결제 계정이 필요하다.** Blaze에 무료 사용량이 있어도 과금 가능성이 사라지지 않는다. 프로젝트의 현재 요금제와 결제 상태는 저장소에서 확인할 수 없다. 비용 책임자가 Blaze를 허용하지 않으면 A안을 실행할 수 없으므로, 5-2단계 전에 C안을 별도 이관 프로젝트로 평가한다.

코드상 배포 차단 문제는 발견하지 못했지만 운영 가능 확정은 아니다. Firebase 프로젝트 권한·요금제, 해당 프로젝트의 함수 배포 권한, GBIS **사용 중인 각 서비스의 운영 승인·실제 한도**, Kakao 도메인 등록, 운영 Secret, 동시 사용자 부하를 확인해야 한다. `/api/health`의 `transitData: not-connected`는 기존 계약이며 실제 GBIS 연결 판정으로 사용하지 않는다. `GET /api/_metrics`는 에뮬레이터 전용이므로 운영 지표 수집은 별도 준비가 필요하다.

## 현재 코드의 요청 흐름

```text
로컬: localhost:5173 ─ Vite /api 프록시 ─ localhost:5000 Hosting 에뮬레이터
운영: https://bustrker.web.app ─ Hosting /api/** rewrite ─ api Function (asia-northeast3, Node 22)
                                                 └─ 프로세스 메모리 캐시/응답 검증 ─ GBIS
운영 정적 파일: Hosting dist ─ SPA /index.html rewrite
지도: 브라우저 ─ Kakao Maps JavaScript SDK
```

`firebase.json`의 Function rewrite가 SPA rewrite보다 앞선다. Vite 프록시는 개발 서버에만 적용된다. [Hosting과 Functions 연결](https://firebase.google.com/docs/hosting/functions)에 따라 같은 출처의 HTTPS `/api`를 사용하므로 현재 A안에서 별도 브라우저 CORS 허용은 필요하지 않다. 직접 Function URL은 별도 공개 진입점이 될 수 있으므로 CORS를 요청 제한 수단으로 취급하지 않는다. Hosting의 Function rewrite 응답 제한 시간은 공식 문서상 60초이며 서버의 GBIS 요청 제한은 8초다.

`functions/src/index.ts`는 GET만 허용하고 좌표, 노선 검색어, 숫자형 ID와 경로를 검사한다. Secret 누락은 503, GBIS 제한은 429, 상위 오류는 502, 시간초과는 504로 구분한다. 캐시 TTL은 주변 정류장 45초, 도착 10초, 검색 5분, 상세·경유 30분, 형상 1시간, 차량 20초다. 최대 300개 항목과 같은 키의 진행 중 요청 병합은 **한 프로세스 안에서만** 동작하며, 인스턴스가 늘거나 재시작하면 캐시가 공유되지 않는다. 운영용 `minInstances`, `maxInstances`, `concurrency` 및 전역 요청 제한은 아직 명시하지 않았다. 기본값을 배포 전 Firebase CLI/콘솔에서 확인하고, 수치 변경은 측정 후 결정한다. `minInstances=0`은 유휴 요금을 줄이지만 콜드 스타트가 가능하다. 최대 인스턴스 제한은 비용을 낮출 수 있는 대신 급증 트래픽에서 지연/실패를 만든다. [Functions 관리](https://firebase.google.com/docs/functions/manage-functions), [할당량](https://firebase.google.com/docs/functions/quotas).

## 플랫폼 비교

| 기준 | A. Firebase Hosting + Functions | B. Firebase Hosting + Workers | C. Workers Static Assets + Workers |
| --- | --- | --- | --- |
| 예상 비용 | Blaze 결제 계정 필수, 사용량이 무료 구간에 들면 `$0` 가능하지만 보장 불가 | Hosting과 Workers를 각각 관리; Worker Free 가능 범위는 일 10만 요청·CPU 제한 | 정적 자산 요청은 무료; API Worker Free 한도는 동일 |
| 무료 운영 가능성 | Blaze의 무료 할당량 안에서 가능, 초과 시 자동 과금 | Firebase Hosting 무료 할당량과 Workers Free를 각각 충족해야 함 | Worker Free 제한 안에서 가능, 초과 요청은 서비스 실패 |
| 기존 코드 재사용 | 거의 그대로; 설정·Secret만 운영 준비 | GBIS 파서/도메인 타입 재사용 가능, Firebase HTTP 진입점·Secret·캐시·계측은 재작성 | B의 서버 재작성 + 정적 배포·SPA 라우팅 이관 |
| 구현·운영 난이도 | 낮음; 현재 에뮬레이터와 배포 경로 일치 | 높음; 두 플랫폼, 별도 API 출처, CORS, 두 배포/롤백 | 높음; 하나의 배포 단위지만 전면 이관·회귀 QA 필요 |
| 키 보안 | Function Secret Manager 바인딩 | Worker Secrets로 별도 관리 | Worker Secrets로 별도 관리 |
| 호출량 대응 | 인스턴스별 캐시; 확장 가능하지만 비용·GBIS 호출 증가 | isolate별 상태 공유 불가, 전역 제한에는 추가 저장소 필요 | B와 동일; 정적 파일은 Worker 실행에서 분리 가능 |
| 응답 속도 | 서울 리전 사용, 콜드 스타트/GBIS 지연 측정 필요 | 가까운 에지에서 시작해도 GBIS 서버까지의 왕복 지연 존재 | B와 같고 동일 출처 API |
| 확장성 | 공급자 어댑터 구조 유지, 사용량 요금 증가 가능 | Worker 런타임 호환성 검증 필요 | B와 동일 |
| 장애·유지보수 | 기존 에뮬레이터/로그/Hosting 릴리스 재사용 | Firebase와 Cloudflare 양쪽 로그·장애 분리 필요 | Cloudflare 한곳이지만 기존 운영 문서 재작성 필요 |

**B안:** Firebase Hosting의 기존 `function` rewrite는 외부 Workers URL을 투명하게 프록시하지 않는다([Hosting 설정](https://firebase.google.com/docs/hosting/full-config)). 브라우저 API base URL을 `https://<worker>.<subdomain>.workers.dev` 같은 별도 주소로 바꾸고 Worker에서 정확한 Origin만 허용해야 한다. 프런트에 넣는 API 주소는 공개되므로 인증 수단이 아니다. 직접 호출도 가능하며 CORS는 서버 호출을 막지 못한다. 기존 Node/Firebase `onRequest`, `defineSecret`, 에뮬레이터 및 서버 캐시는 그대로 옮길 수 없다. GBIS `fetch`와 순수 TypeScript 변환·계약 테스트는 재사용 후보이나 Worker 런타임에서 새로 검증해야 한다. Worker Free는 일 10만 실행, 요청당 CPU 10ms, 메모리 128MB, 외부 subrequest 50회 제한을 확인해야 한다([요금](https://developers.cloudflare.com/workers/platform/pricing/), [제한](https://developers.cloudflare.com/workers/platform/limits/)). 대기 중인 `fetch` 시간은 CPU 사용 시간과 다르지만 파싱·변환 CPU는 측정이 필요하다. 한도 초과 시 Worker 경로는 Error 1027이 가능하고, Static Assets에서 `run_worker_first` 경로는 429가 가능하다. 무료 한도 초과를 정상 응답으로 가정할 수 없다.

**C안:** Cloudflare는 새 정적·SPA·풀스택 프로젝트에 **Workers Static Assets**를 권장하며 Pages를 신규 기본안으로 권하지 않는다([공식 모범 사례](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)). Vite `dist`와 Worker `main`을 한 배포에 묶고 `/api/*`만 Worker를 먼저 실행하게 구성하면 같은 출처를 유지할 수 있다([Static Assets](https://developers.cloudflare.com/workers/static-assets/), [assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)). 정적 자산 요청·저장은 무료이며 Worker 실행 요청은 별도 한도를 소비한다([과금](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). `workers.dev` 기본 도메인으로 시작할 수 있으나 Kakao 허용 도메인, SPA fallback, 오래된 Firebase URL 처리, 빌드/배포/롤백 자동화와 모바일 QA가 필요하다. Firebase에서 Cloudflare로 DNS/도메인을 지금 변경할 이유는 없다. 비용 책임자가 Blaze를 원하지 않거나 실제 Functions 요금/지연이 문제가 될 때만 검토한다.

## 2026-10-10 공식 요금·제한 근거

| 항목 | 공식 조건 | 이 프로젝트에 미치는 영향 |
| --- | --- | --- |
| Firebase Spark / Blaze | Spark는 결제 수단 없이 무료 한도, Blaze는 결제 계정이 필요한 종량제이며 일부 무료 한도를 포함([요금제](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)) | 2세대 Functions 배포는 Blaze 필요; 현재 프로젝트 요금제는 미확인 |
| Firebase Hosting | 저장 10GB 무료, 초과 `$0.026/GB`; [가격표](https://firebase.google.com/pricing)는 전송 360MB/일 무료, 초과 `$0.15/GB` | [Hosting 사용량 문서](https://firebase.google.com/docs/hosting/usage-quotas-pricing)는 월 10GB로 설명해 표기가 다르다. 5-2에서 콘솔/청구 단위를 확인하고 보수적으로 일별 제한을 기준으로 계획 |
| Cloud Functions | 월 200만 호출, 40만 GB·초, 20만 CPU·초, 외부 송출 5GB 무료; 초과 호출 `$0.40/100만`, 송출 표기 `$0.12/GB`([Firebase 가격표](https://firebase.google.com/pricing)) | 호출만 무료라고 판단 불가. 리전·실행 리소스·응답 크기와 네트워크 경로에 따라 청구액 변동 |
| 빌드·컨테이너·Secret | Cloud Build 120분/일, Artifact Registry 0.5GB 무료([Firebase 가격표](https://firebase.google.com/pricing)); Secret Manager는 활성 버전 6개와 접근 1만회/월 무료 이후 별도 과금([공식 가격](https://cloud.google.com/secret-manager/pricing)) | 배포 횟수·이미지 보관·Secret 버전/접근을 청구서에서 별도 확인. Secret 접근이 HTTP 요청마다 1회라고 단정하지 않음 |
| 서울 리전 | `asia-northeast3`는 [Cloud Run 지역별 가격](https://cloud.google.com/run/pricing)의 Tier 2 | 2세대 Functions는 Cloud Run 기반이다. 가격표의 대표 무료 수치만으로 서울의 정확한 CPU/RAM 요금을 계산하지 않음 |
| Workers | Free 10만 Worker 요청/일·요청당 CPU 10ms. Paid는 기본 `$5/월`, 월 1천만 요청과 3천만 CPU ms 포함 후 요청 `$0.30/100만`, CPU `$0.02/100만 ms`([요금](https://developers.cloudflare.com/workers/platform/pricing/)) | Free는 24시간 이용자 다수에서 중단 위험. Paid 전환도 결제 승인 필요 |

Google Cloud [예산 알림](https://docs.cloud.google.com/billing/docs/how-to/budgets)은 **지출 차단 장치가 아니다**. 2026년 10월 문서의 [Firebase spend caps](https://firebase.google.com/docs/projects/billing/spend-caps)는 Preview이고, [Cloud Billing spend caps](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)는 Cloud Run functions 같은 적격 서비스에 한정되며 적용 지연·초과 청구 가능성이 있다. Hosting/Build/Artifact Registry/Secret 등을 한꺼번에 막는 프로젝트 전체의 확실한 하드 캡으로 간주하지 않는다. 현재 프로젝트의 대상 적격성·사용 가능 여부는 콘솔 권한이 없어 미확인이다. 5-2에서 담당자가 적격성과 서비스 중단 영향(차단 시 API 불능)을 확인한 뒤 설정을 결정한다. 지금 어떤 결제/상한도 변경하지 않았다.

## 사용자 규모별 요청량과 비용 시나리오

계산은 **동시 접속 수가 아닌 하루 고유 사용자 수 `U`**를 가정한다. 각 사용자는 하루 한 세션, 표시 노선 3개를 처음부터 계속 켜고, 60초마다 노선당 차량 요청 1회(첫 요청 포함)한다. 주변 정류장 1회 + 노선 검색 1회 + 3개 노선 × (상세·형상·경유 정류장 3회) = **초기 11회**. 지도 이동, 정류장 도착 패널의 60초 갱신, 반복 검색, 숨김/복원, 실패 재시도, 지도 SDK/정적 파일은 제외한다. 따라서 하루 브라우저 `/api` 호출 = Function 또는 Worker 실행 ≈ `U × (11 + 3 × 사용분)`; 월은 같은 사용량 30일. 이 11회는 호출 절감이 없다고 보는 보수적인 초기 GBIS 상한에도 사용한다. API 서버 캐시 적중도 **서버 실행 1회**로 계산한다.

| 하루 사용자 | 15분/일: 하루 / 월 | 30분/일: 하루 / 월 | 60분/일: 하루 / 월 | 24시간/일: 하루 / 월 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 56 / 1,680 | 101 / 3,030 | 191 / 5,730 | 4,331 / 129,930 |
| 10 | 560 / 16,800 | 1,010 / 30,300 | 1,910 / 57,300 | 43,310 / 1,299,300 |
| 50 | 2,800 / 84,000 | 5,050 / 151,500 | 9,550 / 286,500 | 216,550 / 6,496,500 |
| 100 | 5,600 / 168,000 | 10,100 / 303,000 | 19,100 / 573,000 | 433,100 / 12,993,000 |

외부 GBIS 차량 조회는 캐시 때문에 위 숫자와 다르다. 모두 **서로 다른 3개 노선**을 보면 하루 차량 조회는 최악에 가까운 `3 × U × 사용분`건, 여기에 초기 조회 최대 `11U`건을 더한다. 예를 들어 100명 × 60분이면 차량만 18,000건/일, 초기까지 최대 19,100건/일이다. 모두 **같은 3개 노선**을 동시간에 보면 한 인스턴스의 20초 TTL과 진행 중 요청 병합으로 차량 GBIS 요청은 3~9건/분 정도다. 60분이면 180~540건/일, 초기 11건~1,100건/일은 좌표·검색어·정류장 선택과 캐시 시점에 따라 달라진다. 여러 인스턴스 `I`의 단순 차량 상한은 `min(3U, 9I) × 사용분`; 정확한 동기화·인스턴스 분산은 측정 전 미확정이다. 24시간 100명/서로 다른 노선이면 차량만 432,000건/일이다. 브라우저 탭이 숨겨지거나 오프라인이면 현재 코드의 주기 호출은 멈추므로 실제는 줄 수 있다.

| 시나리오 | A안의 **호출 수에만** 적용한 추가 요금 | B/C의 Worker 요청 한도 판단 |
| --- | --- | --- |
| 1·10·50·100명 × 15/30/60분 | 월 200만 호출 이내이므로 호출 요금 `$0` **가능** | 하루 10만 요청 이내; CPU·다른 Worker와 공유 한도는 별도 |
| 1명 × 24시간 | 월 129,930회 → 호출 요금 `$0` 가능 | 하루 4,331회 |
| 10명 × 24시간 | 월 1,299,300회 → 호출 요금 `$0` 가능 | 하루 43,310회 |
| 50명 × 24시간 | 월 6,496,500회 → 초과 4,496,500 × `$0.40/100만` ≈ **`$1.80/월`** | 하루 216,550회 → Free 초과; Paid 기본 `$5/월`부터 |
| 100명 × 24시간 | 월 12,993,000회 → 초과 10,993,000 × `$0.40/100만` ≈ **`$4.40/월`** | 하루 433,100회 → Free 초과; Paid 기본 `$5/월`부터 |

이는 **전체 청구액이 아니다**. A안의 GB·초, CPU·초, 외부 송출, Hosting 정적 전송, Build, Registry, Secret, 서울 리전 가격과 세금은 응답 크기·실행 시간·메모리·동시성·배포 빈도가 없어서 산정 불가다. 실제 월비용은 위 호출 요금보다 높을 수 있다. B/C Paid의 요청 포함량은 월 1천만이며 100명 × 24시간은 요청 초과 2,993,000 × `$0.30/100만` ≈ `$0.90`이므로 **기본료와 요청 요금만 약 `$5.90/월`**, CPU 및 추가 서비스는 제외한다. Free 한도에서는 돈 대신 요청 실패가 발생한다. [Firebase 가격](https://firebase.google.com/pricing), [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/). 사용자가 모두 같은 노선을 봐도 브라우저 API 실행 수는 줄지 않아 Functions/Workers 요청 과금에는 큰 절감이 없다. 절감되는 것은 GBIS 호출과 서버 처리 시간이다.

특히 100명이 서로 다른 노선을 15분씩 봐도 차량 조회만 4,500건/일이다. **GBIS 승인 한도가 가장 먼저 부딪힐 가능성**이 있다. 100명이 같은 3개 노선을 보더라도 서로 다른 인스턴스·위상 분산이면 절감률이 떨어진다. 100명 동시 접속을 실제 측정하거나 보장한 수치가 아니다.

## GBIS 승인과 사용 정책

[정류소](https://www.data.go.kr/data/15080666/openapi.do), [도착정보](https://www.data.go.kr/data/15080346/openapi.do), [노선](https://www.data.go.kr/data/15080662/openapi.do)의 공공데이터포털 공개 페이지는 무료, 이용허락범위 **제한 없음**, 개발계정 **신청 가능 트래픽 1,000**, 운영계정은 활용사례 등록 후 트래픽 증가 신청 가능으로 안내한다. 이는 **이 프로젝트 키의 승인 상태/실제 서비스별 일·초당 한도 확인이 아니다**. 단위와 증량 승인 여부는 포털의 내 활용신청·제공기관 안내에서 확인해야 한다. 버스위치정보의 현재 계정 승인·한도와 제공기관 별도 조건도 확인되지 않았다. 공식 오류코드 22(일일 제한), 23(초당 제한), 30(무효 키), 31(기간 만료), 20(접근 거부)은 [공공데이터포털 정류소 페이지의 오류 안내](https://www.data.go.kr/data/15080666/openapi.do) 및 개별 명세와 실제 응답을 대조해야 한다. 포털 서비스 소개와 계정별 이용약관은 다르다. 공개 페이지에서 법적 출처 표기 의무 또는 캐싱/재제공 금지를 확인하지 못했으므로 의무/허용을 단정하지 않는다. 화면에는 자료 출처와 조회시각을 투명하게 표시하고, 출시 전 계정별 약관·제공기관 답변을 확인한다.

현행 보호 장치: 브라우저의 숨김/오프라인 중지, 60초 주기, 실패 후 120/180초+지터, 인증 실패 자동 중단; 서버의 20초 차량 캐시·동일 키 진행 중 요청 병합·8초 타임아웃·GBIS 429 후 30초 프로세스별 신규 호출 억제. 반복 요청으로 캐시를 우회하거나 많은 다른 노선을 요청하는 공개 클라이언트에는 아직 전역 제한이 없다. 5-2에서 승인 한도의 **안전 여유분**을 기준으로 노선별·전체 GBIS 호출 예산, 초당 burst 상한, 429의 `Retry-After` 대응(제공되는 경우), 외부 오류율을 설계한다. 추가 재시도는 제한해야 한다. 공유 저장소 없는 프로세스 메모리 제한은 전역 보장이 아니므로 다중 인스턴스 제한으로 오인하지 않는다.

## Secret·공개 API 보안

- 개발: 루트 `.env.local`의 `VITE_KAKAO_MAP_APP_KEY`는 브라우저 번들에 포함되는 **공개 JavaScript 키**다. Kakao 개발자 콘솔에서 `localhost`와 운영 `https://bustrker.web.app`의 JavaScript SDK 허용 도메인을 확인한다. `functions/.secret.local`의 `PUBLIC_DATA_SERVICE_KEY`는 에뮬레이터 전용이다. `.gitignore`가 두 로컬 Secret 파일을 제외한다.
- 운영 A안: [Firebase Functions Secret](https://firebase.google.com/docs/functions/config-env)의 Secret Manager에 `PUBLIC_DATA_SERVICE_KEY`를 등록하고 `defineSecret` 바인딩이 있는 `api` Function을 배포한다. 로컬 파일을 운영 배포 아티팩트에 넣지 않는다. 키 변경 시 새 버전을 준비하고 함수를 다시 배포한 뒤 제한된 실제 요청으로 검증, 구 버전 폐기는 복구 기간 뒤 승인하에 한다. 키·요청 URL의 `serviceKey`·원본 응답·차량번호는 로그/오류 응답에 넣지 않는다. 누락 시 503을 표시하고 자동 반복 조회를 멈춘다. 운영 Secret 설정 명령은 5-2단계의 승인 후 실행한다.
- 대안 B/C: [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)로 설정하고 로컬은 `.dev.vars`를 사용한다. Firebase Secret과 자동 공유되지 않는다. `wrangler secret put`도 새 Worker 버전을 배포할 수 있으므로 5-1에서 실행하지 않는다.
- 공개 조회 API: CORS, Referer/Origin, 클라이언트 측 제한만으로 악성 서버 호출을 막을 수 없다. IP만 기준으로 차단하면 학교·공용 Wi-Fi 사용자를 함께 막을 수 있다. 먼저 현재 입력 길이·좌표·ID 검증, 경로 제한, 캐시, 외부 타임아웃을 유지하고, 운영 지표를 확인해 전역/노선별 호출 예산과 완만한 429를 도입한다. 로그인/CAPTCHA는 초기 필수로 두지 않는다. 직접 Function URL 우회와 다중 인스턴스 상태 공유를 포함해 정책을 시험한다.

## 배포 후 운영·장애 절차

| 증상 | 사용자 표시 / 운영 확인 | 대응과 복구 확인 |
| --- | --- | --- |
| GBIS 빈 차량 목록 | 정상 200/빈 목록, 조회시각 표시 | 시간대·노선 운행 여부 확인; 장애로 처리하지 않음 |
| GBIS 429/502/504 | 오류 패널; 이전 운행 구간을 현재처럼 유지하지 않음 | Function 로그의 **키 없는** 코드·지연·상태 확인, 승인 한도/GBIS 상태 확인, 재시도 폭주 방지, 제한 완화 전 성공 응답 확인 |
| 키 누락/거절 | 503/인증 오류, 자동 차량 재시도 중단 | Secret 바인딩·버전·승인 API 확인; 키 값 출력 없이 에뮬레이터/운영의 제한된 한 건으로 복구 확인 |
| Function 장애/콜드 스타트 | API 실패 안내, 지도 정적 화면은 유지될 수 있음 | Functions/Cloud Run 로그·인스턴스·오류율·지연 확인; 이전 정상 Function 릴리스로 복구. Hosting API rewrite와 정적 버전 호환 확인 |
| 캐시 소멸/사용자 급증 | 첫 요청 지연·GBIS 호출 증가 가능 | 인스턴스 수/GBIS 외부 호출·429/지연 확인; 필요 시 공개 API에 임시 전역 요청 예산/429 적용. 캐시를 실시간 진실로 취급하지 않음 |
| Kakao SDK 실패 | 지도 오류 상태 안내 | 키 허용 도메인·SDK 요청·Kakao 상태 확인; 서버 장애와 분리 |
| 예상 비용 초과 | 비용 관리자에게 알림 | 청구서의 Hosting/Run/Build/Registry/Secret 항목 구분, 트래픽 원인 조사, 임시 요청 제한·노선 갱신 축소를 검토. 예산 알림은 지출 차단이 아님 |

차량 운행 구간은 기존 코드의 **2분 초과 데이터 제거**와 오류 시 이전 강조 제거를 유지한다. 운영 계측은 키·원본 요청 URL·차량 식별자를 배제한 집계(HTTP 성공률/429/502/504, p50/p95, GBIS 호출 수, 캐시 적중/병합, 인스턴스 수, 리소스·네트워크 비용)를 수집해야 한다. `/_metrics`를 공개 운영 기능으로 켜지 않는다. 임시 서비스 중단은 관리자 승인하에 API 경로에 명시적 503 또는 Hosting 유지보수 페이지를 적용하고, 원인 해소 후 제한된 실 API 호출과 화면 운행 구간 확인으로 재개한다. 실제 배포 시 정적 Hosting 릴리스와 Function 버전을 함께 기록해 이전 정상 버전으로 복구한다. 새 코드가 이전 응답 계약과 호환되지 않으면 정적/서버를 한 쌍으로 되돌린다. 5-1에서는 이러한 변경을 실행하지 않았다.

정적 파일은 Vite 해시 자산의 장기 캐시와 HTML의 최신 버전 확인을 배포 뒤 응답 헤더로 검증한다. 현재 `firebase.json`에는 별도 헤더 규칙이 없으므로 특정 TTL을 보장하지 않는다. API는 현재 `Cache-Control: no-store`이며 **서버 내부 TTL**과 브라우저/CDN 캐시를 구분한다. `queriedAt`은 GBIS 조회 완료 시각이지 차량 GPS 측정시각이 아니다.

## 5-2단계 검증·실행 순서

### 로컬·모의 부하 시험 계획

**5-1에서 실제 측정한 범위:** 프런트/Functions 타입 검사와 빌드 통과, Functions 계약 테스트 23/23, 노선 구간 테스트 4/4, 차량 폴링 테스트 5/5, 로컬 에뮬레이터 보안 QA 3/3 통과. 에뮬레이터 `/api/health`는 HTTP 200과 `transitData: not-connected`를 반환했다. 캐시 단위 테스트는 **동시 요청 10건을 모의 로더 1건으로 합치는 한 프로세스의 동작**을 확인했다. 실제 GBIS 대량 요청, 10/50/100명 부하, 다중 인스턴스, 운영 비용·응답시간은 측정하지 않았다.

실제 GBIS에 대량 요청을 보내지 않는다. 모의 GBIS 서버 또는 `fetch` 주입 가능 테스트 어댑터에서 응답/지연/429/타임아웃을 통제하고 Firebase 에뮬레이터를 시험한다. 순서: (1) 같은 노선 10개 동시 요청의 GBIS 호출 병합 1건, (2) 서로 다른 노선 동시 요청, (3) 10/50/100명 각 15/30/60분의 60초 갱신 가속 모의, (4) 429·502·8초 타임아웃, (5) 인스턴스 재시작 뒤 캐시 소멸, (6) 갑작스러운 burst. 각 단계에서 요청 수, 성공/실패율, 평균/p95 HTTP 지연, GBIS 모의 호출 수, 캐시 적중/병합, 프로세스/인스턴스 수를 기록한다. 통과 목표는 승인된 GBIS 초·일 한도와 허용 지연을 확인한 뒤 정한다. 현재 `functions/test`의 동시 캐시 테스트는 단일 프로세스의 병합만 검증하며 **100명 성능 검증이 아니다**. 에뮬레이터 `GET /api/_metrics`는 해당 프로세스만 보여 준다.

### 체크리스트: 5-1에서 확인 / 5-2에서 실행

- [x] 저장소의 Hosting rewrite, Node 22, 서울 리전, 로컬 프록시와 Secret 바인딩 확인
- [x] 공식 요금·Workers 제한·GBIS 공개 페이지 확인 및 A안 잠정 선택
- [x] 기존 캐시, 입력 검증, 오류·백오프, 모바일 기능의 코드 경로 확인
- [x] 5-1 로컬 타입·빌드·계약/회귀/보안 테스트 및 에뮬레이터 health 확인 (위 측정 범위에 한함)
- [ ] 사용자: **현재 Firebase 요금제/결제 책임자와 Blaze 허용 여부** 결정. 승인 전 변경 금지
- [ ] 사용자: 공공데이터포털에서 정류소·도착·노선(검색/상세/형상/경유)·위치 API별 **키 승인 상태와 실제 일/초당 한도**, 운영계정 전환/출처·캐싱 조건 확인
- [ ] 사용량 가정/허용 월비용과 초과 시 서비스 제한 방침 결정; 예산 알림과 적격 spend cap의 차이 확인
- [ ] 운영 `PUBLIC_DATA_SERVICE_KEY`를 Secret Manager에 별도 설정, Kakao 운영 도메인 등록; `VITE_` 번들·Git 이력·로그에 서버 키가 없는지 점검
- [ ] 타입 검사, 프런트/Functions 빌드, 모든 계약 테스트, PC/모바일 지도·정류장·노선·운행 구간 회귀 검사
- [ ] 모의 GBIS로 10/50/100명·burst·429/504·재시작 시험, 전역 호출 예산/인스턴스 설정 결정
- [ ] Firebase 배포 전 `firebase.json`, 프로젝트 ID/권한/리전, 예상 요금, 변경 파일과 롤백 버전 확인 후 **사용자의 배포 승인** 획득
- [ ] 승인받은 5-2단계에서만 Secret 등록·배포; 제한된 실제 요청으로 `/api`, 지도, 60초 갱신, 오류 처리 검증
- [ ] 배포 후 비용·GBIS 할당량·오류율·지연을 관측하고 필요 시 요청 정책 조정

이 문서는 배포 명령을 실행하라는 승인이 아니다. 현재 Firebase/Cloudflare 운영 리소스는 변경하지 않았다.
