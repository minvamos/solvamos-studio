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
Agent 1──1 CatalogListing
Agent 1──* RagDocument
```

| Table | Purpose |
|-------|---------|
| `User` | Google SSO identity |
| `Session` | cookie → tokens |
| `Tenant` | customer / lab + GCP project |
| `Agent` | built agent + `vertexDataStoreId` |
| `Wallet` | Solana addresses |
| `CatalogListing` | pay.sh / A2A |
| `RagDocument` | Drive text in DB |

## Instance (Lab)

- Project: `project-64269e62-555d-4979-88e`
- Instance: `solvamos-studio-pg`
- Region: `asia-northeast3`
- DB name: `solvamos_studio`

## Connect from local (dev)

### Option A — Cloud SQL Auth Proxy (권장)

```bash
# one-time
gcloud components install cloud-sql-proxy   # or download binary

cloud-sql-proxy project-64269e62-555d-4979-88e:asia-northeast3:solvamos-studio-pg --port=5432
```

`.env`:

```env
DATABASE_URL=postgresql://solvamos:PASSWORD@127.0.0.1:5432/solvamos_studio?schema=public
```

### Option B — Public IP + authorized network

콘솔에서 내 IP allow 후:

```env
DATABASE_URL=postgresql://solvamos:PASSWORD@PUBLIC_IP:5432/solvamos_studio?schema=public
```

## Migrate / generate

```bash
npm install
npx prisma migrate dev --name init
npx prisma generate
npm run dev
```

## Cloud Run

Use Cloud SQL connector / Unix socket in `DATABASE_URL`, and attach the instance to the Cloud Run service. Runtime SA needs `roles/cloudsql.client`.

## Auth (JWT + signup)

- Access JWT ~15m (prod) + refresh rotation; refresh hash on `Session`; reuse → revoke all
- Cookies: `solvamos_at` / `solvamos_rt` / `solvamos_sid` (HttpOnly, SameSite=Lax, Secure in prod)
- Email/password: `POST /api/auth/register`, `POST /api/auth/login`
- Google: `GET /api/auth/google?intent=login|signup|link`
- Lab tenant: `demo` / `SOLVAMOS_SHARED_TENANT_ID` / `SOLVAMOS_TENANT_ID` → `GOOGLE_CLOUD_PROJECT`
- Env: `JWT_SECRET` (≥32 chars, required in production)

```bash
npx tsx scripts/seed-lab-tenant.ts
```
