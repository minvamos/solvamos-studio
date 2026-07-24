# Studio ↔ Catalog Integration

> 기준: 2026-07-25

## 책임

- `CatalogAgent` PostgreSQL 테이블: 영속 listing source of truth
- `solvamos-catalog`: 공개 discovery의 권위 있는 HTTP/UI surface
- Studio: runtime Agent를 listing으로 projection하고 publish하는 producer
- pay-gateway: paid listing의 public invoke target

## 현재 write 경로

Studio는 두 경로를 병행한다.

1. `server/catalog-db.ts`가 shared Cloud SQL `CatalogAgent`를 직접 upsert
2. `server/paysh-catalog.ts`가 Catalog service write API에 publish

Catalog도 `DATABASE_URL`이 있으면 같은 `CatalogAgent`에 upsert한다. 따라서 shared DB production에서는 의미상 중복 write다.

현재 목적:

- Studio DB 저장 직후 listing durability
- Catalog service 경계 유지
- Catalog cold start/file fallback hydrate
- 원격 Catalog cache 갱신

향후에는 다음 중 하나로 단순화해야 한다.

### 선택 A: shared DB + outbox

- Studio transaction: Agent + CatalogAgent + outbox
- Catalog는 read only
- publish event로 cache/invalidation

### 선택 B: Catalog API 단일 writer

- Studio는 Catalog API만 호출
- Catalog가 CatalogAgent를 write
- retry/outbox/idempotency를 Studio에 추가

서비스 분리를 명확히 하려면 B, DB transaction 일관성이 우선이면 A가 적합하다.

## Environment contract

Studio:

```env
DATABASE_URL=<shared Cloud SQL>
APP_URL=https://<studio>.run.app
CATALOG_SITE_URL=https://<catalog>.run.app
CATALOG_ADMIN_SECRET=<shared secret>
PAY_GATEWAY_URL=https://<gateway>.run.app
USE_PAY_GATEWAY=true
```

Catalog:

```env
DATABASE_URL=<same Cloud SQL>
PUBLIC_BASE_URL=https://<catalog>.run.app
STUDIO_URL=https://<studio>.run.app
PAY_GATEWAY_URL=https://<gateway>.run.app
CATALOG_ADMIN_SECRET=<same secret>
```

Production에서는 canonical URL을 source code에 하드코딩하지 않고 env/API status에서 제공해야 한다.

## Listing URL 규칙

### Paid

```text
https://<gateway>/v1/agents/{agentId}/invoke
```

- public HTTPS 필수
- localhost/pending URL은 production publish 거부 또는 repair
- `paymentProtocol = x402 / MPP`

### Free

```text
https://<studio>/api/agents/{agentId}/invoke
```

- plain POST/GET invoke 가능
- `paymentProtocol = free`

### Supporting URLs

- HTML: `<catalog>/a/{agentId}`
- JSON: `<catalog>/api/solvamos/{agentId}`
- Markdown: `<catalog>/api/solvamos/{agentId}/index.md`
- Agent Card: `<studio>/api/agents/{agentId}/agent-card`

## HTTP API

Public read:

- `GET /health`
- `GET /api/catalog`
- `GET /api/catalog/:agentId`
- `GET /api/solvamos/:agentId`
- `GET /api/solvamos/:agentId/index.md`

Admin write:

- `POST /api/catalog/agents`
- `POST /api/catalog/agents/bulk`
- `DELETE /api/catalog/agents/:agentId`
- `POST /api/catalog/agents/:agentId/unlist`

Write header:

```http
X-Catalog-Admin-Secret: <secret>
```

## Read/refresh

Studio는 원격 `/api/catalog`을 짧게 cache하여 A2A peer discovery에 사용한다.

1. 현재 Studio origin으로 filter
2. 결과가 비면 global catalog 한 번 조회
3. `listed`만 in-memory mirror에 보관
4. create/update 후 cache invalidate

Catalog marketplace는 DB에서 다음을 제외한다.

- `status != listed`
- seed source
- 고정 개발 seed ID

## Boot reconciliation

Studio boot:

1. DB Agent load
2. 각 Agent를 `CatalogAgent`에 sync
3. `CATALOG_SITE_URL` 설정 시 bulk hydrate
4. 원격 Catalog refresh

이 흐름은 eventual consistency다. DB write와 remote HTTP publish 사이 transaction은 없다.

## Known drift

- 프론트 일부에 Catalog Cloud Run URL이 하드코딩되어 있다.
- Studio CI workflow에 `CATALOG_SITE_URL`/admin secret binding이 빠질 수 있다.
- `/api/status` 일부 remote-config 상태가 실제 config와 다를 수 있다.
- `CATALOG_SOURCES`는 선언되어 있으나 import source로 사용되지 않는다.
- file seed JSON은 production DB listing source가 아니다.

## 완료 조건

- canonical URL 단일 source
- write model A 또는 B 결정
- write idempotency와 retry
- stale listing reconciliation
- fee/gateway URL validation
- Catalog metrics를 실제 invoke/settlement 집계와 연결
- admin shared secret을 IAM/OIDC로 대체
