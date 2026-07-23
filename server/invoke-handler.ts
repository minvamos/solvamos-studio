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

export type InvokeInput = {
  agentId: string;
  prompt: string;
  enableA2A?: boolean;
  /** When true, peers default off unless enableA2A */
  studioOwnerTest?: boolean;
  baseUrl?: string;
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
  if (typeof agent.fee === 'number') return agent.fee;
  if (typeof agent.perCallPriceUsdc === 'number') return agent.perCallPriceUsdc;
  return config.defaultAgentFeeUsdc;
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

  const result = await orchestrateA2ATurn({
    agent,
    userPrompt: input.prompt,
    enablePeers: studio ? input.enableA2A === true : input.enableA2A !== false,
  });
  await bumpInvoke(input.agentId);

  const body: InvokeSuccess = {
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
    generation: 'vertex_gemini_rag',
    a2a: {
      catalogUsed: result.catalogUsed,
      planningNote: result.planningNote,
      peerHops: result.peerHops,
      spendTier: result.spendTier,
    },
  };
  return { httpStatus: 200, body };
}
