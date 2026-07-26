-- Per-agent A2A peer escalation (catalog free/paid peers)
ALTER TABLE "Agent" ADD COLUMN "a2aPeersEnabled" BOOLEAN NOT NULL DEFAULT true;
