-- AlterTable User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "primaryTenantId" TEXT;

-- AlterTable Session
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "refreshTokenHash" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "refreshExpiresAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "ip" TEXT;
ALTER TABLE "Session" ALTER COLUMN "via" SET DEFAULT 'password';

CREATE UNIQUE INDEX IF NOT EXISTS "User_googleSub_key" ON "User"("googleSub");
CREATE INDEX IF NOT EXISTS "User_primaryTenantId_idx" ON "User"("primaryTenantId");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "Session_refreshTokenHash_idx" ON "Session"("refreshTokenHash");

DO $$ BEGIN
 ALTER TABLE "User" ADD CONSTRAINT "User_primaryTenantId_fkey" FOREIGN KEY ("primaryTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;