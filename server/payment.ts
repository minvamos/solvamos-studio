/**
 * pay.sh / x402 payment verification — USDC SPL with optional 90/10 platform split.
 * Networks: sandbox (pay.sh local) | localnet | devnet
 * Security: fail-closed on RPC errors unless ALLOW_PAYMENT_BYPASS=true.
 * Sandbox network may accept MOCK_/SANDBOX_/PAYSH_LOCAL_ proofs without bypass flag.
 */

import { Connection } from '@solana/web3.js';
import { config } from './config.js';
import { dataFile, ensureDataDir } from './data-paths.js';
import fs from 'fs';

export type PaymentVerifyResult = {
  verified: boolean;
  logs: string[];
  error?: string;
  network: string;
};

/** Prevent replay of the same on-chain / sandbox signature. */
const REPLAY_FILE = dataFile('payment-replay.json');
const REPLAY_TTL_MS = 7 * 24 * 3600 * 1000;
let usedProofs: Record<string, number> = {};

function loadReplayCache() {
  try {
    if (fs.existsSync(REPLAY_FILE)) {
      usedProofs = JSON.parse(fs.readFileSync(REPLAY_FILE, 'utf8'));
    }
  } catch {
    usedProofs = {};
  }
}

function saveReplayCache() {
  try {
    ensureDataDir();
    const now = Date.now();
    const pruned: Record<string, number> = {};
    for (const [k, t] of Object.entries(usedProofs)) {
      if (now - t < REPLAY_TTL_MS) pruned[k] = t;
    }
    usedProofs = pruned;
    fs.writeFileSync(REPLAY_FILE, JSON.stringify(usedProofs));
  } catch (err) {
    console.warn('[payment] replay cache persist failed', err);
  }
}

loadReplayCache();

function assertNotReplayed(signature: string, logs: string[]): string | null {
  const key = signature.trim();
  if (!key) return 'Empty payment proof';
  const seen = usedProofs[key];
  if (seen && Date.now() - seen < REPLAY_TTL_MS) {
    logs.push(`[Replay] Rejected previously used proof`);
    return 'Payment proof already used (replay blocked)';
  }
  return null;
}

function markProofUsed(signature: string) {
  usedProofs[signature.trim()] = Date.now();
  saveReplayCache();
}

function isSandboxProof(signature: string): boolean {
  return (
    signature.startsWith('MOCK_TX_') ||
    signature.startsWith('SANDBOX_TX_') ||
    signature.startsWith('PAYSH_LOCAL_') ||
    signature.startsWith('PAYSH_A2A_') ||
    signature === 'SOLVAMOS_TEST_SIGNATURE'
  );
}

function getBalanceChange(
  preBalances: any[],
  postBalances: any[],
  mint: string,
  ownerAddress: string
): number {
  const posts = postBalances.filter((b) => b.mint === mint && b.owner === ownerAddress);
  const pres = preBalances.filter((b) => b.mint === mint && b.owner === ownerAddress);
  const postAmt = posts.reduce((s, b) => s + (b.uiTokenAmount?.uiAmount || 0), 0);
  const preAmt = pres.reduce((s, b) => s + (b.uiTokenAmount?.uiAmount || 0), 0);
  return postAmt - preAmt;
}

/** Primary verifier (USDC). Kept name alias below for older imports. */
export async function verifyPayment(
  signature: string,
  recipientWallet: string,
  expectedUsdcAmount: number
): Promise<PaymentVerifyResult> {
  const logs: string[] = [];
  const network = config.paymentNetwork;
  const allowBypass = config.allowPaymentBypass;
  const mint = config.usdcMint;
  const treasury = config.platformTreasuryPubkey;
  const platformShare = config.platformFeeShare;
  const agentShare = 1 - platformShare;

  const expectedAgentAmount = expectedUsdcAmount * agentShare;
  const expectedCreatorAmount = expectedUsdcAmount * platformShare;

  logs.push(`[Network] ${network} RPC=${config.solanaRpcUrl}`);
  logs.push(`[Token] USDC mint=${mint}`);
  logs.push(
    `[Split] total=${expectedUsdcAmount} USDC → agent ${(agentShare * 100).toFixed(0)}% / platform ${(platformShare * 100).toFixed(0)}%`
  );

  const replayErr = assertNotReplayed(signature, logs);
  if (replayErr) {
    return { verified: false, logs, error: replayErr, network };
  }

  // --- Sandbox / mock proofs ---
  if (isSandboxProof(signature)) {
    const sandboxOk = network === 'sandbox' || allowBypass;
    if (!sandboxOk) {
      logs.push(
        `[Rejected] Sandbox/mock proof not allowed on network=${network} (set PAYMENT_NETWORK=sandbox or ALLOW_PAYMENT_BYPASS=true)`
      );
      return {
        verified: false,
        logs,
        error: 'Sandbox payment proofs require PAYMENT_NETWORK=sandbox or ALLOW_PAYMENT_BYPASS',
        network,
      };
    }
    logs.push(`[Sandbox Proof] Accepted ${signature.slice(0, 24)}… on ${network}`);
    logs.push(
      `[USDC simulation] agent ${expectedAgentAmount.toFixed(6)} → ${recipientWallet}` +
        (treasury
          ? `; platform ${expectedCreatorAmount.toFixed(6)} → ${treasury}`
          : ' (no PLATFORM_TREASURY_PUBKEY — agent-only check in live mode)')
    );
    markProofUsed(signature);
    return { verified: true, logs, network };
  }

  // --- On-chain USDC (localnet or devnet) ---
  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    logs.push(`[RPC Query] signature=${signature}`);

    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return {
        verified: false,
        logs,
        error: `Transaction not found on ${network}`,
        network,
      };
    }

    const meta = tx.meta;
    if (!meta) {
      return { verified: false, logs, error: 'Transaction meta missing', network };
    }

    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];

    const recipientChange = getBalanceChange(preBalances, postBalances, mint, recipientWallet);
    logs.push(`[Audit] Agent wallet USDC Δ=${recipientChange.toFixed(6)} (need ≥ ${expectedAgentAmount.toFixed(6)})`);

    let creatorOk = true;
    if (treasury && expectedCreatorAmount > 0) {
      const creatorChange = getBalanceChange(preBalances, postBalances, mint, treasury);
      logs.push(
        `[Audit] Platform treasury USDC Δ=${creatorChange.toFixed(6)} (need ≥ ${expectedCreatorAmount.toFixed(6)})`
      );
      creatorOk = creatorChange >= expectedCreatorAmount * 0.98;
    } else if (platformShare > 0 && !treasury) {
      logs.push(`[Warn] PLATFORM_TREASURY_PUBKEY unset — verifying agent receive amount only (100% of fee)`);
      // When no treasury configured, require full fee to agent
      if (recipientChange >= expectedUsdcAmount * 0.98) {
        logs.push(`[SUCCESS] USDC payment verified (agent-only, no treasury)`);
        markProofUsed(signature);
        return { verified: true, logs, network };
      }
      return {
        verified: false,
        logs,
        error: `Incomplete USDC transfer to agent. Expected ${expectedUsdcAmount}, got ${recipientChange}`,
        network,
      };
    }

    if (recipientChange >= expectedAgentAmount * 0.98 && creatorOk) {
      logs.push(`[SUCCESS] USDC payment + split verified on ${network}`);
      markProofUsed(signature);
      return { verified: true, logs, network };
    }

    return {
      verified: false,
      logs,
      error: 'Incomplete USDC transfer or incorrect 90/10 split',
      network,
    };
  } catch (err: any) {
    logs.push(`[RPC Error] ${err.message}`);
    if (allowBypass) {
      logs.push(`[Bypass] ALLOW_PAYMENT_BYPASS=true — accepting after RPC failure`);
      markProofUsed(signature);
      return { verified: true, logs, network };
    }
    return {
      verified: false,
      logs,
      error: `RPC verification failed (fail-closed): ${err.message}`,
      network,
    };
  }
}

/** @deprecated use verifyPayment — alias retained for call sites */
export async function verifySolanaDevnetPayment(
  signature: string,
  recipientWallet: string,
  expectedAmount: number
) {
  return verifyPayment(signature, recipientWallet, expectedAmount);
}
