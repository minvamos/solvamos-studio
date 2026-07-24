-- CreateTable
CREATE TABLE "PaymentSettlement" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "recipientWallet" TEXT NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "blockHeight" INTEGER,
    "network" TEXT,
    "proofKind" TEXT,
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSettlement_signature_key" ON "PaymentSettlement"("signature");

-- CreateIndex
CREATE INDEX "PaymentSettlement_agentId_idx" ON "PaymentSettlement"("agentId");

-- CreateIndex
CREATE INDEX "PaymentSettlement_ownerUserId_idx" ON "PaymentSettlement"("ownerUserId");

-- CreateIndex
CREATE INDEX "PaymentSettlement_createdAt_idx" ON "PaymentSettlement"("createdAt");
