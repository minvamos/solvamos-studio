# Platform database — **GCP Cloud SQL (PostgreSQL)** + Prisma
>
> Env = fixed infra only (`DATABASE_URL`, GCP project, OAuth client, …).  
> Users / tenants / agents / wallets / catalog / RAG docs = **this DB**.  
> Dev and “prod mode” share the same Cloud SQL; switch behavior with `NODE_ENV` / flags — not a separate Docker DB.

## Why Cloud SQL (not Docker Postgres)

- GCP에서 백업·패치·IAM 관리
- 로컬 `npm run dev`도 같은 인스턴스에 연결 (Auth Proxy 또는 authorized network)
- Cloud Run도 동일 `DATABASE_URL` / Unix socket

## ER (logical)

```
User 1──* Session
User 1──* Wallet
User *──* Tenant          (TenantMember)
Tenant 1──* Agent
User 1──* AgentOwnership *──1 Agent
User 1──* CatalogAgent    (ownerUserId, optional)
Agent.id == CatalogAgent.agentId == AgentOwnership.agentId
Agent 1──* RagDocument
```

| Table | Role |
|-------|------|
| `Agent` | Runtime (RAG / invoke / vault) |
| `CatalogAgent` | Public discovery SoT (marketplace) |
| `AgentOwnership` | User ↔ agentId (`owner` / `editor` / `viewer`) |

`CatalogListing` was replaced by `CatalogAgent`.  
`solvamos-catalog` shares the same Cloud SQL `DATABASE_URL` and reads `CatalogAgent` (file `/tmp` is fallback only when `DATABASE_URL` is unset).

Seed agents (`support-copilot-001`, `academic-research-001`) live in `Agent` and are synced into `CatalogAgent` on Studio boot (`syncAllAgentsToCatalog`).
