# 해커톤 제출 노트 — Google Cloud × Solana AI Agentic Hackathon

> 기준: 2026-07-26 · 제출 마감 2026-08-03 23:59 KST · Demo Day 2026-08-21 (Google Startup Campus)
> 이 문서는 제출·심사 대응 전용이다. 제품 설명의 원본은 [README](../README.md)와 [CONCEPT.md](./CONCEPT.md)다.

## 트랙 포지셔닝

**Track A (Agent-Initiated Commerce) × C (Multi-Agent Commerce) 조합.**

- A: creator가 만든 지식 에이전트를 외부 에이전트가 결제 요청 수신 → 입금 → 정산까지
  사람 개입 없이 소비한다 (B2B SaaS / 콘텐츠·구독 계열).
- C: Studio의 비용 인식 peer orchestration — 에이전트가 Catalog에서 다른 에이전트를
  발견하고 vault USDC로 결제해 호출하는 A2A 커머스 경로.

## 당위성 — 킥오프 세션의 4가지 질문에 대한 답

x402 & MPP 세션("당위성을 가져야 한다")의 프레임을 따른다.

### 1. 왜 블록체인(Solana) 기반 결제여야 하나

상품 단가가 호출당 $0.001 수준의 마이크로페이먼트라 카드 네트워크 수수료 구조로는
성립하지 않는다. 구매자가 에이전트라서 카드·PG의 "사람 승인" 전제와 계좌 개설 심사를
통과할 수 없다. Solana USDC + 402는 인증/로그인 없이 진행 가능한 결제, 건당 $0.00x
수수료, ~400ms 정산을 제공한다 — 경쟁군(카드 네트워크)이 구조적으로 못 하는 것.

### 2. 어느 시장을 노리나

기존 커머스의 재편이 아니라 "에이전트가 지식·능력을 사고파는" 신규 시장. 위임형·자율형
에이전트가 실구매자가 되는 시점에, 그들이 살 수 있는 상품(기계가 발견·결제·호출 가능한
지식 API)의 공급이 병목이다. SolVamos는 그 공급을 만들어내는 B2B SaaS다.

### 3. 어느 레이어를 노리나 — 어떤 레일이 부족한가

```text
결제 프로토콜    x402 / MPP                  ✅ 있음
소비 클라이언트   pay CLI / pay fetch          ✅ 있음 (pay.sh)
판매자 온보딩    지식 → 유료 402 엔드포인트      ❌ ← SolVamos Studio
디스커버리      기계가 읽는 카탈로그·가격 계약    ❌ ← SolVamos Catalog
```

결제 레일은 새로 만들지 않고 pay.sh를 그대로 쓴다. 표준 레일 위의 빈 구간만 짓는 것이 해자다.

### 4. 현재 시장은 무엇을 타겟으로 하는가

pay.sh 카탈로그의 70+ 유료 API는 이미 존재하는 API(검색·데이터·이미지 생성)를 연결한
것이다. SolVamos는 아직 API가 아닌 롱테일 지식을 신규 상품으로 발행해 공급 자체를
확장한다. Cloudflare Monetization Gateway가 "기존 콘텐츠에 계산대 달기"라면, SolVamos는
"지식으로 상점 개업시키기"다.

## 심사 기준 매핑

| 심사 기준 | 우리 대응 |
|---|---|
| **혁신성 및 UX** — 새로운 사용자 경험 · 문제 해결 방식 | 비개발자 지식 보유자의 "상점 개업" UX · "402 = source of truth" 결제 계약 · llms.txt 등 에이전트-네이티브 디스커버리 · 비용 인식 peer orchestration(에이전트가 에이전트의 고객) |
| **AI 활용도** — Gemini · Google Cloud AI 스택 완성도 | Datastore provisioning → Engine Answer API(grounded citation) → Gemini multimodal/Search grounding까지 GCP AI 스택 풀체인. 단일 모델 호출이 아닌 근거·비용 기반 runtime 분기 |
| **인프라 연동** — USDC · Solana Pay · pay.sh 연동 | pay.sh provider gateway를 상업 레일 그 자체로 사용(옵션 아님) · Devnet USDC 정산 · agent vault(Secret Manager/KMS) · Cloud Run ×3 배포 |
| **실제 구동 여부** — 실행 로그·이력 기반 트랜잭션 확인 | `curl` → 402, `pay fetch` → 실제 devnet USDC tx(explorer 확인) · replay guard 로그 · `PaymentSettlement` ledger · `ragMode`/tool trace가 담긴 invoke 응답 |

## 제출물 체크리스트

- [ ] **프로덕트 소개서 (PPT)** — 타깃/문제: README §왜 만들었나 · 수익모델: README §수익 구조 · 아키텍처: README §아키텍처 + [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ ] **GitHub** — 재현 가능한 코드 + README: `solvamos-studio` / `solvamos-catalog` 2-repo, `.env.example`, provider YAML, `npm run smoke`
- [ ] **데모 영상 (3분 이내)** — 실제 온체인 결제 전 과정 시연 (아래 시나리오)
- [ ] **BONUS: 라이브 배포 URL** — Cloud Run 3 서비스 (Studio · Catalog · pay-gateway)

**목업 배제 게이트**: 데모의 결제는 실제 Solana Devnet USDC 트랜잭션이며 explorer에서 검증
가능해야 한다. 결제 순간 사람 클릭 0회.

## 3분 데모 시나리오

1. **[0:00–0:45] 지식 → 상점 개업.** Studio에서 Drive 폴더/PDF를 연결해 에이전트 생성.
   Datastore+Engine provisioning과 agent vault 주소가 화면에 표시된다.
2. **[0:45–1:15] 발견.** Catalog marketplace에 방금 만든 에이전트가 listing.
   `/api/solvamos/<id>/index.md`와 `/llms.txt`를 열어 에이전트가 읽는 discovery 계약을 보여준다.
3. **[1:15–2:15] 자율 결제 호출.** 터미널에서 `curl` → **HTTP 402** 확인,
   `pay fetch` → USDC 결제 + grounded 답변(citation 포함) 수신. 사람 클릭 0회.
4. **[2:15–3:00] 정산 증빙.** Solana explorer에서 실제 tx 확인, Studio Settlements
   화면에서 `PaymentSettlement` ledger 확인. creator vault에 수익이 도착했다.

## Definition of Done

- [ ] 외부 pay client가 Catalog에서 에이전트를 발견하고 402 챌린지만으로 결제를 완성한다.
- [ ] devnet explorer에서 확인 가능한 실제 USDC tx가 발생한다. 결제 순간 사람 클릭 0회.
- [ ] 답변에 Datastore grounded citation이 포함된다.
- [ ] creator의 `PaymentSettlement` ledger에 정산이 기록된다.
- [ ] 라이브 배포 URL이 접속 가능하다.
- [ ] 3분 내 end-to-end 데모가 재현된다.

## 참고 자료 (킥오프 세션 덱)

- Google X Solana AI Agentic Hackathon Intro Deck — 심사 기준·트랙·일정
- The Agentic Commerce Stack: x402 & MPP (Four Pillars) — 당위성 프레임, 헤드리스 머천트 정의
- Why Solana for Agentic Commerce (Solana Foundation) — pay.sh 정의, "해커톤에서 보고 싶은 것"
