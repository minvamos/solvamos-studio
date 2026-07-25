-- Agent runtime mode (specialized AI Applications vs autonomous Gemini+RAG)
ALTER TABLE "Agent" ADD COLUMN "runtimeMode" TEXT DEFAULT 'specialized';
ALTER TABLE "Agent" ADD COLUMN "customInstructions" TEXT;
