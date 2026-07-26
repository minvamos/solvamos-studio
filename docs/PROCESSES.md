# SolVamos 핵심 프로세스

> 기준: 2026-07-25 현재 코드

## 1. 사용자 가입과 workspace

### Email/password

1. `POST /api/auth/register`
2. password 정책 검사 및 hash 저장
3. shared Lab tenant 확보
4. `User`, `TenantMember(owner)`, `Session` 생성
5. auth/refresh HttpOnly cookie 발급

### Google

Google OAuth는 `login`, `signup`, `link` intent를 지원한다.

- identity: OpenID email/profile
- Drive: `drive.readonly`
- token: server-side `Session`에 저장
- 기존 password 계정은 로그인 후 Google link 가능

### 현재 tenancy 정책

현재 기본값은 shared Lab project다. 계정마다 별도 GCP project를 만드는 것이 아니라, 한 GCP project 안에서 DB tenant/membership/ownership으로 격리한다.

isolated tenancy는 목표 상태다. `TENANCY_MODE=isolated`, Org/folder/billing config가 있으나 기본 비활성이고 운영 검증 전에는 활성화하지 않는다.

## 2. 에이전트 생성

사용자 입력:

- 이름
- 역할/custom role
- tone
- security level
- AI app type
- 지식 source
- 호출 fee

생성 pipeline:

1. 사용자와 tenant를 확인한다.
2. role/tone/security로 system prompt를 컴파일한다.
3. 에이전트 전용 Solana vault를 생성한다.
4. private key를 Secret Manager/KMS에 저장한다.
5. `Agent(CREATING)`을 먼저 저장한다.
6. Datastore와 AI Applications Engine을 생성한다.
7. source를 ingest한다.
8. `vertexDataStoreId`, `vertexEngineId`, 상태를 저장한다.
9. `AgentOwnership`과 `CatalogAgent`를 upsert한다.
10. Catalog service로 publish한다.

상태 의미:

- `CREATING`: vault/리소스 생성 중
- `INDEXING`: Datastore/Engine 생성 또는 문서 crawl/import가 아직 정상 답변 가능 상태가 아님
- `ACTIVE`: 생성 pipeline이 완료되어 호출 가능
- `PAUSED`: listing/호출을 운영상 일시 중지
- `ERROR`: 복구 또는 재프로비저닝 필요

주의: 현재 상태는 실제 Discovery Engine operation을 지속 polling한 결과라기보다 생성/import 결과를 바탕으로 저장된다. 운영에서는 별도 reconciliation job이 필요하다.

## 3. 지식 source별 처리

### 공개 웹사이트

1. `website_url` 또는 `websiteUri`가 들어오면 app type을 `website`로 강제한다.
2. Datastore를 `PUBLIC_WEBSITE`로 만든다.
3. URL에서 hostname을 추출한다.
4. `hostname/*`를 INCLUDE target site로 등록한다.
5. `https://hostname/` recrawl을 best-effort 요청한다.
6. Engine을 Datastore에 연결한다.

웹사이트 지식은 사용자 채팅 때마다 live crawl하지 않는다. 등록된 Datastore index를 검색한다.

### Google Drive

1. Google OAuth Drive token을 확인한다.
2. 선택 파일 또는 폴더를 최대 depth 2까지 순회한다.
3. Docs/Sheets/text는 text로 export/download한다.
4. PDF는 raw bytes로 보존한다.
5. local corpus와 `RagDocument` mirror를 만든다.
6. Discovery Engine documents import를 실행한다.

현재 제한:

- 최대 25개 파일
- 파일당/전체 text 크기 제한
- 폴더 depth 2
- Google native type 지원 범위 제한

### 로컬 업로드

- text/md/json/csv/html/xml/yaml류: browser 또는 server에서 text
- PDF: base64 raw bytes
- 최대 25개, text 2MB, PDF 8MB
- 생성 후 추가 업로드는 append

이 업로드는 **에이전트 지식 적재**다. 채팅 turn의 첨부와 구분한다.

### 구조화/GCS/API source

UI와 type catalog에는 source 정의가 있으나, 모든 connector가 완전 자동 ingest되는 것은 아니다. GCS/API/Vertex Studio 유형은 현재 빈 Datastore 준비 또는 운영 connector 설정 성격이 강하다.

## 4. owner test chat

1. UI가 `X-SolVamos-Studio: 1`, `studioTest: true`로 요청한다.
2. 서버가 로그인과 tenant membership 또는 `AgentOwnership`을 검증한다.
3. 소유자면 listing fee와 무관하게 paywall을 생략한다.
4. 최근 12개 turn과 Engine session을 전달한다.
5. 기본 텍스트면 Engine Answer API를 우선한다.
6. 답변, citation, related questions, session, tool trace를 반환한다.

owner test는 상품 결제 테스트가 아니라 에이전트 품질·지식 검증용이다.

## 5. 채팅 첨부와 웹검색

### turn 첨부

지원:

- image
- PDF
- text/markdown/json/csv

처리:

1. UI에서 최대 8개를 준비한다.
2. 각 파일은 최대 8MB로 제한한다.
3. JSON body의 base64로 전송한다.
4. 서버가 MIME과 data URL prefix를 정리한다.
5. Datastore에서 질문 관련 context를 검색한다.
6. 파일은 Vertex Gemini `inlineData`로 전달한다.

현재 첨부는 메모리 기반 turn input이다. Datastore에 자동 보존하지 않는다.

### 실시간 웹검색

1. 사용자가 웹검색 토글을 켠다.
2. Datastore 검색을 먼저 수행할 수 있다.
3. Vertex Gemini에 `googleSearch` tool을 제공한다.
4. tool이 모델/리전에서 거절되면 tool 없이 재시도하고 trace에 unavailable을 남긴다.

live web 결과의 URL/citation을 현재 UI citation 모델에 완전히 정규화하는 작업은 남아 있다.

## 6. 외부 무료 호출

1. Catalog에서 `fee_usdc=0`인 agent를 찾는다.
2. `invoke_url`은 Studio `/api/agents/:id/invoke`다.
3. JSON `{ "prompt": "..." }`로 호출한다.
4. Studio가 paywall 없이 `runAgentInvoke`를 실행한다.

외부 호출에서는 `enableA2A`가 명시적으로 false가 아니면 peer 사용이 허용될 수 있으므로, 운영 정책과 예산 제어를 추가해야 한다.

## 7. 외부 유료 호출

정식 경로:

1. Catalog `/api/catalog` 또는 agent detail에서 `invoke_url`을 얻는다.
2. client가 pay-gateway `/v1/agents/:id/invoke`를 호출한다.
3. gateway가 HTTP 402 x402/MPP 조건을 반환한다.
4. pay CLI/지갑이 Devnet USDC를 결제한다.
5. gateway가 결제 완료 요청을 Studio의 같은 `/v1/...` 경로로 proxy한다.
6. gateway가 `X-Pay-Internal-Secret`을 주입한다.
7. Studio는 secret을 검증하고 별도 paywall 없이 `runAgentInvoke`를 실행한다.

금지:

- 유료 요청을 Studio `/api/agents/:id/invoke`에서 직접 정산
- `X-PAYMENT-PROOF`를 Studio origin에 붙여 우회
- production Catalog에 localhost gateway URL 게시

## 8. A2A

owner가 A2A toggle을 켜거나 외부 invoke가 peer 사용을 허용하면:

1. 자기 Engine/Datastore 답변을 만든다.
2. confidence와 불확실성 heuristic으로 충분성을 판단한다.
3. Catalog에서 자신을 제외한 peer를 읽는다.
4. 무료 peer를 먼저 계획한다.
5. 필요할 때만 유료 peer를 gateway를 통해 호출한다.
6. 성공 답변만 context로 합성한다.
7. 실패 시 payment/gateway 오류를 최종 사용자 답변으로 노출하지 않고 self best-effort로 복구한다.

향후 필요한 정책:

- turn당 최대 USDC 예산
- 유료 peer 호출 전 사용자 승인
- 동일 peer loop 방지와 depth 제한
- hop timeout/latency/cost trace
- peer provenance와 citation

## 9. Catalog publish

create/update:

1. Studio가 DB `CatalogAgent`를 upsert한다.
2. Catalog service write API에 admin secret으로 publish한다.
3. Catalog는 shared DB를 사용하면 동일 row를 읽는다.
4. Catalog는 public DTO에 page/API/markdown/agent-card URL을 붙인다.

delete:

1. listing status를 `unlisted`로 바꾼다.
2. `Agent`를 삭제한다.
3. Catalog remote unlist를 best-effort 호출한다.

Catalog cold start에서는 Studio가 bulk hydrate할 수 있다. 운영 DB가 설정된 경우 file fallback은 사용하지 않는다.

## 10. settlement

현재 DB와 UI:

- `PaymentSettlement`
- 사용자 소유 agent 기준 `/api/settlements`
- Solana Explorer URL

부분 구현 (native MPP split + Critical 패치):

- **유료 gateway 결제(목표)**: pay.sh `recipients` + `metering.splits`로 **한 TX**에  
  판매자 에이전트 vault ≈90% + `PLATFORM_TREASURY` 나머지 ≈10%.  
  가격은 Catalog `feeUsdc`(에이전트별)이며 하드코딩 `0.001`이 아님.
- Internal invoke는 receipt 헤더가 있으면 `PaymentSettlement`(`gateway_receipt`)만 기록.  
  기본값으로 operator→seller **2차 payout 없음** (`GATEWAY_LEGACY_PAYOUT=true`일 때만 구경로).
- receipt 헤더가 없으면 invoke는 될 수 있으나 원장 기록/레거시 payout 없음.
- A2A proof replay는 파일 캐시 + `PaymentSettlement.signature`로 이중 차단.
- pay-gateway → Studio receipt 헤더 inject는 아직 follow-up ([ROADMAP](./ROADMAP.md) P0.2).

남은 완료 프로세스:

1. gateway가 verified receipt를 signed header로 origin에 전달
2. refund/dispute/failed 상태 모델 추가
3. webhook audit log
4. 로컬 managed gateway(`pay-gateway-manager`)에도 per-agent split YAML 생성 정렬

## 11. 배포

권장 순서:

1. Prisma migration 적용
2. Studio 이미지 build/push/deploy
3. Catalog 이미지 build/push/deploy
4. gateway 이미지 build/push/deploy
5. Studio env에 public Catalog/gateway/origin URL과 shared secret 연결
6. Catalog env에 DB, Studio, gateway URL 연결
7. gateway env에 origin URL과 internal secret 연결
8. health/readiness 확인
9. Catalog listing의 paid invoke URL 검사
10. 신규 website agent로 target site/crawl/Engine 검증

기존 website agent는 이전 `CONTENT_REQUIRED` 또는 잘못된 pattern으로 만들어졌을 수 있으므로 재생성 또는 reconciliation 도구가 필요하다.

## 12. 장애별 대응

### Engine ID 없음

- Datastore만 있는 legacy/부분 생성 상태
- agent를 다시 저장하거나 Engine reprovision
- Engine 생성 IAM/API/LLM add-on 확인

### website 문서 수 0

- Datastore가 `PUBLIC_WEBSITE`인지 확인
- targetSites에 `hostname/*` 확인
- crawl 권한/robots/indexing 시간 확인
- recrawl 재요청

### paid invoke가 Studio origin

- `PAY_GATEWAY_URL` public HTTPS 확인
- `USE_PAY_GATEWAY=true`
- CatalogAgent repair/sync
- Catalog public DTO 확인

### gateway proxy 403

- gateway와 Studio의 `PAY_INTERNAL_SECRET` 동일 여부
- provider YAML header key 확인
- `PAY_ORIGIN_URL` 확인

### 첨부/web search 실패

- 요청 크기 제한
- MIME 지원 여부
- Vertex model/region의 `googleSearch` 지원
- ADC와 AI Platform API 권한

## 관련 문서

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CONCEPT.md](./CONCEPT.md)
- [A2A.md](./A2A.md)
- [DATABASE.md](./DATABASE.md)
- [PAYSH_LOCAL.md](./PAYSH_LOCAL.md)
- [ROADMAP.md](./ROADMAP.md)
