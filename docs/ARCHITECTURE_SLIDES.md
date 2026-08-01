# SolVamos 아키텍처 — 슬라이드용 상세 동작도

> 슬라이드 1장 = 아래 섹션 1개. 제목·다이어그램·3줄 메모만 복사하면 된다.  
> 기준: `solvamos-studio` + `solvamos-catalog` 현재 코드.  
> 전체 조감도는 [README](../README.md#아키텍처) / [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Slide 1 — 역할 조감 (4 planes)

**제목 제안:** SolVamos = Control · Discovery · Payment · AI

```mermaid
flowchart LR
  C[Creator] --> S[Studio<br/>Control]
  B[방문자] --> Cat[Catalog<br/>Discovery]
  A[외부 Agent] --> Cat
  A -->|유료| G[pay-gateway<br/>Payment]
  A -->|무료| S
  G -->|proxy| S
  S --> AI[Vertex AI]
  S --> DB[(Cloud SQL)]
  G --> SOL[Solana USDC]
```

- Studio가 만들고, Catalog가 보여주고, gateway가 유료 호출을 결제·중계한다.
- Catalog는 Gateway를 호출하지 않는다 — `invoke_url`만 알려준다.
- AI·DB는 GCP 안. 결제는 Solana Devnet USDC.

---

## Slide 2 — 에이전트 생성 (Create)

**제목 제안:** Agent Create — 지식 → vault → listing

```mermaid
sequenceDiagram
  autonumber
  actor U as Creator
  participant S as Studio API
  participant SM as Secret Manager
  participant DB as Cloud SQL
  participant AI as Datastore + Engine
  participant Cat as Catalog

  U->>S: POST /api/agents/create
  S->>S: auth · tenant · prompt 컴파일
  S->>SM: agent Solana keypair 저장
  S->>DB: Agent CREATING + Ownership
  S->>AI: Datastore 생성 · Engine 생성
  alt Drive / 로컬 파일
    S->>AI: 문서 import
  else 웹사이트
    S->>AI: PUBLIC_WEBSITE + crawl
  end
  S->>DB: CatalogAgent upsert
  S->>Cat: POST /api/catalog/agents<br/>X-Catalog-Admin-Secret
  S-->>U: agent + vault + Catalog URL
```

- 유료 listing의 `invokeUrl` = `https://<gateway>/v1/agents/{id}/invoke`
- 무료 listing의 `invokeUrl` = `https://<studio>/api/agents/{id}/invoke`
- 실패 시 Agent 삭제·listing unlist (보상 삭제 일부 제한 있음)

---

## Slide 3 — 에이전트 CRUD · 수명주기

**제목 제안:** Agent lifecycle — update / unlist / delete

```mermaid
flowchart TB
  Create[Create] --> Active[ACTIVE + Catalog listed]
  Active -->|PATCH /api/agents/:id| Update[prompt · fee · 지식 재연결]
  Update --> Sync[CatalogAgent upsert<br/>+ Catalog publish]
  Sync --> Active
  Active -->|reindex| AI[Datastore re-import]
  Active -->|unlist / delete| Out[Catalog unlisted<br/>row 삭제]
  Out -->|delete 시| Reclaim[vault USDC reclaim<br/>pay-payer.ts]
```

| 동작 | API / 코드 | 부수 효과 |
|---|---|---|
| Create | `POST /api/agents/create` | vault · Datastore · Engine · listing |
| Update | `PATCH /api/agents/:id` | listing 재동기화 |
| Reindex | `POST /api/agents/:id/reindex` | 지식 재적재 |
| Unlist | Catalog unlist / delete 경로 | marketplace에서 제외 |
| Delete | `DELETE /api/agents/:id` | listing 제거 · vault reclaim |

연결 키: `Agent.id = AgentOwnership.agentId = CatalogAgent.agentId`

---

## Slide 4 — Discovery (Catalog)

**제목 제안:** 기계가 읽는 상점 — Catalog discovery

```mermaid
flowchart LR
  subgraph Write [쓰기 — Studio]
    S[Studio] -->|DB upsert| DB[(CatalogAgent)]
    S -->|admin secret| CatAPI[Catalog write API]
    CatAPI --> DB
  end

  subgraph Read [읽기 — 외부]
    H[사람] -->|/marketplace · /a/:id| UI[Catalog HTML]
    M[AI Agent] -->|/llms.txt · /api/catalog<br/>/api/v1/agents · index.md| API[Catalog JSON]
    M -->|Agent Card| StudioCard[Studio<br/>/api/agents/:id/agent-card]
  end

  DB --> UI
  DB --> API
```

| Surface | URL |
|---|---|
| 가이드 | `/llms.txt` |
| 목록 | `/api/catalog`, `/api/v1/agents` |
| 상세 | `/api/solvamos/:id`, `.../index.md` |
| Card | Studio `/api/agents/:id/agent-card` |

- `price`는 힌트. 결제 진실은 라이브 **HTTP 402**.
- Catalog는 RAG·결제를 하지 않는다.

---

## Slide 5 — 유료 Public Invoke (커머스 레일)

**제목 제안:** Paid invoke — 402 → USDC → Studio

```mermaid
sequenceDiagram
  autonumber
  actor A as 외부 Agent
  participant Cat as Catalog
  participant GW as pay-gateway
  participant Chain as Solana
  participant S as Studio /v1
  participant R as runAgentInvoke

  A->>Cat: discovery
  Cat-->>A: gateway invoke_url
  A->>GW: GET/POST /v1/agents/:id/invoke
  GW-->>A: 402 + challenge
  A->>Chain: USDC TX
  Note over Chain: ~90% vault<br/>~10% treasury
  A->>GW: proof + retry
  GW->>S: X-Pay-Internal-Secret
  S->>R: RAG 실행
  R-->>A: answer + citations
```

```text
유료 public     →  pay-gateway only
유료 + Studio origin 직접  →  402 + gateway URL (실행 안 함)
Gateway → Studio →  /v1/agents/:id/invoke + X-Pay-Internal-Secret
```

- gateway: `pay/solvamos-provider.*.yml` (pay.sh · x402/MPP)
- 정산 기록: `gateway-settle.ts` → `PaymentSettlement` (부분 연결)

---

## Slide 6 — 무료 Invoke · Owner Test

**제목 제안:** Free path vs Owner test

```mermaid
flowchart TB
  Req[Invoke 요청] --> Who{누구?}
  Who -->|외부 · fee=0| Free[Studio<br/>/api/agents/:id/invoke]
  Who -->|외부 · fee>0 · Studio origin| Block[402 + gateway URL]
  Who -->|Owner · studioTest=true| Own[ownership 확인<br/>paywall skip]
  Free --> Run[runAgentInvoke]
  Own --> Run
  Run --> Ans[answer]
```

- Owner test는 **이 에이전트** paywall만 생략. peer 유료 호출은 vault에서 나간다.
- Owner test는 API Calls / Est. Revenue를 올리지 않는다 (`bumpInvoke` skip).

---

## Slide 7 — A2A Peer Orchestration

**제목 제안:** A2A — self → free peer → paid peer

> 제품 내부 오케스트레이션 (`server/a2a.ts`). Google A2A JSON-RPC 아님.

```mermaid
flowchart TB
  Q[User prompt] --> Self[1. Self RAG<br/>Engine / Gemini]
  Self --> OK{충분한가?}
  OK -->|yes| Out[답변 반환]
  OK -->|no| Free[2. Catalog fee=0 peers<br/>in-process RAG]
  Free --> OK2{충분한가?}
  OK2 -->|yes| Synth[합성 → Out]
  OK2 -->|no| Paid[3. Catalog fee>0 peers]
  Paid --> Policy{spend policy<br/>call-chain}
  Policy -->|block| Best[self best-effort]
  Policy -->|ok| Pay[caller vault → USDC]
  Pay --> PeerInvoke[gateway / origin invoke]
  PeerInvoke --> Synth
  Best --> Out
```

| 단계 | 비용 | 실행 |
|---|---|---|
| Self | 0 | 자기 Datastore/Engine |
| Free peer | 0 | 같은 Studio in-process RAG |
| Paid peer | fee USDC | vault 결제 후 gateway/origin invoke |
| 결제 실패 | — | 사용자 답 전체 실패 금지 · self best-effort |

- 후보: Catalog listing cache (`listCatalogForA2A`)
- 가드: `spend-policy.ts` (per-call / daily / loop)
- 최대 peer hop 제한 있음 (`MAX_PEER_CALLS`)

---

## Slide 8 — A2A 유료 Peer 결제 상세

**제목 제안:** Paid peer — agent vault가 고객이 된다

```mermaid
sequenceDiagram
  autonumber
  participant Caller as Caller Agent
  participant Orch as a2a.ts
  participant Vault as Caller vault key
  participant Chain as Solana USDC
  participant Peer as Peer invoke_url
  participant Pay as payment.ts

  Orch->>Orch: planPeerCalls · fee>0 선택
  Orch->>Orch: checkSpendAllowance
  Orch->>Vault: loadAgentKeypair Secret Manager
  Orch->>Chain: payPeerFromAgentVault<br/>peer vault + treasury split
  Chain-->>Orch: tx signature
  Orch->>Pay: verifyPayment
  Orch->>Peer: pay fetch / gateway invoke
  Peer-->>Orch: peer answer
  Orch->>Orch: self + peer 합성
```

- 공개 커머스와 **같은 정산 레일** (USDC · vault · treasury).
- Caller의 `maxSpendPerCallUsdc` / `dailyBudgetUsdc`로 한도.
- `callChain`으로 순환 호출 차단.

---

## Slide 9 — RAG Runtime 분기

**제목 제안:** 답변 경로 — 하나의 모델 호출이 아니다

```mermaid
flowchart TB
  In[prompt + options] --> Att{첨부 or 웹검색?}
  Att -->|yes| GemPath[Datastore :search<br/>+ Vertex Gemini]
  Att -->|no| Mode{runtimeMode}
  Mode -->|specialized| Eng[Engine Answer API]
  Mode -->|autonomous| Auto[Gemini<br/>+ optional retrieve]
  Eng -->|실패·빈 인덱스| FB[search + Gemini fallback]
  Eng --> Out[answer · citations · ragMode]
  FB --> Out
  Auto --> Out
  GemPath --> Out
  Out --> Peer{a2aPeersEnabled?}
  Peer -->|yes| A2A[Slide 7 orchestration]
  Peer -->|no| Done[응답]
  A2A --> Done
```

| 모드 | 우선 경로 |
|---|---|
| specialized | AI Applications Answer API |
| autonomous | Vertex Gemini (+ Datastore) |
| 첨부 / Search | Datastore search + Gemini tools |
| peer on | Slide 7 |

코드: `invoke-handler.ts` → `orchestrateA2ATurn` → `rag.ts` / `vertex-*.ts`

---

## Slide 10 — Vault · Treasury · Withdraw

**제목 제안:** 돈의 위치 — Wallet ≠ Vault ≠ Treasury

```mermaid
flowchart LR
  Buyer[Buyer wallet] -->|유료 호출 TX| Split[MPP / split TX]
  Split -->|~90%| AV[Agent vault<br/>Secret Manager key]
  Split -->|~10%| TR[Platform treasury<br/>PLATFORM_TREASURY_PUBKEY]
  AV -->|withdraw| OW[Owner Wallet<br/>Wallet 테이블]
  AV -->|A2A paid peer| PeerV[Peer agent vault]
  AV -->|delete reclaim| Op[Operator / settlement]
```

| 지갑 | 역할 |
|---|---|
| Owner `Wallet` | 표시·연결·출금 목적지 (Phantom 등) |
| Agent vault | 수익 수취 · A2A 결제 출금 |
| Platform treasury | 플랫폼 수수료 |
| Operator / settlement | ATA rent · 선택적 fee_payer |

코드: `vault.ts`, `pay-payer.ts`, `payment.ts`, `pay/*.yml`

---

## Slide 11 — Auth · Tenancy (현재 vs 목표)

**제목 제안:** 누가 쓰는가 — shared Lab → isolated project

```mermaid
flowchart TB
  subgraph Now [지금 · 구현]
    U[User] --> T[shared Tenant]
    T --> P[하나의 GCP project]
    P --> CR[Cloud Run × 3]
    P --> AI1[agent별 Datastore/Engine]
    U --> Own[AgentOwnership]
  end

  subgraph Goal [목표 · 미구현]
    U2[User] --> T2[Tenant]
    T2 -.->|ENABLE_ORG_PROJECT_CREATE| CP[cust-*-prod project]
    CP -.-> AI2[테넌트 Datastore/Engine/Secret]
  end
```

| | Lab 지금 | 목표 |
|---|---|---|
| Project | 1개 shared | 고객별 GCP project |
| 격리 | ownership / tenant row | project 경계 |
| Flag | `TENANCY_MODE=shared` | `isolated` (기본 off) |

인증: email/password + Google OAuth · Drive `drive.readonly` · HttpOnly session.

---

## 슬라이드 구성 추천 순서

1. 역할 조감  
2. Agent Create  
3. CRUD lifecycle  
4. Discovery  
5. Paid public invoke  
6. Free / Owner test  
7. A2A orchestration  
8. A2A paid peer 결제  
9. RAG runtime  
10. Vault / treasury  
11. Auth · tenancy  

발표 시간이 짧으면 **1 → 2 → 5 → 7 → 9 → 10** 여섯 장으로 압축.
