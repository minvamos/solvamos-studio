# Platform Database

> 기준: 2026-07-25
> PostgreSQL + Prisma. Production은 GCP Cloud SQL을 사용한다.

## 원칙

- Studio Prisma schema와 migration이 데이터베이스 변경의 소유자다.
- Catalog는 동일 Cloud SQL의 `CatalogAgent`를 읽고 쓸 수 있지만 migration을 만들지 않는다.
- 환경 변수는 연결 정보와 고정 인프라만 담는다.
- 사용자, tenant, agent, ownership, wallet, listing, RAG mirror, settlement는 DB에 저장한다.
- 실제 검색 지식은 Discovery Engine Datastore에 있으며 DB는 resource ID와 ingest mirror를 보존한다.

## 논리 ER

상세 속성 포함 Mermaid ERD: [`DATABASE_ERD.md`](./DATABASE_ERD.md)

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ Wallet : owns
  User ||--o{ TenantMember : joins
  Tenant ||--o{ TenantMember : contains
  Tenant ||--o{ Agent : hosts
  User ||--o{ AgentOwnership : owns
  Agent ||--o{ AgentOwnership : grants
  User ||--o{ CatalogAgent : publishes
  Tenant ||--o{ CatalogAgent : scopes
  Agent ||--o{ RagDocument : mirrors
  Agent ||--o{ PaymentSettlement : receives
```

`Agent`, `AgentOwnership`, `CatalogAgent`, `PaymentSettlement` 사이의 agent 연결은 `agentId`를 사용한다. `PaymentSettlement.agentId`와 `CatalogAgent.agentId`는 현재 DB foreign key가 아닌 논리 키다.

## 모델

### `User`

- email/password 또는 Google identity
- primary tenant
- Google link 여부

### `Session`

- server-side 로그인 상태
- Google Drive OAuth access/refresh token
- refresh JWT hash와 rotation/revocation
- user agent/IP audit metadata

### `Tenant`, `TenantMember`

- 현재 기본은 하나의 shared GCP project를 사용하는 Lab tenant
- membership role로 workspace 접근 제어
- isolated project 관련 metadata는 향후 productization용

### `Agent`

- prompt policy: role, customRole, tone, securityLevel
- 전용 vault public key 및 Secret Manager path
- `vertexDataStoreId`, `vertexEngineId`
- source/app type
- fee/status/invoke count

### `AgentOwnership`

- `owner | editor | viewer`
- owner test chat 및 사용자별 agent list의 권한 source

### `Wallet`

- 사용자 운영 지갑
- agent vault와 별도
- user/address unique, primary wallet 지원

### `CatalogAgent`

- 공개 marketplace projection
- 가격, 결제 protocol, gateway invoke URL
- Studio origin, Agent Card, owner/tenant denormalized metadata
- `listed | unlisted | paused`

영속 listing source of truth는 이 테이블이고, 공개 discovery surface는 `solvamos-catalog`다.

### `RagDocument`

- Drive/로컬 ingest 문서의 메타와 추출 text mirror
- PDF binary는 SQL에 저장하지 않는다
- 실제 검색 index는 Datastore

### `PaymentSettlement`

- signature/receipt ID
- agent, recipient, amount, status, network, proof kind, slot

현재 주의: gateway-only 상업 호출에서 settlement receipt를 이 모델에 적재하는 callback은 아직 연결되지 않았다. 따라서 production ledger로 완성된 상태가 아니다.

## Migration

Studio:

```bash
npx prisma generate
npx prisma migrate deploy
```

Catalog:

```bash
npx prisma generate
```

Catalog에서는 `migrate deploy`를 실행하지 않는다.

## Local 연결

Cloud SQL Auth Proxy 또는 승인된 network를 사용한다.

```env
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/solvamos_studio?schema=public
```

Cloud Run에서는 Unix socket 또는 connector 기반 URL을 Secret Manager로 전달한다.

## 일관성 규칙

1. Agent 생성/수정 후 `CatalogAgent`를 upsert한다.
2. Agent 삭제 전에 listing을 unlist한다.
3. `vertexDataStoreId`와 `vertexEngineId`는 쌍으로 reconcile한다.
4. Catalog schema 변경은 Studio migration과 동시에 배포한다.
5. gateway receipt는 idempotency key로 settlement upsert해야 한다.

## Seed

개발 환경에서만 support/academic seed가 생성될 수 있다. production marketplace는 seed/mock source를 제외한다.
