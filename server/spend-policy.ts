/**
 * A2A spend policy — per-call cap + daily budget + loop prevention.
 * Checked BEFORE a buyer agent pays a peer (server/a2a.ts paid path).
 *
 * Daily aggregation failures retry then fail-closed (never treat as spent=0).
 */

import { prisma } from './db.js';
import type { AgentRecord } from './agents-store.js';

/** Max A2A hop depth (0 = human-initiated call, 1 = first peer hop, ...). */
export const MAX_A2A_DEPTH = Number(process.env.A2A_MAX_DEPTH || 2);

const DEFAULT_MAX_SPEND_PER_CALL_USDC = Number(
  process.env.A2A_MAX_SPEND_PER_CALL_USDC || 0.05
);
const DEFAULT_DAILY_BUDGET_USDC = Number(process.env.A2A_DAILY_BUDGET_USDC || 1);
const SPEND_AGG_RETRIES = Math.max(1, Number(process.env.A2A_SPEND_AGG_RETRIES || 3));

export type SpendCheckResult = {
  allowed: boolean;
  reason?: string;
  perCallLimitUsdc: number;
  dailyBudgetUsdc: number;
  spentTodayUsdc: number;
};

/** UTC day start for daily budget aggregation. */
function utcDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sum of successful A2A payments made BY this agent today (UTC). Retries then throws. */
export async function spentTodayUsdc(payerAgentId: string): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SPEND_AGG_RETRIES; attempt++) {
    try {
      const agg = await prisma.paymentSettlement.aggregate({
        _sum: { amountUsdc: true },
        where: {
          payerAgentId,
          status: 'success',
          createdAt: { gte: utcDayStart() },
        },
      });
      return agg._sum.amountUsdc || 0;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[spend-policy] daily aggregation failed attempt=${attempt}/${SPEND_AGG_RETRIES}:`,
        (err as any)?.message || err
      );
      if (attempt < SPEND_AGG_RETRIES) await sleep(80 * attempt);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String((lastErr as any)?.message || lastErr || 'spend aggregation failed'));
}

/** Validate a prospective A2A payment against the buyer's spend policy. */
export async function checkSpendAllowance(
  buyer: AgentRecord,
  amountUsdc: number
): Promise<SpendCheckResult> {
  const perCallLimitUsdc =
    typeof buyer.maxSpendPerCallUsdc === 'number' && buyer.maxSpendPerCallUsdc >= 0
      ? buyer.maxSpendPerCallUsdc
      : DEFAULT_MAX_SPEND_PER_CALL_USDC;
  const dailyBudgetUsdc =
    typeof buyer.dailyBudgetUsdc === 'number' && buyer.dailyBudgetUsdc >= 0
      ? buyer.dailyBudgetUsdc
      : DEFAULT_DAILY_BUDGET_USDC;

  let spent: number;
  try {
    spent = await spentTodayUsdc(buyer.id);
  } catch (err: any) {
    return {
      allowed: false,
      reason: `spend ledger unavailable after ${SPEND_AGG_RETRIES} retries — A2A payment blocked (${String(err?.message || err).slice(0, 160)})`,
      perCallLimitUsdc,
      dailyBudgetUsdc,
      spentTodayUsdc: -1,
    };
  }

  const base = { perCallLimitUsdc, dailyBudgetUsdc, spentTodayUsdc: spent };

  if (amountUsdc > perCallLimitUsdc) {
    return {
      allowed: false,
      reason: `per-call limit exceeded: fee ${amountUsdc} USDC > limit ${perCallLimitUsdc} USDC`,
      ...base,
    };
  }
  if (spent + amountUsdc > dailyBudgetUsdc) {
    return {
      allowed: false,
      reason: `daily budget exceeded: spent ${spent.toFixed(6)} + fee ${amountUsdc} > budget ${dailyBudgetUsdc} USDC`,
      ...base,
    };
  }
  return { allowed: true, ...base };
}

/**
 * Loop prevention — reject when the target already appears in the call chain
 * (A→B→A) or the chain is deeper than MAX_A2A_DEPTH.
 */
export function checkCallChain(
  callChain: string[],
  targetAgentId: string
): { allowed: boolean; reason?: string } {
  if (callChain.includes(targetAgentId)) {
    return {
      allowed: false,
      reason: `A2A loop blocked: ${[...callChain, targetAgentId].join(' → ')}`,
    };
  }
  if (callChain.length >= MAX_A2A_DEPTH) {
    return {
      allowed: false,
      reason: `A2A max depth ${MAX_A2A_DEPTH} reached (chain: ${callChain.join(' → ')})`,
    };
  }
  return { allowed: true };
}

/** Parse the X-A2A-Chain header ("idA,idB") into a sanitized chain array. */
export function parseCallChainHeader(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,80}$/.test(s))
    .slice(0, 8);
}
