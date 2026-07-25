# SolVamos 플랫폼 감사 (2026-07-25)

> 기준 커밋: Studio `b633d30`, Catalog `9755725`  
> 범위: 코드·배포·결제·인가·RAG lifecycle. 목표 상태가 아니라 **당시 구현 상태**를 기록한다.  
> Critical 항목 중 일부는 이후 보안 패치로 닫혔을 수 있다 — 구현 상태는 [ROADMAP.md](./ROADMAP.md)와 git history를 함께 본다.

## 1. 시스템 경계

```
사용자 브라우저 (React 19 SPA, 쿠키 JWT)
   │
   ▼
solvamos-studio (Cloud Run, Express server.ts + server/)
   ├─ 인증: 이메일/비번(bcrypt) + Google OAuth → JWT 쿠키
   ├─ 에이전트: Agent + AgentOwnership + Solana 볼트(Secret Manager)
   ├─ RAG: 에이전트당 Discovery Engine Datastore + Engine, Answer API → Gemini 폴백
   ├─ 결제: pay CLI 게이트웨이(x402/MPP, devnet USDC), X-Pay-Internal-Secret 프록시
   ├─ A2A: 자체 RAG → 무료 피어 → 유료 피어(볼트 90/10 + spend policy)
   └─ 정산: PaymentSettlement
   │
   ├── 공유 PostgreSQL(Cloud SQL) ──┐
   ▼                                │
solvamos-pay-gateway                │
   402 챌린지 → 결제 → Studio 내부 invoke
                                    │
solvamos-catalog ◄──────────────────┘
   공개 마켓플레이스. CatalogAgent 직접 읽기 + Studio HTTP push
```

핵심 키: `Agent.id == AgentOwnership.agentId == CatalogAgent.agentId`.

## 2. 잘 되어 있는 부분

- JWT refresh 회전 + 재사용 감지, production `JWT_SECRET` ≥ 32자 강제
- RAG는 에이전트당 Datastore/Engine 1:1, Answer API → Gemini 폴백이 일관됨
- 시크릿 위생: 레포에 커밋된 키 없음, 볼트는 Secret Manager(+선택 CMEK)
- A2A loop/depth 가드, per-call·daily budget 정책(스키마/환경변수)
- production safety 게이트 (`ALLOW_PAYMENT_BYPASS` / local vault 금지)
- 문서가 한계를 비교적 솔직히 기록

## 3. Critical 결함 (감사 시점)

### C1. `PATCH /api/agents/:id` 소유권 검사 없음

- 파일: `server.ts` PATCH 핸들러
- 로그인만 하면 임의 agent의 fee/prompt/status/source 변조 가능
- DELETE에는 `userCanManageAgent`가 있으나 PATCH에는 없음

### C2. `/api/dev/logs` 무인증

- `GET/DELETE /api/dev/logs` — 커밋 `0dc256b`에서 임시 공개
- 프롬프트·GCP 오류·경로·결제 메타데이터 유출 + 로그 삭제 가능

### C3. 결제 replay 캐시가 `/tmp` 파일 + 7일 TTL

- `server/payment.ts` → `payment-replay.json`
- Cloud Run 재시작/재배포 후 동일 on-chain proof 재사용 가능
- `PaymentSettlement.signature` unique가 권위 있는 가드인데 검증 경로가 미사용

### C4. Gateway payout이 실수금 검증·멱등성 없이 송금

- `handleInternalInvoke` 200이면 `settleExternalGatewaySale` fire-and-forget
- buyer→`PAY_RECIPIENT` 원본 receipt와 상관관계 없음
- secret만 알면 무료 컴퓨트 + operator 지갑 배수 위험
- `?pay_internal=` 쿼리로 secret 수용 → 로그/Referer 유출

### C5. 무인증 tenant / catalog mutation

- `PATCH /api/tenants/:id`, `POST /api/tenants/:id/cloud-run`
- `POST /api/catalog/:agentId/register` (+ deprecated alias)
- Cloud Run 배포·카탈로그 재게시가 인터넷에 열림

### C6. 비로그인 `GET /api/agents` 전체 노출

- `listAgentsForUser(null)` → `listAgents()` — vault pubkey, systemPrompt, Vertex ID 포함

### C7. Production migrate best-effort

- Dockerfile: `prisma migrate deploy || … starting anyway`
- 스키마 불일치 + spend-policy fail-open → 일일 예산이 0으로 해제될 수 있음
- `/healthz`는 DB readiness를 보지 않음

### C8. Catalog 공개 PII

- `/api/catalog` `data[]`에 `ownerUserId`, `ownerEmail` 포함
- CORS `*`, 프론트 미사용

## 4. High / Medium (요약)

| ID | 요약 |
|----|------|
| H1 | Catalog fee vs gateway YAML `0.001` 가격 불일치 |
| H2 | Spend policy fail-open + check-then-pay race |
| H3 | Studio CI에 `CATALOG_SITE_URL` / `CATALOG_ADMIN_SECRET` 미바인딩 |
| H4 | Rate limit 전무, JSON body 20MB |
| H5 | Agent update 시 Datastore/Engine 누수·미반영 |
| H6 | PAUSED/CREATING도 invoke 차단 안 됨 |
| H7 | 무료 GET invoke가 Catalog에 광고되나 Studio는 POST만 |
| H8 | Shared Lab tenant → studio owner-test가 타 사용자 에이전트에 열림 |
| M1 | RAG INCREMENTAL import로 삭제 문서 잔존, `/tmp` corpus |
| M2 | 이중 Catalog write (DB + HTTP) |
| M3 | Marketplace ACTIVE/Verified/version 하드코딩 |
| M4 | 스트리밍 없음, 답변 언어 `ko` 하드코딩 |

## 5. 결제 경로 판정 (감사 시점)

| 경로 | 체인 | Ledger | 판정 |
|------|------|--------|------|
| A2A devnet | vault 90/10 + `verifyPayment` | `a2a_onchain` | 대체로 일치 |
| External gateway | buyer→operator 전액 | 원본 receipt 부재 | 미완 |
| Gateway 2차 payout | operator→seller+treasury | `gateway_payout` | 검증·멱등 없음 |
| localnet | sandbox | 거의 없음 | Lab 전용 |

## 6. 우선순위 권고

### 1주 (Critical — 본 패치 범위)

1. `/api/dev/logs` 인증, tenant/catalog mutation 권한
2. Agent PATCH/DELETE ownership 강제, 비로그인 agent list 빈 배열
3. `?pay_internal=` 제거, timing-safe secret, receipt 없으면 payout 금지 + DB 멱등
4. Replay를 `PaymentSettlement.signature`로 보강
5. Production migrate fail-closed (`BOOT_ALLOW_DEGRADED`만 예외)
6. Catalog 공개 응답에서 owner PII 제거

### 2주

- Gateway가 receipt 헤더를 실제로 inject (P0.2 완료)
- Catalog fee ↔ charged amount ↔ payout 강제 일치
- Spend policy fail-closed + 트랜잭션
- Studio CI Catalog env 바인딩
- owner-test를 ownership 전용으로 축소

### 이후

- RAG reconciliation / 문서 삭제 동기화
- Catalog write 단일화
- Rate limit, correlation ID, conversation DB
- Marketplace 하드코딩 제거

## 7. 관련 문서

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ROADMAP.md](./ROADMAP.md)
- [PROCESSES.md](./PROCESSES.md)
- [DATABASE.md](./DATABASE.md) / [DATABASE_ERD.md](./DATABASE_ERD.md)
- [CATALOG_INTEGRATION.md](./CATALOG_INTEGRATION.md)
