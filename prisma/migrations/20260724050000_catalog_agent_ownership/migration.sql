-- CatalogAgent (public discovery SoT) + AgentOwnership (user ↔ agentId)
-- Replaces unused CatalogListing; agentId is the join key across Agent / CatalogAgent / Ownership.

CREATE TABLE IF NOT EXISTS "AgentOwnership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentOwnership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentOwnership_userId_agentId_key" ON "AgentOwnership"("userId", "agentId");
CREATE INDEX IF NOT EXISTS "AgentOwnership_agentId_idx" ON "AgentOwnership"("agentId");
CREATE INDEX IF NOT EXISTS "AgentOwnership_userId_idx" ON "AgentOwnership"("userId");

ALTER TABLE "AgentOwnership"
  DROP CONSTRAINT IF EXISTS "AgentOwnership_userId_fkey",
  DROP CONSTRAINT IF EXISTS "AgentOwnership_agentId_fkey";

ALTER TABLE "AgentOwnership"
  ADD CONSTRAINT "AgentOwnership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AgentOwnership_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "CatalogAgent" (
    "catalogId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fqn" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "useCase" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'ai_ml',
    "role" TEXT,
    "tone" TEXT,
    "invokeUrl" TEXT NOT NULL,
    "originInvokeUrl" TEXT,
    "agentCardUrl" TEXT,
    "feeUsdc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "token" TEXT NOT NULL DEFAULT 'USDC',
    "network" TEXT NOT NULL DEFAULT 'devnet',
    "usdcMint" TEXT,
    "paymentProtocol" TEXT NOT NULL DEFAULT 'free',
    "recipientWallet" TEXT,
    "tags" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'studio',
    "studioOrigin" TEXT,
    "tenantId" TEXT,
    "ownerUserId" TEXT,
    "ownerEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'listed',
    "endpoints" JSONB,
    "listedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogAgent_pkey" PRIMARY KEY ("catalogId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CatalogAgent_agentId_key" ON "CatalogAgent"("agentId");
CREATE INDEX IF NOT EXISTS "CatalogAgent_status_idx" ON "CatalogAgent"("status");
CREATE INDEX IF NOT EXISTS "CatalogAgent_tenantId_idx" ON "CatalogAgent"("tenantId");
CREATE INDEX IF NOT EXISTS "CatalogAgent_ownerUserId_idx" ON "CatalogAgent"("ownerUserId");
CREATE INDEX IF NOT EXISTS "CatalogAgent_studioOrigin_idx" ON "CatalogAgent"("studioOrigin");
CREATE INDEX IF NOT EXISTS "CatalogAgent_category_idx" ON "CatalogAgent"("category");

-- Migrate legacy CatalogListing rows if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'CatalogListing'
  ) THEN
    INSERT INTO "CatalogAgent" (
      "catalogId", "agentId", "fqn", "title", "description", "useCase", "category",
      "role", "tone", "invokeUrl", "feeUsdc", "token", "network", "usdcMint",
      "paymentProtocol", "recipientWallet", "tags", "source", "tenantId", "status",
      "listedAt", "updatedAt"
    )
    SELECT
      c."catalogId",
      c."agentId",
      'solvamos/' || c."agentId",
      c."name",
      c."description",
      '',
      'ai_ml',
      c."role",
      c."tone",
      c."invokeUrl",
      c."feeUsdc",
      c."token",
      c."network",
      c."usdcMint",
      CASE WHEN c."feeUsdc" > 0 THEN 'x402 / MPP' ELSE 'free' END,
      c."recipientWallet",
      c."tags",
      'studio',
      c."tenantId",
      c."status",
      c."listedAt",
      c."updatedAt"
    FROM "CatalogListing" c
    ON CONFLICT ("catalogId") DO NOTHING;

    DROP TABLE "CatalogListing";
  END IF;
END $$;

ALTER TABLE "CatalogAgent"
  DROP CONSTRAINT IF EXISTS "CatalogAgent_agentId_fkey",
  DROP CONSTRAINT IF EXISTS "CatalogAgent_tenantId_fkey",
  DROP CONSTRAINT IF EXISTS "CatalogAgent_ownerUserId_fkey";

-- No FK on agentId: catalog can upsert listings independently; AgentOwnership enforces user↔agent.
ALTER TABLE "CatalogAgent"
  ADD CONSTRAINT "CatalogAgent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CatalogAgent"
  ADD CONSTRAINT "CatalogAgent_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
