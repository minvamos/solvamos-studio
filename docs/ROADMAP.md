# SolVamos 구현 현황과 Roadmap

> 기준: 2026-07-25  
> 우선순위는 기능 수가 아니라 **상업 경로의 정확성, 데이터 무결성, 운영 가능성** 순이다.

## 현재 baseline

완료된 핵심 방향:

- 지식 source를 agent별 Discovery Engine Datastore로 수렴
- Datastore마다 AI Applications Engine 연결
- 웹사이트는 `PUBLIC_WEBSITE` + `hostname/*` + recrawl
- 텍스트 대화는 Engine Answer API 우선
- 첨부와 live web은 Datastore search + Vertex Gemini
- conversation history와 Engine session
- Catalog를 공개 discovery surface로 분리
- 유료 public invoke를 pay-gateway로 고정
- shared Cloud SQL의 `CatalogAgent`로 listing 영속화
- agent별 Secret Manager vault
- 비용 인식 A2A

## P0 — 상업 호출을 닫힌 루프로 만들기

### P0.1 동적 gateway 가격

문제:

- Agent/Catalog fee는 가변
- provider YAML metering은 `0.001` 고정

완료 조건:

- gateway가 agent ID별 가격을 신뢰 가능한 source에서 조회하거나 signed quote를 사용
- 402 amount와 `CatalogAgent.feeUsdc`가 일치
- 가격 변경 시 cache/in-flight quote 정책 정의
- client가 결제한 amount를 origin이 검증 가능한 receipt로 전달

### P0.2 gateway settlement ingestion

문제:

- `PaymentSettlement`와 UI는 존재
- gateway-only 호출의 verified receipt가 Studio DB에 기록되지 않음

완료 조건:

- signed callback/header 계약
- signature/receipt ID idempotency
- agentId, charged amount, token, network, payer, recipient, gateway request ID 저장
- 성공/실패/refund/dispute 상태
- webhook replay 차단
- settlement UI와 실제 gateway 거래 대조

### P0.3 public origin 봉쇄 검증

- paid agent가 origin proof로 실행되지 않는 integration test
- internal route는 올바른 secret 없이는 403
- Catalog paid URL은 public gateway HTTPS가 아니면 publish 실패
- free agent/owner test regression test

## P0 — 배포/DB 안정화

### P0.4 migration과 production roll-out

- `PaymentSettlement` migration 적용
- Studio/Catalog Prisma schema drift 검사
- build → deploy → smoke 자동화
- production safety env 검증
- current uncommitted feature set을 reviewable commit/PR로 분리

### P0.5 website/Engine reconciliation

기존 agent는 빈 Datastore 또는 Engine 누락 상태일 수 있다.

- 모든 Agent의 Datastore/Engine 존재 검사
- website Datastore contentConfig 검사
- targetSites `hostname/*` 검사
- 잘못된 pattern 수정 또는 agent 재생성
- recrawl trigger
- 문서 수/Engine readiness를 DB 상태와 동기화

### P0.6 Authorization matrix

- 인증 없는 `/api/agents`가 전체 Agent를 반환하지 않도록 정책 결정
- tenant/agent read·mutation route별 owner/editor/viewer 권한 표
- `requireGoogleSession`을 실제 의미에 맞게 `requireUserSession`과 Drive token guard로 분리
- shared Lab 편의 route와 production route 분리
- integration test로 cross-tenant 접근 차단

## P1 — RAG 품질과 대화 계약

### P1.1 Engine session 내구성

현재 session은 browser memory에 있다.

- conversation/thread 모델 도입
- session resource name server-side 저장
- agent/user/thread ownership
- 만료/session recreation 처리
- 여러 탭 및 재로그인 연속성

### P1.2 citation 통합

- Engine citation
- Datastore search citation
- Google Search grounding metadata
- A2A peer provenance
- attachment filename/page

모두 하나의 typed citation contract로 정규화하고 UI에서 source badge와 URL을 표시한다.

### P1.3 multimodal output

- Engine `blobAttachments`/corpus image parsing
- 생성 figure/image의 안전한 표시
- MIME/size scan
- object URL lifecycle 정리
- PDF page citation

### P1.4 attachment storage 선택

현재 turn attachment는 base64 JSON이다.

- 작은 파일 inline, 큰 파일 signed GCS upload
- malware/content scan
- retention/삭제 정책
- “이번 turn만”과 “agent 지식에 추가” UX 분리

## P1 — 운영 관측성

- request/correlation ID
- gateway request ID → settlement → invoke trace
- structured JSON log
- Cloud Trace/OpenTelemetry
- Engine latency, search latency, model latency
- A2A hop latency/cost/success
- index document count/readiness dashboard
- Cloud Monitoring SLO와 alert

추가 정리:

- `/api/status`의 Catalog remote-config 값을 실제 `CATALOG_SITE_URL` 기준으로 계산
- settlement 탭 진입 시 최신 데이터 fetch
- marketplace의 placeholder metric을 실제 집계로 대체하거나 제거

## P1 — A2A 비용 정책

- owner/account별 turn budget
- 유료 peer 호출 전 승인 옵션
- 월/일 spending limit
- peer depth/loop 차단
- retry/idempotency
- planner decision trace
- peer quality score와 circuit breaker

## P1 — 보안

- Catalog admin secret rotation 또는 service-to-service IAM/OIDC
- gateway internal secret rotation
- Google OAuth token encryption at rest
- attachment request size를 Express/body parser와 일치
- CORS origin 최소화
- tenant/agent authorization을 모든 mutation/read route에 일관 적용
- Secret Manager orphan cleanup
- security review와 threat model
- `/tmp` payment replay cache를 durable idempotency store로 이전
- production에서 `VERTEX_SHARED_DATA_STORE` 사용 금지 또는 Engine 보장

## P2 — tenancy productization

현재 shared Lab:

- 하나의 GCP project
- DB ownership 기반 논리 격리

목표 isolated:

- customer별 project
- billing/folder/org policy
- per-tenant service account
- per-tenant Secret Manager/KMS/Discovery resources
- quota와 비용 attribution
- provisioning rollback/reconcile
- BYO GCP project

isolated mode는 조직·billing·IAM·support 프로세스가 준비된 뒤 feature flag로 활성화한다.

## P2 — connector 확장

- GCS native import
- API import job
- structured JSON/CSV schema mapping
- BigQuery connector
- Drive incremental sync/change token
- website sitemap/robots/crawl diagnostics
- document delete/reconciliation

## P2 — Catalog 제품화

- category/tag/filter/search
- ownership 검증 badge
- health/index readiness
- 가격 이력
- usage/reputation
- versioned Agent Card
- Catalog write path를 shared DB direct + remote API 중 하나로 단순화
- stale listing cleanup

## 기술 부채

### 단일 `server.ts`

route가 한 파일에 집중되어 있다. 다음 bounded module로 분리한다.

- health/status
- tenant
- agent CRUD/provision
- invoke
- payment/gateway
- catalog adapter

### 단일 `App.tsx`

auth, wallet, builder, chat, settlement 상태를 hooks/services로 분리한다.

- `useAuth`
- `useAgents`
- `useAgentBuilder`
- `useAgentChat`
- `useWallets`
- API client와 runtime DTO

함께 제거/통합할 항목:

- route에 연결되지 않은 `PublicCatalogPage`
- 사용되지 않는 live prompt preview state
- legacy signature/custom payment state
- Dev Agent Lab과 owner chat의 attachment/web/session 기능 차이
- 여러 컴포넌트에 반복된 Catalog hardcoded URL

### 중복 Catalog write

Studio가 shared DB `CatalogAgent`를 직접 upsert하면서 remote Catalog API에도 publish한다. 장애 시 둘의 의미가 혼동될 수 있다.

권장:

- DB가 완전히 shared라면 transaction/outbox 기반 DB write + Catalog read
- 서비스 경계를 유지하려면 Studio는 Catalog API만 쓰고 Catalog가 DB write

한 모델을 선택하고 문서/코드를 일치시킨다.

### 배포 설정 drift

- project가 고정된 build YAML과 `$PROJECT_ID` 기반 pipeline 통일
- service name 통일
- Studio deploy에 `CATALOG_SITE_URL`, `CATALOG_ADMIN_SECRET` 연결
- canonical Studio/Catalog/gateway URL을 env 한 곳에서 관리
- legacy deploy 파일은 archive 또는 명시적 build-only로 전환

### Ephemeral runtime files

Cloud Run `/tmp`의 local corpus, OAuth cache, payment replay는 instance 재시작 시 사라진다.

- corpus는 Datastore/Cloud SQL을 권위 source로 사용
- OAuth session은 DB만 사용하도록 file cache 축소
- payment replay/idempotency는 DB/Redis 등 durable store로 이동
- `/tmp` fallback 사용 시 상태 API에 명시

### legacy payment 코드

public origin에서는 사용하지 않지만 A2A Lab fallback과 verifier가 남아 있다.

- legacy fallback을 명시적 development module로 격리
- production bundle에서 비활성 보장
- gateway receipt verifier와 이름/책임 분리

## 검증 matrix

각 release에서 최소 다음을 자동화한다.

- password/Google login과 refresh rotation
- agent create: local file, Drive, website
- website target site pattern
- Engine Answer API citation/session
- attachment image/PDF
- Google Search tool fallback
- free origin invoke
- paid origin 402 gateway redirect
- gateway secret 403/200
- Catalog paid/free URL
- A2A free/paid/failure recovery
- migration + Studio/Catalog schema compatibility

## 문서 유지 규칙

- 아키텍처 변경 PR은 `ARCHITECTURE.md`를 함께 수정
- 사용자 흐름 변경은 `PROCESSES.md`
- env 추가/삭제는 `.env.example`과 운영 runbook
- 완료된 roadmap 항목은 baseline으로 옮기고 날짜 기록
- “구현됨”은 build 통과만이 아니라 end-to-end 경로가 연결된 상태를 의미
