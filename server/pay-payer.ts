/**
 * A2A on-chain payer — buyer agent vault pays a peer with the platform split:
 *   (1 - platformFeeShare) USDC → seller agent vault
 *   platformFeeShare USDC → platform treasury
 * in ONE transaction, so `verifyPayment` (server/payment.ts) can audit the split.
 *
 * Also used for external pay-gateway sales: the gateway settles the full price
 * to the operator settlement wallet; `payoutGatewaySale` forwards the same
 * split (seller share → agent vault, platform share → treasury).
 *
 * Devnet only — localnet (pay --sandbox / Surfpool) keeps the legacy CLI path.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from './config.js';
import { loadPrivateKeyFromGCP } from './vault.js';
import type { AgentRecord } from './agents-store.js';

const USDC_DECIMALS = 6;

export type SplitPaymentResult = {
  ok: boolean;
  signature?: string;
  error?: string;
  amountUsdc?: number;
  sellerShareUsdc?: number;
  platformShareUsdc?: number;
};

/** Parse a stored secret key: base64(64B) (vault format) or JSON byte array (id.json format). */
export function keypairFromStoredSecret(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, 'base64')));
}

/** Load the buyer agent's vault keypair from Secret Manager (or dev fallback). */
export async function loadAgentKeypair(agent: AgentRecord): Promise<Keypair | null> {
  if (!agent.secretManagerPath) return null;
  const secret = await loadPrivateKeyFromGCP(agent.secretManagerPath);
  if (!secret) return null;
  try {
    return keypairFromStoredSecret(secret);
  } catch (err: any) {
    console.warn(`[pay-payer] bad vault key for agent ${agent.id}:`, err?.message || err);
    return null;
  }
}

let cachedSettlementKeypair: Keypair | null | undefined;

/**
 * Platform settlement wallet (gateway PAY_RECIPIENT). Secret Manager path via
 * PAY_SETTLEMENT_SECRET_PATH, e.g. projects/<id>/secrets/pay-operator-key/versions/latest
 */
export async function loadSettlementKeypair(): Promise<Keypair | null> {
  if (cachedSettlementKeypair !== undefined) return cachedSettlementKeypair;
  const secretPath = process.env.PAY_SETTLEMENT_SECRET_PATH || '';
  if (!secretPath) {
    cachedSettlementKeypair = null;
    return null;
  }
  try {
    const client = new SecretManagerServiceClient();
    const [version] = await client.accessSecretVersion({ name: secretPath });
    const data = version.payload?.data;
    if (!data) throw new Error('empty secret payload');
    cachedSettlementKeypair = keypairFromStoredSecret(
      Buffer.from(data as Uint8Array).toString('utf8')
    );
    return cachedSettlementKeypair;
  } catch (err: any) {
    console.warn('[pay-payer] settlement key load failed:', err?.message || err);
    cachedSettlementKeypair = null;
    return null;
  }
}

/** Reset settlement key cache (tests / secret rotation). */
export function resetSettlementKeypairCache() {
  cachedSettlementKeypair = undefined;
}

function toUnits(amountUsdc: number): bigint {
  return BigInt(Math.ceil(amountUsdc * 10 ** USDC_DECIMALS));
}

/**
 * One transaction: payer → seller ((1-share)·amount) + payer → treasury (share·amount).
 * Creates missing ATAs idempotently (payer funds rent).
 */
export async function sendSplitUsdcPayment(opts: {
  payer: Keypair;
  sellerWallet: string;
  amountUsdc: number;
}): Promise<SplitPaymentResult> {
  const { payer, sellerWallet, amountUsdc } = opts;
  if (config.paymentNetwork !== 'devnet') {
    return {
      ok: false,
      error: `On-chain split payment requires devnet (current: ${config.paymentNetwork})`,
    };
  }
  if (!(amountUsdc > 0)) {
    return { ok: false, error: `Invalid amount: ${amountUsdc}` };
  }

  const platformShare = config.platformFeeShare;
  const treasury = config.platformTreasuryPubkey;
  const sellerShareUsdc = amountUsdc * (1 - platformShare);
  const platformShareUsdc = amountUsdc * platformShare;

  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const mint = new PublicKey(config.usdcMint);
    const seller = new PublicKey(sellerWallet);

    const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const sellerAta = getAssociatedTokenAddressSync(mint, seller);

    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, sellerAta, seller, mint)
    );
    tx.add(
      createTransferInstruction(payerAta, sellerAta, payer.publicKey, toUnits(sellerShareUsdc))
    );

    if (treasury && platformShare > 0) {
      const treasuryPk = new PublicKey(treasury);
      const treasuryAta = getAssociatedTokenAddressSync(mint, treasuryPk);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          treasuryAta,
          treasuryPk,
          mint
        )
      );
      tx.add(
        createTransferInstruction(payerAta, treasuryAta, payer.publicKey, toUnits(platformShareUsdc))
      );
    } else {
      // No treasury configured — send the full amount to the seller so
      // verifyPayment's "agent-only" branch still passes.
      tx.add(
        createTransferInstruction(payerAta, sellerAta, payer.publicKey, toUnits(platformShareUsdc))
      );
    }

    const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
    return {
      ok: true,
      signature,
      amountUsdc,
      sellerShareUsdc,
      platformShareUsdc,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    let hint = '';
    if (/could not find account|TokenAccountNotFound|InvalidAccountData|0x1\b/.test(msg)) {
      hint = ' (buyer vault likely has no USDC — top up the agent vault)';
    } else if (/insufficient lamports|Attempt to debit an account/i.test(msg)) {
      hint = ' (buyer vault has no SOL for fees — top up the agent vault with devnet SOL)';
    }
    return { ok: false, error: `split payment failed: ${msg.slice(0, 300)}${hint}` };
  }
}

/** Buyer agent vault pays a peer (A2A). Returns the on-chain proof signature. */
export async function payPeerFromAgentVault(
  buyer: AgentRecord,
  sellerWallet: string,
  amountUsdc: number
): Promise<SplitPaymentResult> {
  const payer = await loadAgentKeypair(buyer);
  if (!payer) {
    return {
      ok: false,
      error: `Buyer agent ${buyer.id} vault key unavailable (secretManagerPath=${buyer.secretManagerPath || 'unset'})`,
    };
  }
  if (payer.publicKey.toBase58() !== buyer.publicKey) {
    console.warn(
      `[pay-payer] vault key pubkey mismatch for ${buyer.id}: stored=${buyer.publicKey} derived=${payer.publicKey.toBase58()}`
    );
  }
  return sendSplitUsdcPayment({ payer, sellerWallet, amountUsdc });
}

/**
 * External gateway sale payout — the gateway settled the FULL fee into the
 * operator settlement wallet; forward seller share → agent vault and platform
 * share → treasury.
 */
export async function payoutGatewaySale(
  sellerWallet: string,
  amountUsdc: number
): Promise<SplitPaymentResult> {
  const payer = await loadSettlementKeypair();
  if (!payer) {
    return {
      ok: false,
      error: 'Settlement wallet key unavailable (set PAY_SETTLEMENT_SECRET_PATH)',
    };
  }
  return sendSplitUsdcPayment({ payer, sellerWallet, amountUsdc });
}

/** On-chain balances of a wallet: SOL + USDC (current mint). */
export async function getWalletBalances(wallet: string): Promise<{
  sol: number | null;
  usdc: number | null;
  error?: string;
}> {
  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const owner = new PublicKey(wallet);
    const lamports = await connection.getBalance(owner);
    let usdc: number | null = 0;
    try {
      const mint = new PublicKey(config.usdcMint);
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
      usdc = accounts.value.reduce(
        (sum, a) => sum + (a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0),
        0
      );
    } catch {
      usdc = null;
    }
    return { sol: lamports / 1e9, usdc };
  } catch (err: any) {
    return { sol: null, usdc: null, error: String(err?.message || err).slice(0, 200) };
  }
}
