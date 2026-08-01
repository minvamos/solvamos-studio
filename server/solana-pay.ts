/**
 * Solana Pay transfer-request helpers (URL encode + reference confirmation).
 * Spec: https://docs.solanapay.com/spec
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { config } from './config.js';

export type SolanaPayIntent = {
  kind: 'usdc' | 'sol';
  amount: number;
  url: string;
  reference: string;
  recipient: string;
  splToken?: string;
};

/** Build a Solana Pay transfer request URL (one asset per URL). */
export function buildSolanaPayTransferUrl(opts: {
  recipient: string;
  amount: number;
  /** Omit for native SOL */
  splToken?: string;
  reference: string;
  label?: string;
  message?: string;
  memo?: string;
}): string {
  const recipient = new PublicKey(opts.recipient).toBase58();
  const params = new URLSearchParams();
  params.set('amount', String(opts.amount));
  if (opts.splToken) params.set('spl-token', new PublicKey(opts.splToken).toBase58());
  params.set('reference', new PublicKey(opts.reference).toBase58());
  if (opts.label) params.set('label', opts.label);
  if (opts.message) params.set('message', opts.message);
  if (opts.memo) params.set('memo', opts.memo);
  // URLSearchParams encodes spaces as + which Solana Pay accepts; keep as-is.
  return `solana:${recipient}?${params.toString()}`;
}

export function createVaultFundIntents(opts: {
  vaultAddress: string;
  amountUsdc?: number;
  amountSol?: number;
  agentLabel?: string;
}): { intents: SolanaPayIntent[]; network: string; usdcMint: string; rpcUrl: string } {
  const vault = new PublicKey(opts.vaultAddress).toBase58();
  const label = (opts.agentLabel || 'SolVamos Agent Vault').slice(0, 80);
  const intents: SolanaPayIntent[] = [];

  const usdcAmt = Number(opts.amountUsdc || 0);
  if (usdcAmt > 0) {
    const reference = Keypair.generate().publicKey.toBase58();
    intents.push({
      kind: 'usdc',
      amount: usdcAmt,
      reference,
      recipient: vault,
      splToken: config.usdcMint,
      url: buildSolanaPayTransferUrl({
        recipient: vault,
        amount: usdcAmt,
        splToken: config.usdcMint,
        reference,
        label,
        message: `Vault top-up ${usdcAmt} USDC`,
        memo: `sv-fund-usdc`,
      }),
    });
  }

  const solAmt = Number(opts.amountSol || 0);
  if (solAmt > 0) {
    const reference = Keypair.generate().publicKey.toBase58();
    intents.push({
      kind: 'sol',
      amount: solAmt,
      reference,
      recipient: vault,
      url: buildSolanaPayTransferUrl({
        recipient: vault,
        amount: solAmt,
        reference,
        label,
        message: `Vault top-up ${solAmt} SOL`,
        memo: `sv-fund-sol`,
      }),
    });
  }

  return {
    intents,
    network: config.paymentNetwork,
    usdcMint: config.usdcMint,
    rpcUrl: config.solanaRpcUrl,
  };
}

/** Phantom universal-link that opens a Solana Pay URL in the wallet. */
export function phantomBrowseLink(solanaPayUrl: string, appOrigin?: string): string {
  const encoded = encodeURIComponent(solanaPayUrl);
  const ref = encodeURIComponent(appOrigin || 'https://solvamos.app');
  return `https://phantom.app/ul/browse/${encoded}?ref=${ref}`;
}

export async function findPaymentByReference(reference: string): Promise<{
  confirmed: boolean;
  signature?: string;
  explorerUrl?: string;
  error?: string;
}> {
  try {
    const ref = new PublicKey(reference);
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const sigs = await connection.getSignaturesForAddress(ref, { limit: 5 });
    const hit = sigs.find((s) => !s.err);
    if (!hit) return { confirmed: false };
    const cluster = config.paymentNetwork === 'devnet' ? 'devnet' : 'mainnet-beta';
    return {
      confirmed: true,
      signature: hit.signature,
      explorerUrl: `https://explorer.solana.com/tx/${hit.signature}?cluster=${cluster}`,
    };
  } catch (err: any) {
    return { confirmed: false, error: String(err?.message || err).slice(0, 200) };
  }
}
