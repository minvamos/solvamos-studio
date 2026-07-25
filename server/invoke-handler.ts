/**
 * Shared agent invoke runner (RAG + optional A2A). Used by:
 * - Studio / legacy public /api/agents/:id/invoke
 * - pay.sh gateway upstream /v1/agents/:id/invoke (no paywall)
 */
import { config, networkLabel } from './config.js';
import { getAgent, bumpInvoke, type AgentRecord } from './agents-store.js';
import { orchestrateA2ATurn } from './a2a.js';
import {
  getCatalogEntry,
  registerAgentOnPayShCatalog,
} from './paysh-catalog.js';
import { recordInvokeEvidence } from './invoke-evidence.js';
import { serverLog } from './dev-log.js';

export type InvokeInput = {
  agentId: string;
  prompt: string;
  enableA2A?: boolean;
  /** When true, peers default off unless enableA2A */
  studioOwnerTest?: boolean;
  baseUrl?: string;
  history?: { role: 'user' | 'model'; text: string }[];
  attachments?: { name: string; mimeType: string; dataBase64: string }[];
  webSearch?: boolean;
  answerSession?: string;
  /** Upstream A2A call chain (X-A2A-Chain) — loop / depth prevention */
  callChain?: string[];
};

export type InvokeSuccess = {
  status: 'success';
  answer: string;
  data: string;
  confidence: number;
  citations: any[];
  ragMode: string;
  paymentLogs: string[];
  network: string;
  feeUsdc: number;
  paywallSkipped: boolean;
  payShCatalogId?: string;
  generation: string;
  engineId?: string | null;
  dataStoreId?: string | null;
  session?: string | null;
  relatedQuestions?: string[];
  toolsUsed?: string[];
  a2a: {
    catalogUsed: boolean;
    planningNote?: string;
    peerHops: any[];
    spendTier?: string;
  };
};

export async function ensureListed(
  agent: AgentRecord,
  baseUrl?: string
): Promise<ReturnType<typeof getCatalogEntry>> {
  let listing = getCatalogEntry(agent.id);
  if (!listing || listing.status !== 'listed') {
    listing = await registerAgentOnPayShCatalog(agent, { baseUrl });
  }
  return listing;
}

export function agentFeeUsdc(agent: AgentRecord): number {
  const configured =
    typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : config.defaultAgentFeeUsdc;
  // Honor the agent's listed fee. Gateway YAML may still meter a fixed price for
  // public pay.sh invokes — Studio paywall / catalog metadata use this value.
  return configured;
}

export async function runAgentInvoke(
  input: InvokeInput,
  paymentLogs: string[] = []
): Promise<{ httpStatus: number; body: InvokeSuccess | Record<string, unknown> }> {
  const agent = await getAgent(input.agentId);
  if (!agent) {
    return {
      httpStatus: 404,
      body: { status: 'error', message: `Agent with ID ${input.agentId} not found.` },
    };
  }
  if (!input.prompt?.trim()) {
    return {
      httpStatus: 400,
      body: { status: 'error', message: 'Missing input parameter: prompt' },
    };
  }

  const listing = await ensureListed(agent, input.baseUrl);
  const feeAmount = agentFeeUsdc(agent);
  const studio = input.studioOwnerTest === true;

  const chain =
    input.callChain && input.callChain.length > 0
      ? input.callChain.includes(agent.id)
        ? input.callChain
        : [...input.callChain, agent.id]
      : [agent.id];

  // Owner-test only skips the paywall for invoking *this* agent.
  // Peer escalation (Catalog A2A) stays on by default so creators can verify
  // "my agent asks other agents" — set enableA2A:false to disable. Paid peers
  // still spend from the caller agent vault (not free).
  const result = await orchestrateA2ATurn({
    agent,
    userPrompt: input.prompt,
    enablePeers: input.enableA2A !== false,
    history: input.history,
    attachments: input.attachments,
    webSearch: input.webSearch === true,
    answerSession: input.answerSession,
    callChain: chain,
  });
  await bumpInvoke(input.agentId);

  const generation =
    result.ragMode === 'ai_application' ? 'ai_application_answer' : 'vertex_gemini_rag';

  const evidence = recordInvokeEvidence({
    agentId: agent.id,
    agentName: agent.agentName || agent.customRole || agent.role,
    prompt: input.prompt,
    answer: result.answer,
    confidence: result.confidence,
    citations: result.citations || [],
    toolsUsed: result.toolsUsed || [],
    ragMode: result.ragMode,
    generation,
    engineId: agent.vertexEngineId || null,
    dataStoreId: agent.vertexDataStoreId || null,
    websiteUri: agent.websiteUri,
    dataSourceType: agent.dataSourceType,
    aiAppType: agent.aiAppType,
    gcsUri: agent.gcsUri,
    googleDriveFolderId: agent.googleDriveFolderId,
    relatedQuestions: result.relatedQuestions || [],
    retrievalError: (result as any).retrievalError,
    a2a: {
      catalogUsed: result.catalogUsed,
      planningNote: result.planningNote,
      peerHops: result.peerHops,
      spendTier: result.spendTier,
    },
    studioOwnerTest: studio,
  });

  serverLog('info', 'invoke', `agent=${agent.id} mode=${result.ragMode}`, {
    evidenceId: evidence.id,
    citations: evidence.citations.length,
    hosts: evidence.referencedHosts,
    tools: evidence.toolsUsed,
  });

  const body: InvokeSuccess & { evidenceId?: string; referencedHosts?: string[]; referencedUrls?: string[] } = {
    status: 'success',
    answer: result.answer,
    data: result.answer,
    confidence: result.confidence,
    citations: result.citations,
    ragMode: result.ragMode,
    paymentLogs,
    network: networkLabel(),
    feeUsdc: studio ? 0 : feeAmount,
    paywallSkipped: studio || paymentLogs.some((l) => /paywall skipped|gateway settled/i.test(l)),
    payShCatalogId: listing?.catalogId,
    generation,
    engineId: agent.vertexEngineId || null,
    dataStoreId: agent.vertexDataStoreId || null,
    session: result.session || null,
    relatedQuestions: result.relatedQuestions || [],
    toolsUsed: result.toolsUsed || [],
    evidenceId: evidence.id,
    referencedHosts: evidence.referencedHosts,
    referencedUrls: evidence.referencedUrls,
    a2a: {
      catalogUsed: result.catalogUsed,
      planningNote: result.planningNote,
      peerHops: result.peerHops,
      spendTier: result.spendTier,
    },
  };
  return { httpStatus: 200, body };
}
