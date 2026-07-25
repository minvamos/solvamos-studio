# SolVamos Studio — Database ER Diagram

> 기준: 2026-07-25  
> Source of truth: `prisma/schema.prisma`  
> Engine: PostgreSQL (Cloud SQL) + Prisma

`PaymentSettlement` 포함 전체 스키마는 `npx prisma migrate deploy`로 반영한다.  
Catalog는 동일 Cloud SQL의 `CatalogAgent`를 읽되 **migration은 Studio만** 실행한다.

## Overview

```mermaid
erDiagram
  User ||--o{ Session : "has"
  User ||--o{ Wallet : "owns"
  User ||--o{ TenantMember : "joins"
  User ||--o{ AgentOwnership : "owns"
  User ||--o{ CatalogAgent : "publishes"
  User }o--o| Tenant : "primaryTenant"

  Tenant ||--o{ TenantMember : "contains"
  Tenant ||--o{ Agent : "hosts"
  Tenant ||--o{ Session : "scopes"
  Tenant ||--o{ CatalogAgent : "scopes"

  Agent ||--o{ AgentOwnership : "grants"
  Agent ||--o{ RagDocument : "mirrors"
  Agent ||--o{ PaymentSettlement : "settles (logical)"

  CatalogAgent }o--|| Agent : "agentId soft-link"
  PaymentSettlement }o--|| Agent : "agentId soft-link"
  PaymentSettlement }o--o| User : "ownerUserId soft-link"
```

## Entity detail

```mermaid
erDiagram
  User {
    string id PK
    string email UK
    string name
    string picture
    string passwordHash
    string googleSub UK
    datetime emailVerifiedAt
    string primaryTenantId FK
    datetime createdAt
    datetime updatedAt
  }

  Session {
    string id PK
    string userId FK
    string email
    string name
    string picture
    text accessToken
    text refreshToken
    datetime expiry
    string via
    string tenantId FK
    string refreshTokenHash
    datetime refreshExpiresAt
    datetime revokedAt
    string userAgent
    string ip
    datetime createdAt
    datetime updatedAt
  }

  Tenant {
    string id PK
    string displayName
    string projectId
    string folderId
    string tier
    string status
    string kmsKeyId
    string cloudRunUri
    string cloudRunServiceName
    string cloudRunStatus
    text errorMessage
    boolean byoProject
    string tenancyMode
    boolean sharedProject
    json provisionNotes
    datetime createdAt
    datetime updatedAt
  }

  TenantMember {
    string tenantId PK_FK
    string userId PK_FK
    string role
    datetime createdAt
  }

  Agent {
    string id PK
    string tenantId FK
    string agentName
    string role
    string customRole
    string tone
    string securityLevel
    string publicKey
    text systemPrompt
    int invokeCount
    string googleDriveFolderId
    string vertexDataStoreId
    string vertexEngineId
    string aiAppType
    string dataSourceType
    string websiteUri
    string gcsUri
    string secretManagerPath
    string status
    float feeUsdc
    datetime createdAt
    datetime updatedAt
  }

  AgentOwnership {
    string id PK
    string userId FK
    string agentId FK
    string role
    datetime createdAt
  }

  Wallet {
    string id PK
    string userId FK
    string address
    string label
    string source
    boolean isPrimary
    datetime createdAt
    datetime updatedAt
  }

  CatalogAgent {
    string catalogId PK
    string agentId UK
    string fqn
    string title
    text description
    text useCase
    string category
    string role
    string tone
    string invokeUrl
    string originInvokeUrl
    string agentCardUrl
    float feeUsdc
    string token
    string network
    string usdcMint
    string paymentProtocol
    string recipientWallet
    string_array tags
    string source
    string studioOrigin
    string tenantId FK
    string ownerUserId FK
    string ownerEmail
    string status
    json endpoints
    datetime listedAt
    datetime updatedAt
  }

  RagDocument {
    string id PK
    string agentId FK
    string driveFileId
    string name
    string mimeType
    text text
    string webViewLink
    datetime createdAt
    datetime updatedAt
  }

  PaymentSettlement {
    string id PK
    string signature UK
    string agentId
    string recipientWallet
    float amountUsdc
    string status
    int blockHeight
    string network
    string proofKind
    string ownerUserId
    datetime createdAt
  }

  User ||--o{ Session : has
  User ||--o{ Wallet : owns
  User ||--o{ TenantMember : joins
  User ||--o{ AgentOwnership : owns
  User ||--o{ CatalogAgent : publishes
  Tenant ||--o{ TenantMember : contains
  Tenant ||--o{ Agent : hosts
  Tenant ||--o{ CatalogAgent : scopes
  Agent ||--o{ AgentOwnership : grants
  Agent ||--o{ RagDocument : mirrors
```

## Soft links (no DB FK)

| From | To | Key | Notes |
|------|----|-----|--------|
| `CatalogAgent.agentId` | `Agent.id` | soft | marketplace projection ↔ runtime agent |
| `PaymentSettlement.agentId` | `Agent.id` | soft | settlement UI / ownership filter |
| `PaymentSettlement.ownerUserId` | `User.id` | soft | optional denormalized owner |

FK로 묶지 않는 이유: Catalog·gateway 경로에서 agent lifecycle과 settlement ingest 순서가 어긋나도 listing/receipt가 orphan으로 남지 않게 하기 위함이다.

## Tables checklist

| Table | Purpose |
|-------|---------|
| `User` | platform identity |
| `Session` | cookie/JWT session + Drive OAuth |
| `Tenant` / `TenantMember` | workspace |
| `Agent` | runtime RAG agent + vault |
| `AgentOwnership` | user ↔ agent ACL |
| `Wallet` | operator Solana addresses |
| `CatalogAgent` | public marketplace listing |
| `RagDocument` | Drive/local text mirror |
| `PaymentSettlement` | verified pay receipts |

## Apply / verify

```bash
# Studio only
npx prisma migrate deploy
npx prisma migrate status
```

`PaymentSettlement`는 migration `20260724160000_payment_settlements`에서 생성된다.
