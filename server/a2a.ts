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
import { gatewayInvokeUrl, payCurl, plainPostJson } from './pay-client.js';
import { payPeerFromAgentVault } from './pay-payer.js';
import { checkCallChain, checkSpendAllowance } from './spend-policy.js';

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
  /** free_self | free_peers | paid_peers | self_best_effort_after_pay_fail | ... */
  spendTier?: string;
  session?: string;
  relatedQuestions?: string[];
  toolsUsed?: string[];
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
    agent.customRole,
    agent.customInstructions
  );
}

function agentRuntimeMode(agent: AgentRecord): 'specialized' | 'autonomous' {
  return agent.runtimeMode === 'autonomous' ? 'autonomous' : 'specialized';
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
  // Engine Answer (incl. greetings) that looks fine — do not escalate to peers
  if (
    rag.mode === 'ai_application' &&
    (rag.confidence || 0) >= 0.7 &&
    !looksUncertain(rag.answer)
  ) {
    return true;
  }
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
- If this is the paid band and your own draft confidence is low (<0.45) or clearly insufficient, pick ONE cheapest relevant peer (do not return empty just to save money).
- If your draft already answers well, return {"calls":[]}.

User message:
"""${userPrompt}"""
${selfHint}

Catalog peers in this band (${band}):
${catalogBrief}

Return ONLY JSON:
{"calls":[{"agentId":"...","question":"...","reason":"..."}]}
Max ${MAX_PEER_CALLS} calls. Empty calls is OK when self draft is sufficient.`,
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

  // Heuristic: keyword / role mismatch; paid band also escalates when self RAG was weak
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
  const selfWeak =
    typeof opts?.selfConfidence === 'number' && opts.selfConfidence < 0.45;

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

  // Free band: if still empty but self was weak, try one cheapest different-role free peer
  if (calls.length === 0 && band === 'free' && ranked.length > 0 && (wantsHelp || selfWeak)) {
    const p = ranked.find((x) => x.role !== caller.role) || ranked[0];
    calls.push({
      agentId: p.agentId,
      question: `From peer agent ${caller.id}: please help with — ${userPrompt}`,
      reason: 'free-peer consult after weak self answer',
    });
  }

  // Paid band: A2A was explicitly enabled — if self was weak, spend on one cheapest peer
  // (toggle OFF skips this entire path; toggle ON means vault may pay).
  if (calls.length === 0 && band === 'paid' && ranked.length > 0 && selfWeak) {
    const p = ranked.find((x) => x.role !== caller.role) || ranked[0];
    calls.push({
      agentId: p.agentId,
      question: `From peer agent ${caller.id}: please help with — ${userPrompt}`,
      reason: `paid-peer consult after weak self (fee=${p.feeUsdc} USDC)`,
    });
  }

  return {
    calls,
    note: `planned via heuristic (${band} band, cost-aware)`,
  };
}

/** Invoke peer; fee>0 pays from the caller's agent vault (devnet 90/10 split) or pay CLI (localnet). */
export async function paidPeerInvoke(
  caller: AgentRecord,
  targetId: string,
  question: string,
  opts?: { callChain?: string[] }
): Promise<A2APeerHop> {
  const target = await getAgent(targetId);
  const listing = getCatalogEntry(targetId);
  const toName = listing?.name || target?.agentName || targetId;
  const callChain = opts?.callChain?.length ? opts.callChain : [caller.id];

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

  // --- Free peer: in-process RAG (same Studio) ---
  if (fee <= 0) {
    const rag = await generateGroundedAnswer({
      systemPrompt: liveSystemPrompt(target),
      userPrompt: `[A2A free query from agent ${caller.id}]\n${question}`,
      dataStoreId: target.vertexDataStoreId,
      engineId: target.vertexEngineId,
      agentId: target.id,
      geminiApiKey: config.geminiApiKey || undefined,
      runtimeMode: agentRuntimeMode(target),
    });
    await bumpInvoke(targetId);
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: 0,
      paymentProof: 'FREE_TIER',
      paymentVerified: true,
      answer: rag.answer,
      catalogId: listing.catalogId,
      tier: 'free',
    };
  }

  // --- Paid peer: policy + loop guards first (all paid paths) ---
  const chainCheck = checkCallChain(callChain, targetId);
  if (!chainCheck.allowed) {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: '',
      paymentVerified: false,
      error: chainCheck.reason,
      catalogId: listing.catalogId,
      tier,
    };
  }
  const spendCheck = await checkSpendAllowance(caller, fee);
  if (!spendCheck.allowed) {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: '',
      paymentVerified: false,
      error: `Spend policy blocked payment: ${spendCheck.reason}`,
      catalogId: listing.catalogId,
      tier,
    };
  }

  // --- Paid peer on devnet: buyer vault pays 90/10 split, then origin invoke with proof ---
  if (config.paymentNetwork === 'devnet') {
    const payment = await payPeerFromAgentVault(caller, target.publicKey, fee);
    if (!payment.ok || !payment.signature) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof: '',
        paymentVerified: false,
        error: payment.error || 'A2A vault payment failed',
        catalogId: listing.catalogId,
        tier,
      };
    }

    const originUrl =
      listing.originInvokeUrl ||
      `${(config.appUrl || 'http://localhost:3000').replace(/\/$/, '')}/api/agents/${targetId}/invoke`;
    const res = await plainPostJson(
      originUrl,
      {
        prompt: `[A2A paid query from agent ${caller.id}]\n${question}`,
        enableA2A: false,
      },
      {
        'X-Payment-Proof': payment.signature,
        'X-A2A-From': caller.id,
        'X-A2A-Chain': [...callChain, targetId].join(','),
      }
    );
    if (!res.ok) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof: payment.signature,
        paymentVerified: false,
        error:
          res.json?.message || res.error || `origin invoke with proof failed (${res.status})`,
        catalogId: listing.catalogId,
        tier,
      };
    }
    const answer = res.json?.answer || res.json?.data || res.body;
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: payment.signature,
      paymentVerified: true,
      answer: String(answer),
      catalogId: listing.catalogId,
      tier,
    };
  }

  // --- Paid peer on localnet: pay.sh sandbox gateway via pay CLI ---
  if (config.usePayGateway) {
    const url = listing.invokeUrl || gatewayInvokeUrl(targetId);
    // Cloud Run / production cannot reach loopback pay gateway.
    if (
      config.isProd &&
      /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)
    ) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof: '',
        paymentVerified: false,
        error:
          'PAY_GATEWAY_URL points to localhost in production — paid A2A unavailable until a public pay gateway URL is configured',
        catalogId: listing.catalogId,
        tier,
      };
    }
    const paid = await payCurl({
      method: 'POST',
      url,
      body: {
        prompt: `[A2A paid query from agent ${caller.id}]\n${question}`,
        enableA2A: false,
      },
      // localnet → --sandbox
    });
    if (!paid.ok) {
      return {
        fromAgentId: caller.id,
        toAgentId: targetId,
        toName,
        question,
        feeUsdc: fee,
        paymentProof: '',
        paymentVerified: false,
        error: paid.error || `pay.sh gateway call failed (${paid.status})`,
        catalogId: listing.catalogId,
        tier,
      };
    }
    const answer =
      paid.json?.answer || paid.json?.data || (typeof paid.body === 'string' ? paid.body : '');
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: 'PAY_SH_GATEWAY',
      paymentVerified: true,
      answer: String(answer),
      catalogId: listing.catalogId,
      tier,
    };
  }

  // --- Legacy Lab path (explicit opt-in) ---
  if (!config.allowLegacySandboxProof) {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: '',
      paymentVerified: false,
      error:
        'Paid A2A requires USE_PAY_GATEWAY=true (pay.sh) or ALLOW_LEGACY_SANDBOX_PROOF=true (Lab only)',
      catalogId: listing.catalogId,
      tier,
    };
  }

  if (config.paymentNetwork !== 'localnet' && !config.allowPaymentBypass) {
    return {
      fromAgentId: caller.id,
      toAgentId: targetId,
      toName,
      question,
      feeUsdc: fee,
      paymentProof: '',
      paymentVerified: false,
      error:
        'Devnet/product mode: auto A2A peer USDC payment requires pay.sh gateway. Enable USE_PAY_GATEWAY or Sandbox + ALLOW_LEGACY_SANDBOX_PROOF.',
      catalogId: listing.catalogId,
      tier,
    };
  }

  const paymentProof = `PAYSH_A2A_${caller.id.slice(0, 8)}_${target.id.slice(0, 8)}_${Date.now()}`;
  const audit = await verifyPayment(paymentProof, target.publicKey, fee);
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

  const rag = await generateGroundedAnswer({
    systemPrompt: liveSystemPrompt(target),
    userPrompt: `[A2A ${tier} query from agent ${caller.id}]\n${question}`,
    dataStoreId: target.vertexDataStoreId,
    engineId: target.vertexEngineId,
    agentId: target.id,
    geminiApiKey: config.geminiApiKey || undefined,
    runtimeMode: agentRuntimeMode(target),
  });
  await bumpInvoke(targetId);

  return {
    fromAgentId: caller.id,
    toAgentId: targetId,
    toName,
    question,
    feeUsdc: fee,
    paymentProof,
    paymentVerified: true,
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
  history?: { role: 'user' | 'model'; text: string }[];
  attachments?: { name: string; mimeType: string; dataBase64: string }[];
  webSearch?: boolean;
  answerSession?: string;
  /** Upstream A2A call chain (loop prevention). Defaults to [agent.id]. */
  callChain?: string[];
}): Promise<A2AOrchestrationResult> {
  const enablePeers = opts.enablePeers === true; // default OFF unless explicitly enabled
  const callChain =
    opts.callChain && opts.callChain.length > 0 ? opts.callChain : [opts.agent.id];
  const peers = enablePeers ? catalogForPeers(opts.agent.id) : [];
  const { free: freePeers, paid: paidPeers } = splitPeersByFee(peers);
  const peerHops: A2APeerHop[] = [];
  const notes: string[] = [];
  let spendTier = 'free_self';

  // Studio / direct chat: specialized → Engine Answer; autonomous → Gemini + retrieve.
  if (!enablePeers) {
    const rag = await generateGroundedAnswer({
      systemPrompt: `${liveSystemPrompt(opts.agent)}

[RUNTIME]
- Answer the human directly. Use Drive/Vertex grounded context when useful.
- Keep continuity with prior turns in this conversation when provided.
- Network: ${networkLabel()}
`,
      userPrompt: opts.userPrompt,
      dataStoreId: opts.agent.vertexDataStoreId,
      engineId: opts.agent.vertexEngineId,
      agentId: opts.agent.id,
      geminiApiKey: config.geminiApiKey || undefined,
      runtimeMode: agentRuntimeMode(opts.agent),
      history: opts.history,
      attachments: opts.attachments,
      webSearch: opts.webSearch === true,
      answerSession: opts.answerSession,
    });
    return {
      answer: rag.answer,
      confidence: rag.confidence,
      citations: rag.citations,
      ragMode: rag.mode,
      peerHops: [],
      catalogUsed: false,
      planningNote: `AI App answer path mode=${rag.mode} backend=${rag.generationBackend || 'n/a'} engine=${rag.engineId || opts.agent.vertexEngineId || 'none'} tools=${(rag.toolsUsed || []).join(',') || 'none'}`,
      spendTier: 'free_self',
      session: rag.session,
      relatedQuestions: rag.relatedQuestions,
      toolsUsed: rag.toolsUsed,
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
    engineId: opts.agent.vertexEngineId,
    agentId: opts.agent.id,
    geminiApiKey: config.geminiApiKey || undefined,
      runtimeMode: agentRuntimeMode(opts.agent),
  });

  if (isSelfSufficient(selfRag, opts.userPrompt)) {
    notes.push('self RAG sufficient — skipped all peer spend');
    if (selfRag.generationBackend === 'extractive' && selfRag.retrievalError) {
      console.warn('[a2a] retrieval failed (not shown to user):', selfRag.retrievalError);
    }
    return {
      answer: selfRag.answer,
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
      const hop = await paidPeerInvoke(opts.agent, call.agentId, call.question, { callChain });
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
      const hop = await paidPeerInvoke(opts.agent, call.agentId, call.question, { callChain });
      peerHops.push(hop);
    }
    if (peerHops.some((h) => h.tier === 'paid' && !h.error)) {
      spendTier = 'paid_peers';
    }
  }

  const usefulPeerHops = peerHops.filter(
    (h) => !h.error && h.answer && !looksUncertain(String(h.answer))
  );
  const paidFailures = peerHops.filter((h) => h.tier === 'paid' && !!h.error);
  const anyPeerFailures = peerHops.filter((h) => !!h.error);
  const peerPayFailed = paidFailures.length > 0 && usefulPeerHops.length === 0;
  const peersUseless = peerHops.length > 0 && usefulPeerHops.length === 0;

  if (peerPayFailed) {
    notes.push(
      `paid peer payment failed (${paidFailures.length}) — forcing self best-effort answer`
    );
    spendTier = 'self_best_effort_after_pay_fail';
    for (const h of paidFailures) {
      console.warn('[a2a] paid peer failed (hidden from user):', h.toName, h.error);
    }
  } else if (peersUseless) {
    notes.push('peer hops produced no usable answers — forcing self best-effort');
    spendTier = 'self_best_effort_after_peer_miss';
  }

  const peerContext =
    usefulPeerHops.length > 0
      ? `\n\n[A2A PEER INTEL — ${spendTier}]\n` +
        usefulPeerHops
          .map(
            (h) =>
              `• ${h.toName} (${h.toAgentId}) tier=${h.tier} fee=${h.feeUsdc} USDC\nQ: ${h.question}\nA: ${h.answer}`
          )
          .join('\n---\n') +
        `\n[/A2A PEER INTEL]\n`
      : '';

  // Payment / peer failures must never become the user-facing answer.
  // Always synthesize a helpful self answer (Gemini-style), optionally enriched by useful peers only.
  const forceBestEffort = peerPayFailed || peersUseless || usefulPeerHops.length === 0;
  const a2aSystem = `${liveSystemPrompt(opts.agent)}

[A2A RUNTIME — BEST EFFORT]
- Answer the human completely and helpfully in their language.
- Prefer useful peer intel when present; otherwise rely on your own RAG / general knowledge.
- NEVER say you cannot answer because payment failed, a peer is unavailable, catalog is empty, or A2A failed.
- NEVER return JSON status objects, payment errors, gateway errors, or "I don't know / 모릅니다" as the whole reply.
- If specialist peer data is missing, still give the best practical answer you can (steps, caveats, what to check next).
- Network: ${networkLabel()}
`;

  const rag = await generateGroundedAnswer({
    systemPrompt: a2aSystem,
    userPrompt: `${peerContext}\n[YOUR FREE DRAFT]\n${selfRag.answer}\n[/YOUR FREE DRAFT]\n\nHuman: ${opts.userPrompt}`,
    dataStoreId: opts.agent.vertexDataStoreId,
    engineId: opts.agent.vertexEngineId,
    agentId: opts.agent.id,
    geminiApiKey: config.geminiApiKey || undefined,
      runtimeMode: agentRuntimeMode(opts.agent),
  });

  let answer = rag.answer;
  let confidence = Math.max(rag.confidence, selfRag.confidence);
  let citations = [...(selfRag.citations || []), ...(rag.citations || [])];
  let ragMode = rag.mode;

  if (rag.generationBackend === 'extractive' && rag.retrievalError) {
    console.warn('[a2a] retrieval failed (not shown to user):', rag.retrievalError);
  }

  // If synthesis still looks like a dead-end (or payment-flavored), do one more self-only pass.
  const answerLooksDead =
    looksUncertain(answer) ||
    /결제\s*실패|payment\s*fail|pay\.sh|402|gateway|피어.*(없|실패)|A2A.*(실패|불가)/i.test(
      answer
    );

  if (forceBestEffort && answerLooksDead) {
    notes.push('synthesis weak after peer miss — second self-only best-effort pass');
    const solo = await generateGroundedAnswer({
      systemPrompt: `${liveSystemPrompt(opts.agent)}

[RUNTIME — SELF BEST EFFORT]
- Peer consultation was unavailable or unpaid. You MUST still answer the user now.
- Do not mention payment, peers, catalog, or A2A failures.
- Write a natural, useful reply in the user's language (like a normal Gemini assistant).
`,
      userPrompt: opts.userPrompt,
      dataStoreId: opts.agent.vertexDataStoreId,
      engineId: opts.agent.vertexEngineId,
      agentId: opts.agent.id,
      geminiApiKey: config.geminiApiKey || undefined,
      runtimeMode: agentRuntimeMode(opts.agent),
    });
    if (solo.answer && !looksUncertain(solo.answer)) {
      answer = solo.answer;
      confidence = Math.max(confidence, solo.confidence);
      citations = [...citations, ...(solo.citations || [])];
      ragMode = solo.mode;
      spendTier = 'self_best_effort_solo';
    } else if (selfRag.answer && selfRag.answer.trim().length >= String(answer || '').trim().length) {
      // Last resort: return the earlier free draft rather than a payment/uncertain stub.
      answer = selfRag.answer;
      confidence = Math.max(confidence, selfRag.confidence);
      citations = selfRag.citations || citations;
      ragMode = selfRag.mode;
      spendTier = 'self_draft_fallback';
    }
  }

  if (anyPeerFailures.length > 0) {
    // Keep failures in planning notes / logs only — never append to chat text.
    notes.push(
      `peer failures suppressed from UI: ${anyPeerFailures
        .map((h) => `${h.toName}:${String(h.error).slice(0, 80)}`)
        .join('; ')}`
    );
  }

  return {
    answer,
    confidence,
    citations,
    ragMode,
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
