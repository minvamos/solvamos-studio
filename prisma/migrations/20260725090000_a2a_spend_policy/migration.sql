-- A2A spend policy fields on Agent
ALTER TABLE "Agent" ADD COLUMN "maxSpendPerCallUsdc" DOUBLE PRECISION;
ALTER TABLE "Agent" ADD COLUMN "dailyBudgetUsdc" DOUBLE PRECISION;

-- Buyer agent tracking on settlements (A2A daily budget aggregation)
ALTER TABLE "PaymentSettlement" ADD COLUMN "payerAgentId" TEXT;

-- CreateIndex
CREATE INDEX "PaymentSettlement_payerAgentId_idx" ON "PaymentSettlement"("payerAgentId");
