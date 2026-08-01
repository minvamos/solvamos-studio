# SolVamos Studio

SolVamos는 지식을 **Vertex AI RAG 에이전트**로 만들고, **pay.sh(x402/MPP)** 로 호출당
USDC 결제를 붙여, Catalog에서 발견·호출할 수 있게 하는 agent commerce platform이다.

```bash
# 유료 에이전트 호출 — 가입·API 키·카드 등록 없음
pay fetch "https://<gateway>/v1/agents/<agentId>/invoke?prompt=우리 제품 반품 정책 알려줘"
```

| 구성요소 | 역할 | 위치 |
|---|---|---|
| **Studio** | 에이전트 빌더 · runtime · vault · 정산 | 이 repository |
| **Catalog** | 공개 marketplace · 기계용 discovery API | [`solvamos-catalog`](https://github.com/mikohatsu/solvamos-catalog) |
| **pay-gateway** | HTTP 402 결제 · Studio 내부 proxy | 이 repository (`pay/`, `Dockerfile.pay-gateway`) |

## 문서

- [제품 컨셉과 범위](./docs/CONCEPT.md)
- [전체 아키텍처](./docs/ARCHITECTURE.md)
- [슬라이드용 상세 동작도](./docs/ARCHITECTURE_SLIDES.md) — CRUD · 결제 · A2A · RAG · vault
- [핵심 프로세스와 운영 흐름](./docs/PROCESSES.md)
- [API surface](./docs/API.md)
- [Studio ↔ Catalog 통합](./docs/CATALOG_INTEGRATION.md)
- [A2A 정책](./docs/A2A.md)
- [pay.sh gateway local/devnet](./docs/PAYSH_LOCAL.md)
- [데이터베이스](./docs/DATABASE.md)

---

## 기능

- role / tone / security / custom policy 기반 agent builder
- agent별 Solana vault (Secret Manager / KMS)
- agent별 Discovery Engine Datastore + AI Applications Engine provisioning
- Google Drive, 로컬 문서/PDF, 공개 웹사이트 지식 ingest
- Engine Answer API grounded chat (citation, related questions, session)
- 첨부(이미지/PDF) · live Google Search
- 비용 인식 peer 호출: self → free peer → paid peer
- Catalog marketplace / JSON / Markdown / Agent Card discovery
- pay-gateway 전용 유료 public invoke (x402/MPP, Solana Devnet USDC)

---

## 아키텍처

한 줄: **Studio가 만들고 → Catalog가 보여주고 → pay-gateway가 유료 호출을 결제·중계한다.**

역할을 네 덩어리로 보면 된다.

| 레이어 | 누가 | 하는 일 |
|---|---|---|
| **Control** | Studio | 로그인, 에이전트 생성, 지식 ingest, owner chat, runtime, vault |
| **Discovery** | Catalog | marketplace / JSON / `llms.txt` — 무엇을 팔는지 공개 |
| **Payment** | pay-gateway + Solana | HTTP 402, USDC 정산, 결제 후 Studio proxy |
| **AI / Data** | Vertex · Cloud SQL · Secret Manager | 지식 검색·답변, listing/계정 DB, vault key |

### 1) 전체 그림 (GCP 안)

실선 = 현재 Lab 구현. 점선 = 설계 목표(테넌트별 GCP project, 코드에 스켈레톤만·기본 비활성).

```mermaid
flowchart LR
  subgraph Users [엔드유저]
    C[Creator]
    B[Marketplace 방문자]
    A[외부 AI Agent]
  end

  subgraph GCP [Google Cloud]
    subgraph Planes [Cloud Run × 3]
      S[Studio<br/>Control]
      Cat[Catalog<br/>Discovery]
      G[pay-gateway<br/>Payment]
    end

    subgraph Data [Data]
      DB[(Cloud SQL)]
      SM[Secret Manager]
    end

    subgraph AI [AI — 현재 shared project]
      DS[(Datastore)]
      Eng[Engine]
      Gem[Gemini]
      Dr[Drive]
    end

    subgraph Goal [설계 · 미구현]
      TProj[고객별 GCP project<br/>cust-*-prod]
    end
  end

  subgraph Chain [Solana Devnet]
    Pay[pay.sh<br/>x402 / MPP]
    USDC[(USDC TX)]
  end

  C --> S
  B --> Cat
  A -->|발견| Cat
  A -->|유료 호출| G
  A -->|무료 호출| S

  G --- Pay
  Pay --> USDC
  G -->|결제 후 proxy| S

  S <--> DB
  Cat <--> DB
  S --> Cat
  S --> SM
  S --> DS
  S --> Eng
  S --> Gem
  S --> Dr
  DS --> Eng

  S -.->|TENANCY_MODE=isolated| TProj
  TProj -.->|목표: AI/Secret 격리| AI
```

**읽는 순서:** 왼쪽 유저 → 가운데 Cloud Run 3역할 → 오른쪽 아래 체인.  
Catalog는 Gateway를 직접 호출하지 않고 `invoke_url`만 알려준다. 유료 HTTP는 Agent → Gateway.

### 2) 유료 호출만 따로 (결제 레일)

```mermaid
sequenceDiagram
  autonumber
  actor Agent as 외부 AI Agent
  participant Cat as Catalog
  participant GW as pay-gateway
  participant Chain as Solana USDC
  participant Studio as Studio runtime

  Agent->>Cat: 발견 (/llms.txt, /api/catalog)
  Cat-->>Agent: invoke_url (gateway)
  Agent->>GW: /v1/agents/:id/invoke
  GW-->>Agent: HTTP 402 (가격·수취인·mint)
  Agent->>Chain: USDC 서명·전송
  Note over Chain: ~90% agent vault<br/>~10% platform treasury
  Agent->>GW: 증빙과 함께 재시도
  GW->>Studio: X-Pay-Internal-Secret → /v1/.../invoke
  Studio-->>Agent: answer + citations
```

```text
유료  https://<gateway>/v1/agents/{id}/invoke
무료  https://<studio>/api/agents/{id}/invoke
Gateway → Studio   /v1/... + X-Pay-Internal-Secret
Studio → Catalog   POST /api/catalog/agents + X-Catalog-Admin-Secret
```

- 402 챌린지가 결제 source of truth (Catalog `price`는 힌트)
- 유료를 Studio origin에 직접 치면 실행하지 않고 402 + gateway URL만 반환
- 체인 쪽: buyer wallet 서명 · agent vault 수취 · treasury split · (devnet) fee_payer / operator ATA
- 코드: `pay/*.yml`, `payment.ts`, `gateway-settle.ts`, `pay-payer.ts`

### 3) 테넌시 — 지금 vs 목표

| | 지금 (Lab · 구현됨) | 목표 (설계 · 미구현) |
|---|---|---|
| GCP project | 플랫폼 하나 (`GOOGLE_CLOUD_PROJECT`) | 고객별 `cust-*-prod` |
| 격리 | Cloud SQL ownership / tenant 멤버십 | project 단위 AI·Secret 격리 |
| AI 리소스 | 같은 project 안 **agent별** Datastore/Engine | 테넌트 project 안 Datastore/Engine |
| 스위치 | `TENANCY_MODE=shared` (기본) | `isolated` + `ENABLE_ORG_PROJECT_CREATE` (기본 false) |

### 서비스 경계 · 데이터

| 서비스 | 하는 일 | 하지 않는 일 |
|---|---|---|
| **Studio** | CRUD, Datastore/Engine, ingest, owner chat, peer orchestration, vault, 정산 | 공개 marketplace UI |
| **Catalog** | landing · marketplace · JSON/Markdown/`llms.txt` | 결제 · RAG · migration 소유 |
| **pay-gateway** | 402 · USDC · Studio `/v1` proxy | 에이전트 로직·지식 |

연결 키: `Agent.id == AgentOwnership.agentId == CatalogAgent.agentId`.  
Prisma migration은 Studio 소유. Catalog는 `prisma generate`만.

```text
Cloud SQL     User · Tenant · Agent · CatalogAgent · Wallet · PaymentSettlement …
GCP AI        Datastore · Engine · Gemini · Drive
Secrets       agent vault private key (Secret Manager / KMS)
Chain         buyer wallet · agent vault · platform treasury · USDC
```

### 생성 · runtime · discovery (요약)

**생성** `POST /api/agents/create` → vault(SM) → Datastore/Engine → `CatalogAgent` upsert + Catalog publish.

**Runtime** `runAgentInvoke`: specialized=Engine Answer · autonomous/첨부/웹=Gemini(+Datastore) · peer=Catalog 후보를 같은 결제 레일로 재호출.

**Discovery**

| Surface | URL |
|---|---|
| 가이드 | `GET /llms.txt` |
| 목록 | `GET /api/catalog`, `/api/v1/agents` |
| 상세 | `GET /api/solvamos/:id`, `.../index.md` |
| Agent Card | `GET <studio>/api/agents/:id/agent-card` |

공개 실행 경로는 `invoke_url` + 402가 유일하다. A2A는 Card 형태만. [`docs/A2A.md`](./docs/A2A.md) · 상세 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| AI / RAG | Discovery Engine Datastore · AI Applications Engine · Vertex Gemini |
| Payments | pay.sh · x402/MPP · Solana Devnet USDC |
| Backend | Node.js 20 · Express · TypeScript · Prisma |
| Frontend | React 19 · Vite · Tailwind CSS 4 · Motion |
| Data | Cloud SQL PostgreSQL |
| Cloud | Cloud Run ×3 · Artifact Registry · Cloud Build · Secret Manager / KMS |
| Identity | Google OAuth 2.0 · Drive `drive.readonly` |

---

## 설치 및 로컬 구동 (Quickstart)

Studio README만으로 **Studio + Catalog + 외부 검증 Buyer**까지 로컬에서 이어서 테스트할 수 있게 정리한다.  
형제 저장소는 같은 부모 디렉터리에 clone 하는 것을 권장한다.

| Repository | 역할 | URL |
|---|---|---|
| **Studio** (이 repo) | 빌더 · runtime · vault · 로컬 pay-gateway | https://github.com/minvamos/solvamos-studio |
| **Catalog** | 공개 marketplace · discovery API | https://github.com/mikohatsu/solvamos-catalog |
| **외부 검증 Buyer** | Catalog 탐색 → HTTP 402 → Devnet 결제 → invoke | https://github.com/minvamos/solvamos_test_external_agent |

```text
~/HSJ/
  solvamos-studio/                 :3000  (+ managed gateway :1402)
  solvamos-catalog/                :4173
  solvamos_test_external_agent/    :3100  (Studio와 포트 충돌 방지)
```

### 무엇을 검증할 수 있나

| 경로 | 로컬에서 | 필요한 것 |
|---|---|---|
| Catalog discovery (`/health`, `/api/v1/agents`, `/llms.txt`, UI) | ✅ | Node 20+ (DB 없으면 file fallback) |
| Studio UI · 로그인 · 에이전트 CRUD | ✅ | Cloud SQL(+Auth Proxy) · JWT · OAuth |
| RAG create / invoke / Drive ingest | ✅ | GCP ADC · Discovery Engine · Vertex · OAuth |
| pay-gateway 402 challenge | ✅ | pay CLI · `PAY_INTERNAL_SECRET` 일치 |
| `pay fetch` 유료 호출 | ✅ | Devnet USDC buyer 지갑 |
| 외부 검증 Buyer E2E | ✅ | Gemini key · `caller.json` · Catalog `:4173` · gateway invoke_url |

이 머신에 `.env` / Cloud SQL Proxy / pay CLI / ADC가 없으면 Studio·유료 경로 기동은 막히고, Catalog file-fallback 스모크만 즉시 가능하다.

### 0) 공통 사전 준비

- Node.js **20+**
- `gcloud` ADC (`gcloud auth application-default login`) — Studio RAG/Vault용
- Cloud SQL Auth Proxy → `127.0.0.1:5432` (Studio·Catalog 공유 `DATABASE_URL`)
- Google OAuth Web Client (Drive `drive.readonly`) — [DRIVE_OAUTH_SETUP](./docs/DRIVE_OAUTH_SETUP.md)
- pay.sh CLI + Devnet USDC (유료 경로)

**pay CLI**

```bash
# macOS / Linux — PATH에 pay 설치
npm install -g @solana/pay
pay --version

# 또는 로컬 경로를 Studio가 읽게
mkdir -p tools/pay
# binary를 tools/pay/pay 에 두고, 없으면 PAY_CLI_PATH=/절대경로/pay
# Windows는 기존 스크립트:
npm run pay:install   # → tools/pay/pay.exe
```

### 1) Studio + managed pay-gateway (`:3000` · `:1402`)

```bash
git clone https://github.com/minvamos/solvamos-studio.git
cd solvamos-studio
npm install
cp .env.example .env
```

`.env`에서 로컬 Lab에 최소로 맞출 값:

```env
APP_URL=http://localhost:3000
PORT=3000
JWT_SECRET=dev-only-change-me-to-a-long-random-string
DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/solvamos_studio?schema=public
GOOGLE_CLOUD_PROJECT=<your-gcp-project>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback

# Lab bypasses (production 금지)
ALLOW_LOCAL_VAULT_FALLBACK=true
ALLOW_PAYMENT_BYPASS=true

PAYMENT_NETWORK=devnet
PAY_GATEWAY_URL=http://127.0.0.1:1402
PAY_ORIGIN_URL=http://127.0.0.1:3000
PAY_INTERNAL_SECRET=dev-pay-internal
PAY_GATEWAY_MANAGED=true
USE_PAY_GATEWAY=true

# Catalog 연동 (아래 Catalog .env와 동일 secret)
CATALOG_SITE_URL=http://127.0.0.1:4173
CATALOG_ADMIN_SECRET=dev-catalog-admin-secret-change-me
```

```bash
# Cloud SQL Auth Proxy를 별도 터미널에서 먼저 띄운 뒤
npm run dev
# → http://localhost:3000
# → PAY_GATEWAY_MANAGED=true 이면 Studio가 pay server를 :1402에 자식으로 기동
```

managed가 실패하거나 CLI만 따로 띄울 때:

```bash
export PAY_INTERNAL_SECRET=dev-pay-internal
pay server start pay/solvamos-provider.devnet.yml --bind 127.0.0.1:1402
```

스모크:

```bash
curl -sS http://127.0.0.1:3000/healthz
curl -sS http://127.0.0.1:3000/api/status | head -c 400
curl -sS http://127.0.0.1:1402/v1/health
```

상세: [PAYSH_LOCAL.md](./docs/PAYSH_LOCAL.md) · [DATABASE.md](./docs/DATABASE.md) · [CATALOG_INTEGRATION.md](./docs/CATALOG_INTEGRATION.md).

### 2) Catalog (`:4173`) — [solvamos-catalog](https://github.com/mikohatsu/solvamos-catalog)

```bash
git clone https://github.com/mikohatsu/solvamos-catalog.git
cd solvamos-catalog
npm install
cp .env.example .env
```

```env
PORT=4173
PUBLIC_BASE_URL=http://127.0.0.1:4173
STUDIO_URL=http://localhost:3000
CATALOG_ADMIN_SECRET=dev-catalog-admin-secret-change-me   # Studio와 동일
# 전체 listing 연동 시 Studio와 같은 Cloud SQL:
# DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/solvamos_studio?schema=public
# DATABASE_URL 비우면 file fallback (.data/catalog-store.json) — discovery 스모크용
```

```bash
npm run dev
# → http://127.0.0.1:4173
```

스모크:

```bash
curl -sS http://127.0.0.1:4173/health
curl -sS http://127.0.0.1:4173/api/v1/agents | head -c 500
curl -sS http://127.0.0.1:4173/llms.txt | head -20
open http://127.0.0.1:4173/marketplace
```

Studio에서 에이전트를 만들고 publish하면 Catalog listing에 나타나고, 유료 에이전트의 `invoke_url`은 `http://127.0.0.1:1402/v1/agents/<id>/invoke` 형태여야 한다.

### 3) 유료 호출 (CLI)

```bash
# agentId는 Catalog / Studio에서 확인
curl -i "http://127.0.0.1:1402/v1/agents/<agentId>/invoke?prompt=hello"
# → HTTP 402 + WWW-Authenticate: Payment …

pay fetch "http://127.0.0.1:1402/v1/agents/<agentId>/invoke?prompt=hello"
# → Devnet USDC 결제 후 Studio proxy 답변
```

Studio origin의 유료 `/api/agents/<id>/invoke`는 실행하지 않고 402 + gateway URL만 돌려준다.

### 4) 외부 검증 Buyer (`:3100`) — [solvamos_test_external_agent](https://github.com/minvamos/solvamos_test_external_agent)

Gemini가 Catalog를 검색하고, 402를 받아 buyer 지갑으로 결제한 뒤 raw 응답을 스트리밍하는 Lab용 Buyer다. **Studio와 포트가 겹치지 않게 기본 `:3100`.**

```bash
git clone https://github.com/minvamos/solvamos_test_external_agent.git
cd solvamos_test_external_agent
npm install
```

준비 파일 (repo 루트, gitignore 대상):

```text
gemini_API_key.txt     # 또는 export GEMINI_API_KEY=...
caller.json            # Solana Devnet secret key byte array (buyer)
```

```bash
# 로컬 Catalog를 보도록 (기본값도 이미 로컬 :4173)
export CATALOG_INDEX_URL=http://127.0.0.1:4173/api/v1/agents
npm start
# → http://localhost:3100
```

UI에서 자연어 질의 → `search_catalog` → `invoke_paid_agent` → SSE 타임라인으로 402·TX·원본 응답 확인.  
CLI만: `npm run start:cli` 또는 `node autonomous-agent.mjs`.

전제: Studio·Catalog·gateway가 떠 있고, Catalog에 **유료** listing이 있으며 buyer 지갑에 Devnet USDC가 있어야 한다.

### 5) 권장 기동 순서 (한 번에 전체)

```text
1. Cloud SQL Auth Proxy
2. Catalog          npm run dev          → :4173
3. Studio           npm run dev          → :3000 (+ :1402 managed)
4. (선택) External  npm start            → :3100
5. Studio UI에서 에이전트 생성·publish → Catalog에 listing 확인
6. curl 402 → pay fetch 또는 External Buyer UI
```

### Cloud Run

```bash
gcloud builds submit --config cloudbuild.studio.yaml .
gcloud builds submit --config cloudbuild.pay-gateway.yaml .
# Catalog는 solvamos-catalog repository에서 배포
```

환경 변수와 배포 순서: [PROCESSES.md](./docs/PROCESSES.md#11-배포).

---

## Repository 구조

```text
solvamos-studio/                 Studio + pay-gateway
  server.ts                      Express 엔트리
  server/
    provision.ts · vault.ts      생성 · Solana key · Secret Manager
    drive-ingest.ts · local-ingest.ts
    rag.ts · vertex-*.ts         Answer API / Gemini / Datastore search
    invoke-handler.ts            runAgentInvoke
    a2a.ts                       peer orchestration
    catalog-db.ts                CatalogAgent upsert
    paysh-catalog.ts             Catalog HTTP publish
    payment.ts · gateway-settle.ts
    pay-gateway-manager.ts       로컬 pay.sh (:1402)
    agent-card.ts
  pay/solvamos-provider*.yml
  prisma/schema.prisma
  src/pages/
  Dockerfile
  Dockerfile.pay-gateway

solvamos-catalog/                https://github.com/mikohatsu/solvamos-catalog
  server/catalog.ts
  server/catalog-db-store.ts
  server/llm-discovery.ts        /llms.txt · settlement guide
  src/pages/                     Landing · Marketplace · Agent detail

solvamos_test_external_agent/    https://github.com/minvamos/solvamos_test_external_agent
  server.mjs · agent-runner.mjs  Buyer UI (:3100) + Gemini tools
  x402-executor.mjs              402 → Devnet 결제 → retry
```

---

## 현재 상태

- 결제는 **Solana Devnet**만 사용한다.
- 에이전트별 fee는 Studio/Catalog에서 가변이나, provider YAML 미터링은 현재 고정
  (`$0.001/req`)이다.
- gateway receipt → `PaymentSettlement` 연결은 부분 구현이다 (온체인 스캔 보완).
- tenancy는 shared GCP project + ownership 논리 격리(Lab)가 기본이다.

상세: [ROADMAP.md](./docs/ROADMAP.md) · [PLATFORM_AUDIT.md](./docs/PLATFORM_AUDIT.md).

## 라이선스

MIT License.
