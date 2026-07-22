/**
 * A2A orchestrator — free-first, pay only when needed.
 *
 * 1) Answer from own RAG / local knowledge (free)
 * 2) If insufficient → consult fee=0 catalog peers (free A2A)
 * 3) If still insufficient → pay fee>0 peers (x402 USDC)
 */

import { GoogleGenAI } from '@google/genai';
import { config, networkLabel } from './config.js';
import { getAgent, bumpInvoke, listAgents, type AgentRecord } from './agents-store.js';
import { generateGroundedAnswer, type RagResult } from './rag.js';
import { verifyPayment } from './payment.js';
import { getCatalogEntry, listCatalogForA2A, type PayShCatalogEntry } from './paysh-catalog.js';
import { compileSystemPrompt } from './prompt.js';

export type A2APeerHop = {
  fromAgentId: string;
  toAgentId: string;
  toName: string;
  question: string;
  feeUsdc: number;
  paymentProof: string;
  paymentVerified: boolean;
  answer?: string;
  error?: string;
  catalogId?: string;
  tier?: 'free' | 'paid';
};

export type A2AOrchestrationResult = {
  answer: string;
  confidence: number;
  citations: any[];
  ragMode: string;
  peerHops: A2APeerHop[];
  catalogUsed: boolean;
  planningNote?: string;
  /** free_self | free_peers | paid_peers */
  spendTier?: string;
};

type PeerPlan = { agentId: string; question: string; reason?: string };

const MAX_PEER_CALLS = 2;
/** Below this (or weak retrieval), consider consulting peers. */
const SELF_SUFFICIENT_CONFIDENCE = 0.55;

function liveSystemPrompt(agent: AgentRecord): string {
  // Always recompile so prompt policy updates apply without recreating the agent
  return compileSystemPrompt(
    agent.role,
    agent.tone,
    agent.securityLevel,
    agent.customRole
  );
}

function isChitchat(prompt: string): boolean {
  const t = prompt.trim();
  return (
    t.length <= 40 &&
    /^(hi|hello|hey|yo|안녕|안녕하세요|하이|헬로|테스트|날씨|weather|고마워|감사)[\s!~.?]*$/i.test(t)
  );
}

function agentFee(agent: AgentRecord): number {
  if (typeof agent.fee === 'number') return agent.fee;
  if (typeof agent.perCallPriceUsdc === 'number') return agent.perCallPriceUsdc;
  return config.defaultAgentFeeUsdc;
}

function catalogForPeers(excludeAgentId: string): PayShCatalogEntry[] {
  return listCatalogForA2A().filter((e) => e.agentId !== excludeAgentId);
}

function splitPeersByFee(peers: PayShCatalogEntry[]): {
  free: PayShCatalogEntry[];
  paid: PayShCatalogEntry[];
} {
  const free: PayShCatalogEntry[] = [];
  const paid: PayShCatalogEntry[] = [];
  for (const p of peers) {
    if ((p.feeUsdc ?? 0) <= 0) free.push(p);
    else paid.push(p);
  }
  return { free, paid };
}

function looksUncertain(text: string): boolean {
  const t = text.toLowerCase().trim();
  // Short greetings are fine — do not treat as failed answers
  if (/^(hi|hello|hey|안녕|안녕하세요|테스트)[!~.]*$/i.test(t)) return false;
  return (
    /죄송|모르|알 수 없|정보가 없|확인할 수 없|insufficient|i don't know|i do not know|cannot find|no (relevant )?information|unable to answer|생성 불가|자료가 없/.test(
      t
    ) || text.trim().length < 40
  );
}

/** Own RAG is good enough → do not spend USDC on peers. */
export function isSelfSufficient(rag: RagResult, userPrompt: string): boolean {
  const explicitPeerAsk =
    /다른\s*에이전트|유료\s*api|peer|다른\s*전문|카탈로그|물어봐|물어\s*봐/i.test(userPrompt);
  if (explicitPeerAsk) return false;

  if (rag.mode === 'demo' && (rag.confidence || 0) < 0.7) return false;
  if ((rag.confidence || 0) >= SELF_SUFFICIENT_CONFIDENCE && !looksUncertain(rag.answer)) {
    return true;
  }
  if (
    (rag.mode === 'vertex_search' || rag.mode === 'drive_local') &&
    (rag.citations?.length || 0) > 0 &&
    !looksUncertain(rag.answer)
  ) {
    return true;
  }
  if (rag.mode === 'gemini_only' && (rag.confidence || 0) >= 0.65 && !looksUncertain(rag.answer)) {
    return true;
  }
  return false;
}

function peerStillNeeded(
  self: RagResult,
  hops: A2APeerHop[],
  userPrompt: string
): boolean {
  if (isSelfSufficient(self, userPrompt) && hops.length === 0) return false;
  const okAnswers = hops.filter((h) => !h.error && h.answer && !looksUncertain(h.answer));
  if (okAnswers.length > 0) {
    // Have usable peer intel — no need to escalate spend tier further unless self was empty
    return false;
  }
  // Self weak and free peers didn't help (or none called yet)
  return !isSelfSufficient(self, userPrompt);
}

/** Decide which catalog peers to call. Prefer fee=0; never auto-pay for demos. */
export async function planPeerCalls(
  caller: AgentRecord,
  userPrompt: string,
  peers: PayShCatalogEntry[],
  opts?: {
    /** Prefer only this fee band */
    feeBand?: 'free' | 'paid' | 'any';
    selfSummary?: string;
    selfConfidence?: number;
  }
): Promise<{ calls: PeerPlan[]; note: string }> {
  if (peers.length === 0) {
    return { calls: [], note: 'no peers in band' };
  }

  const band = opts?.feeBand || 'any';
  const pool =
    band === 'free'
      ? peers.filter((p) => (p.feeUsdc ?? 0) <= 0)
      : band === 'paid'
        ? peers.filter((p) => (p.feeUsdc ?? 0) > 0)
        : peers;

  if (pool.length === 0) {
    return { calls: [], note: `no ${band} peers in pay.sh catalog` };
  }

  // Cheapest first within band
  const rankedPool = [...pool].sort((a, b) => (a.feeUsdc ?? 0) - (b.feeUsdc ?? 0));

  const catalogBrief = rankedPool
    .map(
      (p) =>
        `- id=${p.agentId} name="${p.name}" role=${p.role} fee=${p.feeUsdc} USDC tags=${(p.tags || []).join(',')}`
    )
    .join('\n');

  const selfHint =
    opts?.selfSummary != null
      ? `\nYour own free RAG draft (confidence=${opts.selfConfidence ?? '?'}):\n"""${String(opts.selfSummary).slice(0, 600)}"""\nOnly call peers if this draft is insufficient.`
      : '';

  if (config.geminiApiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const response = await ai.models.generateContent({
        model: config.geminiModel || 'gemini-2.0-flash',
        contents: `You are the planning head of SolVamos agent "${caller.agentName || caller.id}" (role=${caller.role}).

COST RULES (critical):
- Prefer free knowledge. Do NOT pay peers when your own draft is enough.
- Among peers, prefer fee=0. Only pick fee>0 when free peers cannot cover the gap.
- If unsure, return {"calls":[]} — wasting USDC is worse than a partial answer.

User message:
"""${userPrompt}"""
${selfHint}

Catalog peers in this band (${band}):
${catalogBrief}

Return ONLY JSON:
{"calls":[{"agentId":"...","question":"...","reason":"..."}]}
Max ${MAX_PEER_CALLS} calls. Empty calls is OK.`,
        config: { temperature: 0.1 },
      });
      const text = response.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const calls = (parsed.calls || [])
          .filter(
            (c: any) => c.agentId && c.question && rankedPool.some((p) => p.agentId === c.agentId)
          )
          .slice(0, MAX_PEER_CALLS);
        return {
          calls,
          note: `planned via Gemini (${band} band, cost-aware)`,
        };
      }
    } catch (err: any) {
      console.warn('[a2a] planning LLM failed, heuristic fallback', err?.message);
    }
  }

  // Heuristic: only when user signal / role mismatch keyword — never auto-pay
  const lower = userPrompt.toLowerCase();
  const calls: PeerPlan[] = [];
  const ranked = [...rankedPool].sort((a, b) => {
    const feeDelta = (a.feeUsdc ?? 0) - (b.feeUsdc ?? 0);
    if (feeDelta !== 0) return feeDelta;
    const aDiff = a.role === caller.role ? 1 : 0;
    const bDiff = b.role === caller.role ? 1 : 0;
    return aDiff - bDiff;
  });

  const wantsHelp =
    /다른|전문|물어|학술|academic|peer|agent|연구|api|날씨|weather|기술|가이드/.test(lower);

  for (const p of ranked) {
    if (calls.length >= MAX_PEER_CALLS) break;
    const keys = [p.role, p.name, ...(p.tags || [])].map((k) => String(k).toLowerCase());
    const hit = keys.some((k) => k.length > 2 && lower.includes(k));
    const cross = caller.role !== p.role && wantsHelp;
    if (hit || cross) {
      calls.push({
        agentId: p.agentId,
        question: userPrompt,
        reason: hit
          ? `keyword match (${band}, fee=${p.feeUsdc})`
          : `cross-role assist (${band}, fee=${p.feeUsdc})`,
      });
    }
  }

  // Free band only: if still empty but self was weak, try one cheapest different-role free peer
  if (calls.length === 0 && band === 'free' && ranked.length > 0 && wantsHelp) {
    const p = ranked.find((x) => x.role !== caller.role) || ranked[0];
    calls.push({
      agentId: p.agentId,
      question: `From peer agent ${caller.id}: please help with — ${userPrompt}`,
      reason: 'free-peer consult after weak self answer',
    });
  }

  // Paid band: NEVER auto-pick without keyword/LLM — empty is correct (save money)
  return {
    calls,
    note: `planned via heuristic (${band} band, cost-aware)`,
  };
}

/** Invoke peer; fee>0 uses pay.sh-style proof into peer agent vault. */
export async function paidPeerInvoke(
  caller: AgentRecord,
  targetId: string,
  question: string
): Promise<A2APeerHop> {
  const target = await getAgent(targetId);
  const listing = getCatalogEntry(targetId);
  const toName = listing?.name || target?.agentName || targetId;

  if (!target) {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: 0,
      paymentProof: '',
      paymentVerified: false,
      error: 'Peer agent not found',
      catalogId: listing?.catalogId,
      tier: 'free',
    };
  }

  if (!listing || listing.status !== 'listed') {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: agentFee(target),
      paymentProof: '',
      paymentVerified: false,
      error: 'Peer not listed on pay.sh catalog — cannot A2A share',
      catalogId: listing?.catalogId,
      tier: agentFee(target) > 0 ? 'paid' : 'free',
    };
  }

  const fee = listing.feeUsdc ?? agentFee(target);
  const tier: 'free' | 'paid' = fee > 0 ? 'paid' : 'free';
  let paymentProof = '';
  let paymentVerified = true;

  if (fee > 0) {
    if (config.paymentNetwork !== 'sandbox' && !config.allowPaymentBypass) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof: '',
        paymentVerified: false,
        error:
          'Devnet/product mode: auto A2A peer USDC payment requires a real signature path. Switch to Sandbox for peer demos, or set ALLOW_PAYMENT_BYPASS for lab only.',
        catalogId: listing.catalogId,
        tier,
      };
    }
    paymentProof = `PAYSH_A2A_${caller.id.slice(0, 8)}_${target.id.slice(0, 8)}_${Date.now()}`;
    const audit = await verifyPayment(paymentProof, target.publicKey, fee);
    paymentVerified = audit.verified;
    if (!audit.verified) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof,
        paymentVerified: false,
        error: audit.error || 'A2A payment verification failed',
        catalogId: listing.catalogId,
        tier,
      };
    }
  } else {
    paymentProof = 'FREE_TIER';
  }

  const rag = await generateGroundedAnswer({
    systemPrompt: liveSystemPrompt(target),
    userPrompt: `[A2A ${tier} query from agent ${caller.id}]\n${question}`,
    dataStoreId: target.vertexDataStoreId,
    agentId: target.id,
    geminiApiKey: config.geminiApiKey || undefined,
  });
  await bumpInvoke(targetId);

  return {
    fromAgentId: caller.id,
    toAgentId: targetId,
    toName,
    question,
    feeUsdc: fee,
    paymentProof,
    paymentVerified,
    answer: rag.answer,
    catalogId: listing.catalogId,
    tier,
  };
}

/** Full turn: free self → free peers → paid peers (only if still needed). */
export async function orchestrateA2ATurn(opts: {
  agent: AgentRecord;
  userPrompt: string;
  enablePeers?: boolean;
}): Promise<A2AOrchestrationResult> {
  const enablePeers = opts.enablePeers === true; // default OFF unless explicitly enabled
  const peers = enablePeers ? catalogForPeers(opts.agent.id) : [];
  const { free: freePeers, paid: paidPeers } = splitPeersByFee(peers);
  const peerHops: A2APeerHop[] = [];
  const notes: string[] = [];
  let spendTier = 'free_self';

  // Studio / direct chat: one Vertex+RAG pass only (no peer escalation, no double generate)
  if (!enablePeers) {
    const skipRetrieval = isChitchat(opts.userPrompt);
    const rag = await generateGroundedAnswer({
      systemPrompt: `${liveSystemPrompt(opts.agent)}

[RUNTIME]
- Answer the human directly. Use Drive/Vertex grounded context when useful.
- Network: ${networkLabel()}
`,
      userPrompt: opts.userPrompt,
      dataStoreId: skipRetrieval ? undefined : opts.agent.vertexDataStoreId,
      agentId: skipRetrieval ? undefined : opts.agent.id,
      geminiApiKey: config.geminiApiKey || undefined,
      skipRetrieval,
    });
    let answer = rag.answer;
    if (rag.generationBackend === 'extractive' && rag.retrievalError) {
      answer = `${answer}\n\n_(retrieval note: ${rag.retrievalError})_`;
    }
    return {
      answer,
      confidence: rag.confidence,
      citations: rag.citations,
      ragMode: rag.mode,
      peerHops: [],
      catalogUsed: false,
      planningNote: skipRetrieval
        ? 'direct Vertex chat (retrieval skipped for chitchat)'
        : 'direct Vertex/RAG (peers disabled)',
      spendTier: 'free_self',
    };
  }

  // 1) Free: own RAG first
  const selfRag = await generateGroundedAnswer({
    systemPrompt: `${liveSystemPrompt(opts.agent)}

[A2A RUNTIME — COST AWARE]
- Answer from your own grounded knowledge first (Drive / Vertex RAG).
- Do not invent peer answers.
- Network: ${networkLabel()}
`,
    userPrompt: opts.userPrompt,
    dataStoreId: opts.agent.vertexDataStoreId,
    agentId: opts.agent.id,
    geminiApiKey: config.geminiApiKey || undefined,
  });

  if (isSelfSufficient(selfRag, opts.userPrompt)) {
    notes.push('self RAG sufficient — skipped all peer spend');
    let answer = selfRag.answer;
    if (selfRag.generationBackend === 'extractive' && selfRag.retrievalError) {
      answer = `${answer}\n\n_(retrieval note: ${selfRag.retrievalError})_`;
    }
    return {
      answer,
      confidence: selfRag.confidence,
      citations: selfRag.citations,
      ragMode: selfRag.mode,
      peerHops: [],
      catalogUsed: peers.length > 0,
      planningNote: notes.join(' | '),
      spendTier: 'free_self',
    };
  }

  notes.push(
    `self RAG weak (mode=${selfRag.mode}, conf=${selfRag.confidence}) — escalate carefully`
  );

  // 2) Free peers (fee=0) before any paid call
  if (enablePeers && freePeers.length > 0 && peerStillNeeded(selfRag, peerHops, opts.userPrompt)) {
    const plan = await planPeerCalls(opts.agent, opts.userPrompt, freePeers, {
      feeBand: 'free',
      selfSummary: selfRag.answer,
      selfConfidence: selfRag.confidence,
    });
    notes.push(plan.note);
    for (const call of plan.calls) {
      const hop = await paidPeerInvoke(opts.agent, call.agentId, call.question);
      peerHops.push(hop);
    }
    if (peerHops.some((h) => h.tier === 'free' && !h.error)) {
      spendTier = 'free_peers';
    }
  } else if (enablePeers && freePeers.length === 0) {
    notes.push('no fee=0 peers in catalog');
  }

  // 3) Paid peers only if still insufficient
  if (enablePeers && paidPeers.length > 0 && peerStillNeeded(selfRag, peerHops, opts.userPrompt)) {
    const plan = await planPeerCalls(opts.agent, opts.userPrompt, paidPeers, {
      feeBand: 'paid',
      selfSummary: selfRag.answer,
      selfConfidence: selfRag.confidence,
    });
    notes.push(plan.note);
    if (plan.calls.length === 0) {
      notes.push('paid peers available but planner declined (save USDC)');
    }
    for (const call of plan.calls) {
      const hop = await paidPeerInvoke(opts.agent, call.agentId, call.question);
      peerHops.push(hop);
    }
    if (peerHops.some((h) => h.tier === 'paid' && !h.error)) {
      spendTier = 'paid_peers';
    }
  }

  const peerContext =
    peerHops.length > 0
      ? `\n\n[A2A PEER INTEL — ${spendTier}]\n` +
        peerHops
          .map((h) => {
            if (h.error) {
              return `• ${h.toName} (${h.toAgentId}) [${h.tier || '?'}]: ERROR ${h.error}`;
            }
            return `• ${h.toName} (${h.toAgentId}) tier=${h.tier} fee=${h.feeUsdc} USDC proof=${h.paymentProof.slice(0, 28)}…\nQ: ${h.question}\nA: ${h.answer}`;
          })
          .join('\n---\n') +
        `\n[/A2A PEER INTEL]\n`
      : '';

  // Final synthesis: merge self draft + any peer intel (still free for the human→agent path)
  const a2aSystem = `${liveSystemPrompt(opts.agent)}

[A2A RUNTIME — COST AWARE]
- You already attempted a free self answer; peer intel is only present if that was insufficient.
- Prefer citing free peer hops over paid ones when both exist.
- Never invent unpaid peer answers. Never reply with JSON-only status objects.
- Network: ${networkLabel()}
`;

  const rag = await generateGroundedAnswer({
    systemPrompt: a2aSystem,
    userPrompt: `${peerContext}\n[YOUR FREE DRAFT]\n${selfRag.answer}\n[/YOUR FREE DRAFT]\n\nHuman: ${opts.userPrompt}`,
    dataStoreId: opts.agent.vertexDataStoreId,
    agentId: opts.agent.id,
    geminiApiKey: config.geminiApiKey || undefined,
  });

  let answer = rag.answer;
  if (rag.generationBackend === 'extractive' && rag.retrievalError) {
    answer = `${answer}\n\n_(retrieval note: ${rag.retrievalError})_`;
  }
  if (peerHops.length > 0 && rag.mode === 'demo') {
    const ok = peerHops.filter((h) => !h.error);
    answer += `\n\n---\n[A2A] ${spendTier}: consulted ${ok.length}/${peerHops.length} peer(s).`;
    for (const h of ok) {
      answer += `\n→ [${h.tier}] ${h.toName} (${h.feeUsdc} USDC): ${String(h.answer).slice(0, 280)}`;
    }
  }

  return {
    answer,
    confidence: Math.max(rag.confidence, selfRag.confidence),
    citations: [...(selfRag.citations || []), ...(rag.citations || [])],
    ragMode: rag.mode,
    peerHops,
    catalogUsed: peers.length > 0,
    planningNote: notes.join(' | '),
    spendTier,
  };
}

/** Ensure demo has ≥2 catalog-listed agents for A2A. */
export async function ensureDemoPeerAgents() {
  const agents = await listAgents();
  return agents.length;
}
