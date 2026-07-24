# SolVamos 제품 컨셉과 범위

> 기준: 2026-07-25

## 한 문장

SolVamos는 사용자의 지식을 Discovery Engine Datastore에 넣고, 이를 AI Applications Engine 기반 에이전트로 만들어 Catalog에서 발견·호출·결제할 수 있게 하는 AI agent commerce platform이다.

## 제품 원칙

### 1. 지식은 Datastore

지식 source가 Drive, 업로드 파일, 공개 웹사이트, 구조화 데이터 중 무엇이든 검색 가능한 운영 지식은 Datastore로 수렴한다.

- `vertexDataStoreId`: 지식 저장소
- `vertexEngineId`: 지식을 사용하는 AI Applications 앱
- `RagDocument`/local corpus: ingest mirror와 fallback

Datastore만 있고 Engine이 없는 상태는 완성된 RAG agent가 아니다.

### 2. discovery는 Catalog

Studio는 제작 도구이고 Catalog는 외부 세계가 에이전트를 찾는 곳이다.

- 공개 marketplace
- 기계가 읽는 JSON
- Markdown agent card
- A2A agent card
- 실행 URL과 가격/결제 protocol

`CatalogAgent`는 영속 listing 데이터이고 `solvamos-catalog`는 그 공개 surface다.

### 3. 유료 실행은 gateway

Studio origin은 상업 paywall이 아니다.

```text
Catalog invoke_url
  → pay-gateway
  → HTTP 402 / x402/MPP
  → USDC
  → gateway-authenticated Studio internal invoke
  → agent runtime
```

Studio 소유자 테스트와 무료 agent만 origin에서 결제 없이 실행한다.

### 4. 사용자 지갑과 agent vault는 다르다

- 사용자 wallet: operator identity/display/funding
- agent vault: 에이전트별 수익·A2A 결제 주소
- agent private key: Secret Manager/KMS

두 주소를 자동으로 동일하게 취급하지 않는다.

### 5. 대화는 하나의 모델 호출이 아니다

질문 유형에 따라 최적 경로를 선택한다.

- text RAG: Engine Answer API
- attachment: Datastore retrieval + Vertex Gemini multimodal
- live web: Datastore retrieval + Vertex Gemini Google Search
- chitchat: retrieval 없는 빠른 Gemini
- A2A: self → free peer → paid peer → synthesis

사용자에게는 한 대화처럼 보이지만 runtime은 근거·비용·도구 요구에 따라 분기한다.

### 6. 실패는 숨기지 않되 내부 실패를 답변으로 만들지 않는다

- Engine이 없거나 index가 비었으면 설정 문제를 명확히 알린다.
- fallback을 사용했다면 `ragMode`/trace로 구분한다.
- peer 결제 실패가 사용자 답변 전체가 되지 않게 self best-effort로 복구한다.
- production payment와 vault는 fail-closed가 원칙이다.

## 사용자 가치

### Agent creator

- GCP 콘솔을 직접 다루지 않고 Datastore+Engine 생성
- Drive/파일/사이트 지식 연결
- prompt 정책과 가격 설정
- owner chat에서 품질 확인
- Catalog 자동 등록

### Agent consumer

- Catalog에서 역할·가격·protocol 확인
- 무료 agent는 바로 호출
- 유료 agent는 표준 gateway URL과 pay client로 결제·호출
- JSON/Markdown/A2A discovery 가능

### Platform operator

- shared Cloud SQL에서 ownership/listing 관리
- Secret Manager/KMS로 vault key 보관
- Cloud Run으로 Studio/Catalog/gateway 분리 운영
- 향후 settlement ledger와 revenue share 확장

## 현재 지원 범위

### 구현됨

- email/password + Google OAuth
- shared tenant와 ownership
- agent CRUD와 prompt 컴파일
- agent별 Solana vault
- Datastore + Engine provisioning
- Drive/로컬 파일 import
- `PUBLIC_WEBSITE` target site와 recrawl
- Engine Answer API
- 대화 history/session/related questions
- image/PDF/text turn attachment
- Google Search toggle
- Catalog marketplace/API/Markdown/A2A card
- gateway-only paid public path
- 비용 인식 A2A orchestration
- wallet UI와 settlement schema/UI
- Cloud Run용 독립 이미지

### 부분 구현

- settlement: DB/UI는 있으나 gateway receipt ingest 미연결
- 가변 가격: Studio/Catalog는 가변, gateway provider는 고정 `0.001`
- media: Datastore vertical과 Engine multimodal response 요청은 있으나 완전한 media asset UX는 아님
- connector: GCS/API/Vertex Studio 선택지는 자동 ingest가 제한적
- indexing 상태: 생성 시 결과 중심이며 지속 reconciliation 없음
- tenant isolation: shared Lab가 기본, isolated project는 production 완료 상태가 아님

### 의도적으로 제외

- Solana mainnet
- client-side Gemini key
- Studio 내부 중복 marketplace
- public Studio origin의 legacy `X-PAYMENT-PROOF`
- production local vault/payment bypass

## 도메인 용어

- **Agent**: prompt, vault, Datastore/Engine, price를 가진 runtime entity
- **Datastore**: agent가 검색하는 지식 index
- **Engine/App**: Datastore 위 Answer/Search capability
- **CatalogAgent**: 공개 discovery용 agent projection
- **Owner test**: 소유권을 확인하고 fee를 생략하는 Studio 품질 테스트
- **Gateway invoke**: 결제 완료 후 internal origin으로 proxy되는 상업 실행
- **A2A hop**: 한 agent가 Catalog의 다른 agent를 호출한 기록
- **RAG mode**: 실제 답변 생성 경로를 나타내는 runtime metadata

## 성공 기준

에이전트가 “생성됨”으로 보이는 것만으로 충분하지 않다.

1. Agent row와 ownership이 존재한다.
2. private key가 안전하게 저장된다.
3. Datastore가 source를 포함한다.
4. Engine이 Datastore에 연결된다.
5. 실제 질문에 grounded citation이 나온다.
6. Catalog listing URL이 유효하다.
7. 유료 agent는 gateway에서 402를 반환하고 결제 후 답한다.
8. 운영자가 실행·비용·영수증을 추적할 수 있다.

현재 1–7의 기본 코드 경로가 있고, 8은 보강 단계다.
