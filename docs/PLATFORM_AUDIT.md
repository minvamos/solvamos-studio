# SolVamos 플랫폼 감사 (2026-07-26)

> 기준 커밋: Studio `4c4994e`, Catalog `285c9ef`  
> 이전 감사: 2026-07-25 (Studio `b633d30`, Catalog `9755725`)  
> 범위: 코드·배포·결제·인가·RAG lifecycle·최근 ATA/회수/UI 변경. **현재 구현 상태**를 기록한다.  
> 구현 추적은 [ROADMAP.md](./ROADMAP.md)와 git history를 함께 본다.

## 1. 시스템 경계

```
사용자 브라우저 (React 19 SPA, 쿠키 JWT)
   │
   ▼
solvamos-studio (Cloud Run, Express server.ts + server/)
   ├─ 인증: 이메일/비번(bcrypt) + Google OAuth → JWT 쿠키
   ├─ 에이전트: Agent + AgentOwnership + Solana 볼트(Secret Manager)
   ├─ RAG: runtimeMode=specialized → Datastore+Engine Answer / autonomous → Gemini+Datastore retrieve
   ├─ 결제: pay-gateway 네이티브 MPP 90/10 (seller vault + treasury, 1 TX)
   ├─ ATA: 에이전트 생성 시 ensure / 삭제 시 reclaim(렌트→operator, USDC→유저 지갑)
   ├─ A2A: 자체 RAG → 피어(볼트 90/10 + spend policy) — Studio 테스트 기본 ON
   └─ 정산: PaymentSettlement (gateway_receipt / a2a_onchain / …)
   │
   ├── 공유 PostgreSQL(Cloud SQL) ──┐
   ▼                                │
solvamos-pay-gateway                │
   Catalog fee 주입 → ATA ensure(+RPC wait) → 402/MPP → Studio 내부 invoke
                                    │
solvamos-catalog ◄──────────────────┘
   공개 마켓플레이스. CatalogAgent 직접 읽기 + Studio HTTP/DB push
```

핵심 키: `Agent.id == AgentOwnership.agentId == CatalogAgent.agentId`.

## 2. 유료 호출 흐름 (현재)

Buyer가 Catalog에 노출된 **pay-gateway** URL(`…/v1/agents/{id}/invoke`)을 호출하면 gateway가 Catalog `feeUsdc`로 402/MPP를 내고 **한 TX**로 seller vault(기본 90%) + treasury(기본 10%)에 정산한 뒤 `X-Pay-Internal-Secret`으로 Studio `handleInternalInvoke`를 프록시한다. Studio는 paywall을 스킵하고 RAG/A2A를 실행한다. receipt 헤더가 있으면 `PaymentSettlement`만 기록하고(네이티브 split이면 2차 operator payout 없음), A2A 유료 피어는 buyer **agent vault**에서 `payPeerFromAgentVault`로 동일 90/10을 보낸다.

## 3. 잘 되어 있는 부분

- JWT refresh 회전 + 재사용 감지, production `JWT_SECRET` ≥ 32자 강제
- RAG는 에이전트당 Datastore/Engine 1:1
- 시크릿 위생: 레포에 커밋된 키 없음, 볼트는 Secret Manager
- A2A loop/depth 가드, per-call·daily budget 스키마/환경변수
- production safety 게이트 (`ALLOW_PAYMENT_BYPASS` / local vault 금지)
- **네이티브 MPP splits** — Catalog fee 주입, unlisted 경로는 402-only(proxy 없음)
- **부팅 ATA ensure + RPC visibility wait** — Devnet 레이스로 인한 gateway crash 완화
- 에이전트 삭제 시 vault USDC→owner primary, ATA rent→operator 회수

## 4. 이전 Critical (C1–C8) 상태

| ID | 주제 | 상태 |
|----|------|------|
| **C1** | `PATCH /api/agents/:id` 소유권 없음 | **fixed** — `userCanManageAgent` |
| **C2** | `/api/dev/logs` 무인증 | **fixed** — `requireGoogleSession` |
| **C3** | replay `/tmp` only | **mitigated** — `PaymentSettlement.signature` 조회 추가. durable fail-open·TOCTOU 남음 |
| **C4** | gateway payout / `?pay_internal=` | **mitigated** — query 제거, timingSafeEqual, receipt 없으면 payout 없음, native MPP. receipt 온체인 검증·gateway inject·secret=compute는 남음 |
| **C5** | tenant/catalog mutation 무인증 | **fixed** — session + tenant admin / ownership |
| **C6** | 비로그인 `GET /api/agents` 전체 노출 | **fixed** — `listAgentsForUser(null) → []` |
| **C7** | Production migrate best-effort | **fixed** — fail-closed (`BOOT_ALLOW_DEGRADED`만 예외). `/readyz` DB probe는 미완 |
| **C8** | Catalog 공개 owner PII | **fixed** — public API에서 `ownerUserId`/`ownerEmail` omit |

## 5. Critical (현재)

### C9. Shared Lab tenant membership → 타 사용자 에이전트 무료 invoke (+ vault A2A 지출)

- 파일: `server.ts` invoke (`studioTest` / `X-SolVamos-Studio`), `server/tenant-seed.ts` (`lab-customer`), `server/invoke-handler.ts`, `src/App.tsx` (`enableA2A` 기본 `true`)
- `studioTest`는 **AgentOwnership 또는 동일 `tenantId`의 TenantMember**면 paywall skip
- Lab에서는 신규 유저가 공유 `lab-customer` tenant에 붙고 create도 같은 tenant → 로그인만 하면 **남의 에이전트를 무료 호출** 가능
- Studio 테스트 A2A 기본 ON + `enablePeers: enableA2A !== false` → owner-test 중 **호출 대상 vault가 피어에게 USDC 지출** 가능
- 권고: `studioTest`는 `userCanManageAgent` / ownership만 허용. Lab에서도 tenant membership으로 paywall 우회 금지. Owner-test 기본 `enableA2A:false`

## 6. High (현재)

### H1. Gateway receipt / ledger — **mitigated (2026-07-26)**

- Native MPP는 체인 정산만 담당. 장부는 `server/gateway-settle.ts`가  
  (1) receipt 헤더 서명 `verifyPayment` 또는 (2) vault USDC ATA **최근 TX 스캔 + 온체인 검증** 후 `PaymentSettlement` 기록
- pay.sh가 receipt를 inject하지 않아도 장부가 채워짐. 헤더 위조는 온체인 검증에서 걸림
- 잔여: gateway 측 정식 inject(선택), 스캔 윈도우(20분) 경계 케이스

### H2. `PAY_INTERNAL_SECRET`만으로 무료 컴퓨트 — **accepted risk (단기 스킵)**

- 브라우저/쿼리/로그로 유출되지 않음 (Cloud Run Secret Manager / IAM 경로만)
- secret 유출 시에만 무료 컴퓨트 — 단기 스킵, 중기 receipt/mTLS 필수화

### H3. ATA ensure → operator SOL griefing

- 유료 agent create / fee>0 PATCH마다 settlement key가 ATA rent 지불
- rate limit·create quota 없음 → 대량 create로 operator SOL 소진 → gateway ATA ensure 실패 시 결제 경로 DoS
- 삭제 시 rent 회수로 완화됐으나 **TX 수수료·일시 동결**은 남음
- 권고: per-user create quota, ATA 비용 상한, 남용 알람

### H4. Owner-test / invoke A2A peers 기본 ON → vault spend

- `invoke-handler`: `enablePeers: input.enableA2A !== false` (undefined → true)
- UI `enableA2A` 기본 `true`
- 권고: commercial/gateway/`studioTest` 기본 OFF, opt-in만 vault spend

### H5. Spend policy fail-open — **mitigated (retry → fail-closed)**

- `spentTodayUsdc` 3회 리트라이 후 실패 시 A2A 결제 **차단** (`spentTodayUsdc: -1`)
- 잔여: check-then-pay 레이스, putAgent에 per-agent budget persist

### H6. Catalog admin secret listing 탈취 — **mitigated (부분)**

- timingSafeEqual, secret 필수(로컬은 `ALLOW_INSECURE_CATALOG_WRITES=1`만 예외)
- write CORS `*` 제거(Studio origin만)
- DB upsert: 기존 `ownerUserId` 있으면 matching claim 필수
- Studio publish가 `owner_user_id` 포함
- 잔여: OIDC/서명된 claim, owner 미바인딩 레거시 row

## 7. Medium / Low (요약)

| ID | 요약 | 상태 |
|----|------|------|
| M1 | Replay durable check fail-open + verify→record TOCTOU | open (C3 잔여) |
| M2 | Vault reclaim: owner 없으면 USDC→treasury; create `softReclaim`은 키 삭제 진행 | new / 부분 mitigated |
| M3 | PAUSED/CREATING도 invoke 미차단 | open (구 H6) |
| M4 | 무인증 `GET /api/tenants`, balance, agent-card, status 표면 | open |
| M5 | Rate limit 전무 + JSON body 20MB | open (구 H4) |
| M6 | `GATEWAY_LEGACY_PAYOUT=true` 시 구 payout 재활성 | mitigated (default off) |
| M7 | Studio CI에 `CATALOG_SITE_URL` / `CATALOG_ADMIN_SECRET` 미바인딩 | open (구 H3) |
| M8 | `/readyz`가 DB readiness 미검사 | open (C7 잔여) |
| M9 | `secretsEqual` 길이 early-return (타이밍) | open |
| M10 | Catalog 공개 scrape: `tenant_id`, `origin_invoke_url`, wallet, rate limit 없음 | open |
| M11 | RAG INCREMENTAL / dual catalog write / marketplace 하드코딩 | open (구 M1–M4) |
| L1 | 로그인 직후 seed agent(+prompt) 반환 | mitigated vs 익명 전체 목록 |
| L2 | Hardcoded default treasury pubkey | open — prod unset 시 boot fail 권고 |
| L3 | Catalog fee vs unlisted YAML `0.001` | mitigated (listed는 Catalog fee) |

## 8. 결제 경로 판정 (현재)

| 경로 | 체인 | Ledger | 판정 |
|------|------|--------|------|
| External gateway (native MPP) | buyer→seller+treasury 1 TX | receipt 헤더 있을 때만 `gateway_receipt` (미검증) | **부분 완** — 정산은 체인, ledger 루프 미완 |
| Gateway legacy 2차 payout | operator→seller+treasury | `GATEWAY_LEGACY_PAYOUT` | **기본 off** |
| A2A devnet | vault 90/10 + `verifyPayment` | `a2a_onchain` | 대체로 일치 (spend fail-open 잔여) |
| localnet | sandbox | 거의 없음 | Lab 전용 |

## 9. 최근 변경과 보안 영향

| 변경 | 영향 |
|------|------|
| Auth harden (`631a594` 등) | C1/C2/C5/C6/C7/C8 종료 |
| Native MPP 90/10 | operator 2차 payout 배수 위험 **감소** |
| ATA ensure + RPC wait (`4c4994e`) | gateway 부팅 안정성↑, operator SOL griefing 표면↑ |
| Vault reclaim on delete | 잔액/렌트 회수↑; treasury fallback·softReclaim 잔여 |
| Studio UI detail/edit 분리 | 보안 영향 없음 |
| Unlisted 402 respond-only | 가짜 agentId로 내부 invoke 우회 **완화** |
| A2A owner-test 기본 ON | Shared Lab C9와 결합 시 vault 지출 **악화** |

## 10. 우선순위 권고

### 즉시 (Critical)

1. `studioTest`를 **ownership-only**로 축소 (Shared Lab C9)
2. Owner-test / invoke에서 **A2A 기본 OFF**

### 1–2주 (High)

3. Gateway signed receipt inject + Studio 검증 (P0.2 닫기)
4. ATA create **per-user quota** / rate limit
5. Spend policy **fail-closed** + putAgent 정책 persist
6. Catalog upsert **ownership + timing-safe secret** (write CORS 제거)
7. ACTIVE-only invoke; durable replay fail-closed

### 이후

- `/readyz` DB ping, Studio CI Catalog env 바인딩
- RAG reconciliation, Catalog write 단일화
- Rate limit, correlation ID, conversation DB
- Marketplace 하드코딩 제거

## 11. 관련 문서

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ROADMAP.md](./ROADMAP.md)
- [PROCESSES.md](./PROCESSES.md)
- [DATABASE.md](./DATABASE.md) / [DATABASE_ERD.md](./DATABASE_ERD.md)
- [CATALOG_INTEGRATION.md](./CATALOG_INTEGRATION.md)
