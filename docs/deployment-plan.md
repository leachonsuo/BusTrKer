# BusTracker 5-1단계 — 배포·비용·보안 계획

확인일: **2026-10-10**. 이 문서는 현재 저장소와 아래 공식 자료에 근거한 **배포 전 설계**다. 실제 배포, 요금제 변경, 운영 Secret 등록, 부하 검증은 하지 않았다. 가격은 미화이며 세금·환율·계정별 크레딧은 제외한다. 정책은 5-2단계 직전에 다시 확인한다.

**5-2A 갱신:** 아래 5-1 시나리오와 미확인 항목은 작성 당시 기록이다. 사용자가 확인한 서비스별 개발계정 한도와 이번 단계의 모의 부하 결과·배포 차단 조건은 문서 끝의 **5-2A 운영 보호 검증**이 최신 상태다. 실제 운영 배포는 여전히 진행하지 않았다.

**5-2B 최신 상태(2026-10-10):** 문서 끝의 **5-2B 배포 직전 확인**이 운영 환경·Node 22·Secret·성능·배포 판정의 최신 기록이다. 앞의 5-1/5-2A 미확인·403 내용은 당시 이력이다.

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

## 5-2A 운영 보호 검증 (2026-10-10)

### 계정에서 확인된 한도와 적용 범위

다음은 **사용자가 공공데이터포털 계정에서 확인해 제공한 개발계정 수치**다. [공개 포털의 서비스 소개](https://www.data.go.kr/data/15080666/openapi.do)와는 근거가 다르다. 운영계정 증량 여부, 실제 차감 단위, 초당 제한 및 공급자 기준 하루 시작 시각은 아직 미확인이다.

| 승인 API 서비스 | 사용자 확인 일일 한도 | 현재 앱 자동 호출 | 내부 기본 상한 |
| --- | ---: | --- | ---: |
| 경기도 버스노선 조회(검색·상세·형상·경유 공통) | 1,000 | 사용 | 최근 24시간 800 |
| 경기도 정류소 조회 | 1,000 | 사용 | 최근 24시간 800 |
| 경기도 버스위치정보 조회 | 1,000 | 사용 | 최근 24시간 800 |
| 경기도 버스도착정보 조회 | 1,000 | 사용 | 최근 24시간 800 |
| 전국 초정밀버스 위치 | 5,000 | 진단 전용 | 없음; 자동 조회 금지 |
| TAGO 버스위치정보 | 10,000 | 진단 전용 | 없음; 자동 조회 금지 |

800은 공식 한도가 아닌 내부 안전 여유다. 외부 진단 스크립트·다른 애플리케이션의 동일 키 사용은 이 앱 원장에 기록되지 않으므로 200회의 여유로도 실제 한도 준수를 확정할 수 없다. 상한은 서비스별 `GBIS_BUDGET_*`로 조절하되 1,000 초과와 잘못된 형식은 차단한다. 공급자의 리셋 시각을 확인하지 못해 KST/UTC 자정에 카운터를 비우지 않는다. 로컬 원장은 최근 24시간의 시도만 유지하는 보수적 창을 사용한다. 서버 시계가 역행하거나 원장이 손상되면 호출을 중단한다. 운영 활성화에는 제공기관의 차감·초당 제한·리셋 정책과 키의 다른 사용처 확인이 필요하다.

### 예산 저장소 방식 비교와 현재 결정

| 방식 | 동시성/재시작 | 비용·지연 | 결론 |
| --- | --- | --- | --- |
| `maxInstances=1` + 메모리 | 같은 프로세스의 동시성만 제어, 재시작·신규 리비전에서 0으로 초기화 | 추가 저장소 비용 없음 | 일일 한도 보장 불가. 운영 선택 안 함 |
| 로컬 잠금 파일 | 같은 파일을 공유하는 로컬 프로세스의 원자적 예약과 재시작 지속성 | 파일 I/O·잠금 대기, 운영 서버리스 디스크 공유 불가 | **에뮬레이터와 테스트에만 사용** |
| Firestore 트랜잭션 | 공유 DB의 서비스별 문서로 인스턴스 간 원자성·지속성 | 예약마다 읽기/쓰기, 충돌 재시도·핫 문서 지연 | **어댑터·demo Emulator 검증 완료; 5-2B에서 운영 DB 메타데이터 확인** |

현재 `functions/src/transit/budget.ts`는 외부 요청 직전 예약을 수행하고, 저장소 장애·잘못된 상한·매핑되지 않은 API에서 실패로 닫는다. 성공·HTTP 실패·네트워크 실패·타임아웃은 모두 예약을 소비하며 환불하지 않는다. 내부 재시도를 새로 넣으면 매번 별도 예약해야 한다. 브라우저 요청/Function 실행, 서버 캐시 적중·진행 중 병합, 예산 예약, 실제 GBIS 시도는 서로 다른 집계다. 내부 소진은 `429 INTERNAL_BUDGET_EXHAUSTED`, GBIS 자체 제한은 `429 UPSTREAM_RATE_LIMITED`, 안전한 저장소가 없으면 `503 BUDGET_UNAVAILABLE`로 구분한다. 예산 경고는 서비스명과 사용/상한만 기록한다. 한도 소진 뒤 사용자에게 재개 시각을 단정하지 않는다.

`FirestoreBudgetStore`는 기본 데이터베이스의 `bustracker_gbis_budget_v1/{service}` 네 문서에 `version`, `lastSeenAt`, 최대 1,000개의 `{id, at}` 예약을 저장한다. UUID는 같은 요청의 트랜잭션 재실행·커밋 응답 손실에서 중복 기록을 방지한다. **원자적 읽기·검사·예약 커밋 후** 트랜잭션 바깥에서 GBIS `fetch`를 한다. 운영 예약 시각은 Firestore 문서의 `readTime`을 쓰며, 에뮬레이터 경계 시험에만 주입 시계를 쓴다. Firestore 시각이 없거나 원장보다 뒤로 가면 503으로 닫는다. 실패한 외부 호출도 예약을 유지한다. 만료 기록은 다음 승인에서 제거하므로 TTL 삭제 비용은 없다. 문서당 수십 KiB로 예상되어 [1MiB 한도](https://firebase.google.com/docs/firestore/quotas) 아래지만 실제 크기·인덱스는 운영에서 측정해야 한다. 한 서비스당 하나의 문서는 burst에 핫스팟과 트랜잭션 재시도를 유발할 수 있다. 읽기부터 커밋까지의 지연으로 예약 시각과 실제 GBIS 요청 시각 사이에 작은 차이가 생길 수 있다. [공식 트랜잭션 설명](https://firebase.google.com/docs/firestore/manage-data/transactions), [DocumentSnapshot.readTime](https://googleapis.dev/nodejs/firestore/latest/DocumentSnapshot.html).

**Standard 기준 최소 작업량:** 네 서비스 합계 하루 3,200건을 모두 승인하면 문서 읽기 약 3,200회와 쓰기 약 3,200회다. 한도 초과 거절은 원칙적으로 문서 읽기 1회·쓰기 0회다. 인스턴스별 10초 거절 캐시는 거절만 재사용하므로 단일 인스턴스가 네 서비스 모두 소진 상태에서 지속 공격을 받으면 최악에 가까운 약 `4 × 8,640 = 34,560`회/일 거절 확인 읽기가 추가될 수 있고 인스턴스 수만큼 늘 수 있다. 충돌 재시도는 읽기를 더하며 실패한 트랜잭션의 청구량은 실제 청구 지표로 확인해야 한다. 저장소 연결 실패는 GBIS를 차단하지만 DB 요청 지연과 실패 요청 비용은 남을 수 있다. 네 문서 저장 비용은 작아도 무료 운영을 보장하지 않는다. [Standard 무료 할당량](https://firebase.google.com/docs/firestore/quotas)은 해당 프로젝트의 무료 대상 DB에 한해 읽기 5만/일, 쓰기 2만/일, 저장 1GiB이다. 다른 앱과 할당량을 공유하며 Enterprise는 [문서 크기 단위 과금](https://firebase.google.com/docs/firestore/enterprise/pricing)이 달라 이 계산을 그대로 적용할 수 없다. 장시간 거절 폭증 시 전역 rate limit, 인스턴스 상한과 청구 알림을 별도로 검토해야 한다.

5-2A 당시 읽기 전용 `firebase firestore:databases:list --project bustrker`는 Firestore API 미사용 또는 비활성 **HTTP 403**을 반환했다. **5-2B에서는 같은 프로젝트의 `(default)` Standard·서울 데이터베이스를 읽기 전용으로 확인했다.** 운영은 `GBIS_BUDGET_STORE=firestore`를 명시하고 실제 IAM·Secret이 준비되기 전까지 데이터 조회를 진행하지 않는다. 설정했어도 DB 연결·트랜잭션이 실패하면 503이다. `/api/health`의 기존 200 응답은 데이터 서비스 준비 판정이 아니다.

운영 준비 담당자는 Firebase 콘솔 Firestore Database에서 기존 `(default)` DB의 존재·Standard/Enterprise 에디션·위치를 읽기 전용으로 확인하고, 기존 다른 앱의 컬렉션 및 rules를 먼저 검토한다. 이 코드의 네 문서 컬렉션 이름과 충돌이 없어야 한다. 신규 DB 위치를 선택할 권한/승인이 있다면 서울 Functions `asia-northeast3`과 가까운 [서울 Firestore 지원 지역](https://docs.cloud.google.com/firestore/native/docs/locations)을 검토하지만 기존 DB의 위치를 바꾸거나 재생성하지 않는다. `attempts` 배열은 조회·정렬에 쓰지 않으므로 기존 인덱스 정책을 확인한 뒤 필요하면 필드 인덱스 제외를 설계해 쓰기 증폭을 줄인다. Admin SDK 서버 접근은 [IAM](https://firebase.google.com/docs/firestore/security/iam)으로 관리되고 [Security Rules를 우회](https://firebase.google.com/docs/firestore/security/insecure-rules)한다. Functions 서비스 계정의 읽기·쓰기 트랜잭션 권한을 확인하고, 웹 클라이언트에서 `bustracker_gbis_budget_v1`을 읽거나 쓸 수 없도록 기존 규칙과의 우선순위를 검토한다. 현재 rules 파일은 없어서 이번 단계에서 배포 규칙을 만들거나 덮어쓰지 않았다. 운영에서는 비밀이 아닌 `GBIS_BUDGET_STORE=firestore`와 `GBIS_BUDGET_*`를 승인된 `functions/.env.<project_ID>` 또는 Functions 환경 설정으로 제공한다([공식 환경 변수 문서](https://firebase.google.com/docs/functions/config-env)); `GCLOUD_PROJECT`는 런타임 예약 변수이므로 직접 설정하지 않는다. 운영 GBIS Secret `PUBLIC_DATA_SERVICE_KEY`는 기존 `defineSecret` 바인딩을 따르며 이 단계에서 등록하지 않았다.

### 로컬 모의 부하 실측

`npm --prefix functions run build` 뒤 `node scripts/bench-budget-mock.cjs`를 실행했다. **실제 GBIS 호출 0건**: 로컬 HTTP 서버가 GBIS의 정상 빈 차량 JSON을 반환하고, 가상 시계로 60초 차량 갱신을 진행했다. 사용자마다 3개 노선, 20초 서버 캐시, 0/10/25초의 세 요청 물결을 사용했다. 아래 표의 서버 요청은 **차량 API만**이며 첫 진입의 노선/정류소/도착 요청, 실제 브라우저 지도, Firebase 인스턴스, 네트워크 지연은 포함하지 않는다. 제한 뒤에도 가상 사용자가 계속 요청하는 스트레스 입력이므로 실제 프런트의 자동 중단 정책보다 429가 많다.

| 노선 분포·사용자 | 15분: 서버 / 모의 GBIS / 제한 | 30분: 서버 / 모의 GBIS / 제한 | 60분: 서버 / 모의 GBIS / 제한 |
| --- | ---: | ---: | ---: |
| 동일 3노선 · 10명 | 450 / 90 / 0 | 900 / 180 / 0 | 1,800 / 360 / 0 |
| 동일 3노선 · 50명 | 2,250 / 90 / 0 | 4,500 / 180 / 0 | 9,000 / 360 / 0 |
| 동일 3노선 · 100명 | 4,500 / 90 / 0 | 9,000 / 180 / 0 | 18,000 / 360 / 0 |
| 각자 다른 3노선 · 10명 | 450 / 450 / 0 | 900 / 800 / 100 | 1,800 / 800 / 1,000 |
| 각자 다른 3노선 · 50명 | 2,250 / 800 / 1,450 | 4,500 / 800 / 3,700 | 9,000 / 800 / 8,200 |
| 각자 다른 3노선 · 100명 | 4,500 / 800 / 3,700 | 9,000 / 800 / 8,200 | 18,000 / 800 / 17,200 |

한 번의 실행에서 100명·60분·동일 노선은 캐시 적중 5,940, 진행 중 병합 11,700, 성공률 100%, 평균 0.49ms·p95 1.10ms, 최대 관측 heap 43.7MiB였다. 100명·60분·다른 노선은 예산 거부 17,200, 성공률 4.44%, 평균 2.33ms·p95 4.81ms, 최대 관측 heap 155.6MiB였다. 두 경우 모의 서버 오류 0건이다. 이 지연/메모리 값은 **로컬 Node의 짧은 모의 응답·가상 시간**의 한 번의 측정이며 Firebase/GBIS 운영 성능이나 100명 수용 보장이 아니다. 예산 800이 서로 다른 노선의 정상 사용자에게 매우 빨리 소진될 수 있음을 보여 준다. 기존 5-1의 비용 계산은 요청 자체가 계속 발생한다고 본 상한 모델이며, 실제 5-2A의 자동 중단/예산 보호가 적용되면 GBIS 호출은 줄고 일부 기능은 중지된다.

기존 파일/메모리 단위 시험에서는 0/500/799/800 경계, 마지막 슬롯에 동시 20건의 정확한 1건 승인, 네 서비스 독립성, UTC·KST 자정 전후 무초기화, 시계 역행 거부, 별도 Node 프로세스 재시작 후 파일 사용량 유지, 여러 로컬 프로세스의 잠금 경쟁, 원장 손상/저장소 장애의 실패 닫기, 캐시 적중 무예약, 실패 요청의 예약 유지, GBIS 429의 서비스별 냉각을 확인했다. 추가한 **demo Firestore Emulator 시험**에서는 799건 뒤 50개 동시 예약 중 정확히 1개 승인, 별도 Node 프로세스 8개 중 한도 2개만 승인, 새 프로세스에서 거절 유지, 24시간 경계·만료 정리·문서 손상·모의 저장소 장애·커밋 응답 손실 재시도·모의 GBIS 실패와 캐시/병합을 검증했다. 50개 동시 요청 시험은 로컬 실행마다 약 8~42초로 편차가 컸다. 정확성 검증과 별개로 한 문서의 경쟁 지연이 실제 HTTP 응답 시간에 미치는 영향을 운영 전 부하 시험에서 확인해야 한다. 실제 운영 Firestore의 성능·청구·IAM·다중 Functions 인스턴스 동작을 검증한 결과는 아니다.

이전 5-2A 검사에서 프런트와 Functions 타입 검사·빌드, Functions 테스트 **32/32**, 노선 구간/차량 폴링 테스트 **10/10**, 로컬 API 보안 QA **3/3**이 통과했다. 이번 보완의 검사 결과는 별도로 보고하며 Firestore Emulator 시험은 **8/8**이다. `firebase.json`은 기존 Hosting/Functions 경로를 유지하면서 Firestore Emulator만 추가했다. Git 변경을 초기화하거나 스테이징하지 않았다.

로컬 브라우저 QA는 기존 개발 서버·에뮬레이터와 소수의 실제 GBIS 조회로 수행했다. 지도·주변 정류장, 11번 노선 검색·실제 노선형상 972좌표와 화살표, 노선 5개 선택·색상·숨김/복원/삭제, 경유 정류장 104개, 390px/320px 모바일 레이아웃, 브라우저 예외 0건을 확인했다. 9709N의 운행 차량 목록은 정상적인 **0대**였고 브라우저의 차량 API 요청이 약 60초 간격으로 **2건** 발생했다. 따라서 자동 갱신은 확인했으나 **차량 구간 강조와 차량 선택은 실데이터로 확인되지 않았다**. 첫 브라우저 QA 직후 에뮬레이터 한 프로세스 계측에서 정류소 11회·노선 10회·위치 3회·도착 1회 예약과 동일한 외부 호출 시도를 확인했다. 이후 60초 폴링 QA 호출은 이 스냅샷 수치에 포함하지 않는다. 다른 인스턴스·외부 스크립트의 호출도 포함되지 않는다.

### Functions 설정과 보안 검토

현재 코드 옵션은 `region: asia-northeast3`, `cors: false`, `PUBLIC_DATA_SERVICE_KEY` Secret 바인딩이며 `functions/package.json`은 Node.js 22다. `firebase.json`의 Hosting `/api/**` → `api` rewrite는 유지했다. `minInstances`, `maxInstances`, `concurrency`, `memory`, `timeoutSeconds`는 현재 명시하지 않았다. 5-2A의 **측정 전 후보** `0/2/20/512MiB/30초`는 5-2B 측정과 순차 요청 상한을 반영해 아래에서 재평가한다. [Functions 인스턴스·동시성 문서](https://firebase.google.com/docs/functions/manage-functions), [Hosting 60초 제한](https://firebase.google.com/docs/hosting/serverless-overview). 인스턴스 수 제한만으로 일일 예산을 보장할 수 없다.

현재 보안 QA는 잘못된 좌표·긴 검색어·잘못된 ID·HTTP 메서드 차단, 무분별한 CORS 헤더 부재, 프런트 번들에 `PUBLIC_DATA_SERVICE_KEY` 문자열이 없음을 확인한다. `.env.local`과 `functions/.secret.local`은 Git 제외 대상이다. `firebase.json`의 Functions 업로드 제외 목록에는 [Firebase CLI 기본 제외 항목](https://firebase.google.com/docs/cli/)과 함께 로컬 Secret·환경 파일·예산 원장을 넣었다. 운영 전에는 Git 이력·실제 업로드 패키지·빌드 산출물에 실제 키가 없는지 다시 확인하고, Secret Manager의 운영 키를 등록해야 한다. 카카오 JavaScript 키는 브라우저 공개 키라 허용 도메인을 확인한다. 직접 Function URL도 같은 예산 검사 코드를 지나지만, Origin/Referer/CORS 자체는 서버 간 직접 호출을 차단하지 못한다. `/_metrics`는 에뮬레이터 코드 분기에서만 제공한다. 불필요한 404 경로가 Hosting SPA HTML로 흘러가지 않는지도 배포 전 확인한다.

### 5-2B 공개 배포 차단 조건과 실행 순서

1. **차단:** 공유 예산 어댑터와 demo Emulator 검증, 실제 `(default)` Standard·서울 DB 메타데이터는 확인했다. 사용자가 제시한 클라이언트 전체 차단 Rules는 유지한다. Functions 실행 서비스 계정·Firestore IAM과 운영 Secret은 아직 준비되지 않았다. 이를 확인하고 제한된 검증을 끝낼 때까지 공개 배포를 진행하지 않는다.
2. **차단:** 공공데이터포털/제공기관의 서비스별 차감 방식, 초당 제한, 일일 초기화 기준과 동일 키의 외부 사용량을 확인한다. 운영계정 전환/증량 여부와 데이터 출처·재제공 조건도 확인한다.
3. 비용 책임자와 Blaze/Firestore 사용 여부, 허용 비용·예산 알림/서비스별 spend cap의 중단 영향, 운영 Secret 등록과 Kakao 운영 도메인을 승인한다. 실제 설정은 이 단계에서 변경하지 않았다.
4. 모의 GBIS + Firebase/Firestore 에뮬레이터로 HTTP 경로, 10/50/100명 burst, PC/모바일 지도·정류장·도착·노선·차량 구간과 60초 갱신을 재시험한다. Firestore 저장소 단위의 50건 경쟁·재시작 시험은 완료했지만 실제 운영 성능으로 대체하지 않는다.
5. 배포 승인 후에만 설정·Secret·코드·정적 Hosting을 함께 검토하여 배포하고, 제한된 실제 GBIS 요청 및 청구/할당량/오류 지표로 확인한다. 이상 시 이전 정상 릴리스로 되돌린다.

**5-2A의 로컬 기술 검증과 5-2B 배포 가능 판정은 별개다.** 최신 상태는 아래 5-2B 절을 따른다.

## 5-2B 배포 직전 확인 (2026-10-10)

### 운영 메타데이터와 접근 권한

- `firebase projects:list`와 저장소 `.firebaserc`에서 대상 프로젝트 `bustrker`를 확인했다. 사용자는 Firebase Console의 **Blaze 활성화**를 직접 확인했다. CLI 프로젝트 목록은 결제 상태를 표시하지 않으므로 Blaze는 사용자 확인 정보다.
- 읽기 전용 `firebase firestore:databases:list/get --project bustrker`에서 `(default)` 데이터베이스가 **Standard·Firestore Native·`asia-northeast3`(서울)**임을 확인했다. 운영 문서를 읽거나 쓰지 않았다.
- 사용자가 제시한 운영 Security Rules는 `allow read, write: if false`다. 이 단계에서 원격 규칙을 별도 조회하거나 수정하지 않았다. [Admin SDK 서버 접근은 Rules를 우회하고 IAM을 사용](https://firebase.google.com/docs/firestore/security/insecure-rules)한다.
- 코드의 `api` Function은 `region: asia-northeast3`와 Secret 바인딩을 지정하지만 **`serviceAccount` 옵션은 없다**. `firebase functions:list --project bustrker` 조회가 실패했고 이 환경에 `gcloud`가 없어 실제 배포 함수의 실행 서비스 계정과 IAM을 확인하지 못했다. 기본 계정을 추정하지 않는다. 배포 담당자가 Cloud Functions/Cloud Run 서비스 세부정보의 런타임 서비스 계정을 확인하거나, 별도 계정을 명시적으로 지정한 뒤 해당 계정의 권한을 확인해야 한다. Firestore 트랜잭션은 `datastore.databases.get`, 문서 읽기는 `datastore.entities.get`, 새 문서/기존 문서 기록은 `datastore.entities.create`와 `datastore.entities.update`가 필요하다([Firestore IAM 권한표](https://firebase.google.com/docs/firestore/security/iam)). 사전 정의 역할을 사용한다면 `roles/datastore.user`가 후보이며 Owner/Editor는 피한다. 부여 범위와 다른 기존 데이터 접근 영향을 검토하고 이번 단계에서 권한을 변경하지 않았다.
- `firebase functions:secrets:get PUBLIC_DATA_SERVICE_KEY --project bustrker`는 **404, Secret 미등록**을 반환했다. 값 자체는 조회하지 않았다. `functions/src/transit/secrets.ts`의 `defineSecret`이 `api` Function에 바인딩되고, 누락되면 데이터 경로가 503으로 닫힌다. 운영 등록 후 [참조 함수를 재배포해야 새 Secret 버전이 적용](https://firebase.google.com/docs/functions/config-env)된다.

### 로컬·운영 설정과 Node 22 검증

비밀이 아닌 `functions/.env.bustrker`를 `GBIS_BUDGET_STORE=firestore`와 네 서비스의 `GBIS_BUDGET_*=800`만 포함해 준비했다. [Firebase CLI의 프로젝트별 dotenv 규칙](https://firebase.google.com/docs/functions/config-env)에 따라 `bustrker` 배포 대상에서 로드된다. 이 파일은 기존 `.gitignore`의 `.env.*` 규칙으로 Git 제외되므로 다른 배포 컴퓨터에는 별도 복사/검토가 필요하다. `functions/.env.local`은 **에뮬레이터 전용**으로 `GBIS_BUDGET_STORE=file`을 지정해 기존 로컬 파일 원장을 유지한다. [에뮬레이터는 `.env.local`을 프로젝트 파일보다 우선](https://firebase.google.com/docs/functions/config-env)한다. `functions/.secret.local`은 로컬 Secret만 포함하며, 운영 키를 일반 dotenv에 넣지 않는다.

로컬 전역 Node는 24.16.0이지만 `node@22`의 **22.23.3**으로 `npm run typecheck`, `npm run build`, Functions 타입 검사·빌드/테스트, 노선 구간·차량 폴링 테스트와 demo Firestore Emulator 테스트를 다시 실행했다. 결과는 프런트 타입·빌드 통과, Functions 계약/단위 **34/34**, 구간 **4/4**, 폴링 **6/6**, 로컬 보안 QA **3/3**, Firestore Emulator **8/8**이다. 새 예산 저장소 무응답 시험은 12초 후 503으로 닫히며 GBIS 요청을 보내지 않았다. Emulator는 실제 GBIS 호출 0건과 `demo-bustracker-budget` 프로젝트 가드로 실행했다. 이는 **운영 Firestore에 연결한 결과가 아니다**.

### 경쟁·지연 측정과 함수 옵션

Node 22와 Firestore Emulator의 두 차례 실행에서 799건을 기록한 뒤 동시 예약 50건은 매번 **1건만 승인**됐다. 개별 예약 지연 평균 **3.5~3.6초**, p95 **4.0~4.2초**, 최대 **4.0~4.2초**, 트랜잭션 콜백 실행은 매번 100회(최초 50회 외 재실행 **50회**)였다. 800건 소진 뒤 새 인스턴스의 첫 거절 확인은 **32.8~34.2ms**, 같은 인스턴스의 10초 거절 캐시 적중은 표시 정밀도에서 **0.0ms**였다. 별도 Node 프로세스 8개의 예약 구간은 평균 **5.9~6.5초**, p95/최대 **6.6~6.8초**였고 한도 2건만 승인됐다. 프로세스 구간 값은 프로세스 시작 시간을 제외한다. 측정값은 로컬 장치·에뮬레이터 결과이며 이전 실행의 50건 **전체** 8~42초 편차와도 다른 지표다. 운영 p95/비용/충돌률은 미확인이다.

기존 후보 `minInstances:0`, `maxInstances:2`, `concurrency:20`, `memory:512MiB`, `timeoutSeconds:30`은 **그대로 적용하지 않는다**. 30초는 예산 예약 최대 12초와 GBIS 요청 타임아웃 8초가 두 번 순차 발생할 수 있는 차량·경유 정류장 캐시 미스에서 계산상 최대 약 40초를 허용하지 못한다. 초기 검토안은 `minInstances:0`, `maxInstances:2`, `concurrency:10`, `memory:512MiB`, `timeoutSeconds:50`이며 **코드에 적용하지 않았다**. 0 최소 인스턴스는 유휴 비용을 줄이지만 콜드 스타트가 있고, 최대 2개/동시성 10은 급증 요청을 대기·429로 돌릴 수 있다. 50초도 [Hosting rewrite 60초 제한](https://firebase.google.com/docs/hosting/serverless-overview)과 차이가 작으므로 운영 전 동시 요청·콜드 스타트·연쇄 GBIS 조회의 지연을 측정해 최종값을 정한다. [2세대 Functions 동시성·옵션](https://firebase.google.com/docs/functions/manage-functions).

### 호출량·보안·비용

네 GBIS 서비스의 내부 800회 예산은 각각 독립이고, 노선 검색·상세·형상·경유는 하나의 `routes` 예산을 쓴다. 외부 `fetch` 직전에 Firestore 예약 커밋이 필요하다. 저장소 장애·12초 무응답·문서 이상은 503으로 외부 호출을 차단하고, 캐시 적중/같은 요청 병합은 예약하지 않는다. 소진은 429이며 차량·도착 자동 갱신은 중단하고 낡은 구간을 현재처럼 유지하지 않는다. 동일 공공데이터 키를 사용하는 외부 프로그램의 호출은 **이 원장에 포함되지 않는다**. 800회는 사용자 확인 개발계정 1,000회보다 낮지만 공공데이터 제공기관의 차감 방식과 다른 사용처를 확인해야 한다.

최대 승인 3,200건만 고려하면 Standard Firestore 기본 문서 읽기·쓰기는 각각 약 3,200회/일이다. 한도 소진 뒤 거절 요청은 인스턴스별 최대 10초 캐시에도 지속 공격 시 서비스 네 개 합계 약 **34,560 추가 읽기/인스턴스·일**에 이를 수 있고, 충돌 재시도 읽기도 더해진다. [Standard 무료 할당량](https://firebase.google.com/docs/firestore/quotas)은 대상 무료 DB와 다른 사용량을 공유하며 무료 운영을 보장하지 않는다. GBIS 예약 상한은 **Functions 요청/CPU·메모리, Firestore 거절 읽기, Hosting 전송량, Secret Manager, Cloud Build/Artifact Registry 비용을 제한하지 않는다**. 공개 API는 로그인 없이 직접 호출할 수 있고 CORS만으로 서버 요청을 막지 못한다. 당장은 캐시·중복 병합·거절 캐시·인스턴스 상한 후보와 청구/오류 알림을 검토하고, 비정상 트래픽이 측정되면 별도 승인 하에 전역 요청 제한 방식을 설계한다. 단일 인스턴스 메모리 카운터는 다중 인스턴스의 전역 제한이 아니다.

루트 `.env.local`의 Kakao JavaScript 키가 비어 있지 않고 Node 22 Vite 빌드 클라이언트에 포함된 것을 **값 출력 없이** 확인했다. JavaScript 키는 공개 클라이언트 키이므로 운영 `https://bustrker.web.app` 도메인의 Kakao 개발자 콘솔 등록 여부는 담당자가 직접 확인해야 한다. `firebase hosting:sites:list --project bustrker`에서 해당 기본 URL을 확인했다. `firebase.json`은 `/api/**`를 서울 `api` Function에 먼저 연결하고 나머지를 `/index.html`로 보내며 Vite 프록시는 로컬 전용이다. 보안 QA에서 빌드 클라이언트에 `PUBLIC_DATA_SERVICE_KEY` 이름이 없음을 확인했다. 서버 Secret의 실제 값은 브라우저 번들·문서·로그에 넣지 않는다.

### 승인 후 배포·검증·롤백 순서 (이번 단계에서 실행하지 않음)

1. 담당자가 Kakao 운영 도메인, 공공데이터 서비스별 키 승인/별도 사용처, 허용 비용·알림, 실제 Functions 실행 서비스 계정 및 Firestore IAM을 확인한다. 사용자 제공 Rules의 원격 적용 상태도 Firebase Console에서 다시 확인한다. 안전한 이전 릴리스 또는 503 차단 구성을 롤백 대상으로 정한다.
2. 승인 후 운영 `PUBLIC_DATA_SERVICE_KEY`를 Secret Manager에 등록한다. 값은 대화·명령 인자·로그에 남기지 않고 CLI의 대화형 입력을 사용한다. 등록 뒤 **metadata 조회만** 하고 `api` Function을 재배포해야 새 버전이 적용된다. 이 단계에서는 등록하지 않았다.
3. 배포 직전 `git status`와 빌드 산출물, `functions/.env.bustrker`의 비밀 없음, 프로젝트 ID `bustrker`, Hosting rewrite와 Secret 바인딩을 재확인한다. 명시적 배포 승인 후에만 Functions `api`와 Hosting을 배포한다. CLI에서 `.env.bustrker`가 로드됐는지 확인한다.
4. 공개 후 `/api/health` 200을 확인하되 `transitData: not-connected`를 데이터 준비 증거로 사용하지 않는다. 승인된 키로 주변 정류장·도착·노선·차량을 **소수 요청**만 검사하고, PC/모바일 지도·60초 갱신·오류 상태를 검증한다. Firestore 예약 문서/오류 지표와 Functions/Firestore/Hosting/Secret/Build 청구를 관측한다.
5. 문제 발생 시 무제한 GBIS 호출이 가능한 과거 코드로 되돌리지 않는다. 안전한 이전 예산 보호 버전이 없으면 `GBIS_BUDGET_STORE`를 미지원 값으로 바꿔 **503 fail-closed** 상태로 재배포하고, 원인을 수정한 뒤 다시 제한된 검증을 한다. Hosting 화면을 이전 릴리스로 돌릴 때도 API가 안전한 상태인지 별도 확인한다. 이 롤백 절차 역시 향후 승인 후에만 실행한다.

**판정:** A 기술적 검증 **조건부 통과**(Node 22·demo Emulator 검증 완료, 운영 IAM/지연 미확인). B 운영 설정 준비 **미완료**(Secret 404, 실행 서비스 계정·IAM 및 Kakao 도메인 미확인). C 실제 배포 **불가**(차단 항목 해결 및 별도 명시적 승인 전).
