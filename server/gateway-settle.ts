/**
 * Close the gateway → Studio ledger loop for native MPP payments.
 *
 * pay.sh proxies with X-Pay-Internal-Secret only (no receipt inject today).
 * After a paid invoke we either:
 *   1) verify a signature from receipt headers, or
 *   2) scan the agent vault USDC ATA for a recent matching on-chain split TX
 * and record PaymentSettlement only after verifyPayment succeeds.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from './config.js';
import { verifyPayment } from './payment.js';
import { getSettlementBySignature, recordSettlement } from './settlements.js';
import type { AgentRecord } from './agents-store.js';

const SCAN_LIMIT = 16;
const SCAN_MAX_AGE_SEC = 20 * 60;

export type GatewayReceiptHint = {
  signature: string | null;
  amountUsdc: number | null;
  payer: string | null;
  network: string | null;
};

export type GatewaySettleResult = {
  recorded: boolean;
  signature?: string;
  source?: 'header' | 'chain_scan';
  skipped?: string;
  error?: string;
};

function headerAliases(reqHeaders: Record<string, unknown>): GatewayReceiptHint {
  const h = (name: string) => String(reqHeaders[name] || '').trim();
  const signature =
    h('x-payment-signature') ||
    h('x-pay-receipt-id') ||
    h('payment-signature') ||
    h('x-payment-response') ||
    h('payment-response') ||
    null;
  const amountRaw = h('x-payment-amount') || h('payment-amount');
  const amountUsdc = amountRaw ? Number(amountRaw) : null;
  return {
    signature: signature || null,
    amountUsdc: amountUsdc != null && Number.isFinite(amountUsdc) ? amountUsdc : null,
    payer: h('x-payment-payer') || h('payment-payer') || null,
    network: h('x-payment-network') || h('payment-network') || null,
  };
}

export function parseGatewayReceiptHeaders(req: {
  headers: Record<string, unknown>;
}): GatewayReceiptHint {
  return headerAliases(req.headers as Record<string, unknown>);
}

/** Find a verified payment signature for this agent fee (header hint or ATA scan). */
export async function resolveVerifiedGatewayPayment(opts: {
  agentWallet: string;
  feeUsdc: number;
  hint?: GatewayReceiptHint | null;
}): Promise<{ signature: string; source: 'header' | 'chain_scan' } | null> {
  const { agentWallet, feeUsdc, hint } = opts;
  const hintSig = hint?.signature?.trim() || '';

  if (hintSig) {
    if (hint?.amountUsdc != null && hint.amountUsdc > 0) {
      if (hint.amountUsdc < feeUsdc * 0.98 || hint.amountUsdc > feeUsdc * 1.02) {
        console.warn(
          `[gateway-settle] header amount mismatch charged=${hint.amountUsdc} fee=${feeUsdc} — trying verify anyway / chain scan`
        );
      }
    }
    const existing = await getSettlementBySignature(hintSig);
    if (existing?.status === 'success') {
      return { signature: hintSig, source: 'header' };
    }
    const verified = await verifyPayment(hintSig, agentWallet, feeUsdc);
    if (verified.verified) {
      return { signature: hintSig, source: 'header' };
    }
    console.warn(
      `[gateway-settle] header signature failed on-chain verify: ${verified.error || 'unknown'}`
    );
  }

  if (config.paymentNetwork === 'localnet') {
    return null;
  }

  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const mint = new PublicKey(config.usdcMint);
    const owner = new PublicKey(agentWallet);
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const sigs = await connection.getSignaturesForAddress(ata, { limit: SCAN_LIMIT });
    const cutoff = Math.floor(Date.now() / 1000) - SCAN_MAX_AGE_SEC;

    for (const s of sigs) {
      if (s.err) continue;
      if (s.blockTime != null && s.blockTime < cutoff) continue;
      const existing = await getSettlementBySignature(s.signature);
      if (existing?.status === 'success') continue;
      const verified = await verifyPayment(s.signature, agentWallet, feeUsdc);
      if (verified.verified) {
        return { signature: s.signature, source: 'chain_scan' };
      }
    }
  } catch (err: any) {
    console.warn('[gateway-settle] chain scan failed:', err?.message || err);
  }
  return null;
}

/**
 * Record a native-MPP gateway sale in PaymentSettlement after on-chain verify.
 * Does NOT move funds (buyer TX already split to vault + treasury).
 */
export async function settleVerifiedGatewaySale(opts: {
  agent: AgentRecord;
  feeUsdc: number;
  hint?: GatewayReceiptHint | null;
  payer?: string | null;
}): Promise<GatewaySettleResult> {
  const { agent, feeUsdc } = opts;
  if (!(feeUsdc > 0) || !agent.publicKey) {
    return { recorded: false, skipped: 'free or missing vault' };
  }
  if (config.paymentNetwork === 'localnet') {
    return { recorded: false, skipped: `network=${config.paymentNetwork}` };
  }

  const resolved = await resolveVerifiedGatewayPayment({
    agentWallet: agent.publicKey,
    feeUsdc,
    hint: opts.hint,
  });
  if (!resolved) {
    return {
      recorded: false,
      skipped: 'no verified payment signature (header or recent ATA TX)',
    };
  }

  const existing = await getSettlementBySignature(resolved.signature);
  if (existing?.status === 'success') {
    return {
      recorded: false,
      signature: resolved.signature,
      source: resolved.source,
      skipped: 'idempotent',
    };
  }

  await recordSettlement({
    signature: resolved.signature,
    agentId: agent.id,
    recipientWallet: agent.publicKey,
    amountUsdc: feeUsdc,
    status: 'success',
    network: opts.hint?.network || config.paymentNetwork,
    proofKind: resolved.source === 'header' ? 'gateway_receipt' : 'gateway_onchain',
  });

  return {
    recorded: true,
    signature: resolved.signature,
    source: resolved.source,
  };
}
