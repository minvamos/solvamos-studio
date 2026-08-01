/**
 * A2A on-chain payer — buyer agent vault pays a peer with the platform split:
 *   (1 - platformFeeShare) USDC → seller agent vault
 *   platformFeeShare USDC → platform treasury
 * in ONE transaction, so `verifyPayment` (server/payment.ts) can audit the split.
 *
 * A2A call fees: buyer vault pays SOL. Platform sponsors SOL only on vault
 * reclaim (agent delete) — see `reclaimAgentVaultOnDelete`.
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
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAccount,
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

export type EnsureAtaResult = {
  ok: boolean;
  ata?: string;
  created?: boolean;
  signature?: string;
  error?: string;
  /** Settlement key missing — cannot pay rent */
  skipped?: boolean;
};

/**
 * Ensure the owner has a USDC ATA so pay.sh MPP splits can settle immediately.
 * Platform settlement/operator wallet pays rent (idempotent).
 */
export async function ensureUsdcAtaForOwner(ownerWallet: string): Promise<EnsureAtaResult> {
  const payer = await loadSettlementKeypair();
  if (!payer) {
    return {
      ok: false,
      skipped: true,
      error: 'Settlement wallet key unavailable (set PAY_SETTLEMENT_SECRET_PATH)',
    };
  }
  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const mint = new PublicKey(config.usdcMint);
    const owner = new PublicKey(ownerWallet);
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const info = await connection.getAccountInfo(ata, 'confirmed');
    if (info) {
      return { ok: true, ata: ata.toBase58(), created: false };
    }
    const bal = await connection.getBalance(payer.publicKey, 'confirmed');
    if (bal < 50_000) {
      return {
        ok: false,
        error: `Settlement wallet has insufficient SOL for ATA rent (bal=${bal} lamports)`,
      };
    }
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint)
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: 'confirmed',
    });
    return { ok: true, ata: ata.toBase58(), created: true, signature };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}

export type VaultReclaimResult = {
  ok: boolean;
  skipped?: boolean;
  usdcTransferred?: number;
  usdcDestination?: string;
  usdcDestinationKind?: 'owner_primary' | 'platform_treasury' | 'none';
  ataClosed?: boolean;
  rentReclaimedTo?: string;
  solTransferred?: number;
  solDestination?: string;
  signatures?: string[];
  error?: string;
  details: string[];
};

function isPubkey(s: string | null | undefined): s is string {
  if (!s) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Agent delete sweep (must run BEFORE vault secret is deleted):
 *   1) USDC balance → owner's primary wallet (fallback: platform treasury)
 *   2) Close USDC ATA → rent lamports back to operator (who paid create rent)
 *   3) Leftover native SOL on vault → same funds destination
 *
 * Operator is fee-payer so the empty vault can still sign authority ops.
 */
export async function reclaimAgentVaultOnDelete(opts: {
  agent: AgentRecord;
  ownerWallet?: string | null;
}): Promise<VaultReclaimResult> {
  const details: string[] = [];
  const { agent, ownerWallet } = opts;

  if (!agent.publicKey || !agent.secretManagerPath) {
    return { ok: true, skipped: true, details: ['no vault pubkey/secret — skip reclaim'] };
  }

  const operator = await loadSettlementKeypair();
  const vault = await loadAgentKeypair(agent);
  if (!vault) {
    return {
      ok: false,
      error: `Vault key unavailable for agent ${agent.id}`,
      details,
    };
  }

  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const mint = new PublicKey(config.usdcMint);
    const agentAta = getAssociatedTokenAddressSync(mint, vault.publicKey);
    const ataInfo = await connection.getAccountInfo(agentAta, 'confirmed');
    const vaultLamports = await connection.getBalance(vault.publicKey, 'confirmed');

    let tokenAmount = 0n;
    if (ataInfo) {
      try {
        const acc = await getAccount(connection, agentAta, 'confirmed');
        tokenAmount = acc.amount;
      } catch (err: any) {
        details.push(`ATA read failed: ${String(err?.message || err).slice(0, 120)}`);
      }
    }

    const needsChainWork = !!ataInfo || tokenAmount > 0n || vaultLamports > 0;
    if (!needsChainWork) {
      return {
        ok: true,
        skipped: true,
        ataClosed: false,
        details: ['no ATA / USDC / SOL on vault — nothing to reclaim'],
      };
    }

    if (!operator) {
      return {
        ok: false,
        error: 'Settlement wallet key unavailable (set PAY_SETTLEMENT_SECRET_PATH) — cannot reclaim',
        details,
      };
    }

    const ownerDest = isPubkey(ownerWallet) ? ownerWallet : null;
    const treasuryDest = isPubkey(config.platformTreasuryPubkey)
      ? config.platformTreasuryPubkey
      : null;
    const fundsDest = ownerDest || treasuryDest;
    const destKind: VaultReclaimResult['usdcDestinationKind'] = ownerDest
      ? 'owner_primary'
      : fundsDest
        ? 'platform_treasury'
        : 'none';

    if (tokenAmount > 0n && !fundsDest) {
      return {
        ok: false,
        error: 'Vault has USDC but owner has no registered wallet (and no treasury fallback)',
        details,
      };
    }

    const signatures: string[] = [];
    let usdcTransferred = 0;
    let ataClosed = false;
    let solTransferred = 0;
    let solDestination: string | undefined;
    let usdcDestination: string | undefined;

    if (ataInfo) {
      const tx = new Transaction();
      if (tokenAmount > 0n && fundsDest) {
        const destPk = new PublicKey(fundsDest);
        const destAta = getAssociatedTokenAddressSync(mint, destPk);
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            operator.publicKey,
            destAta,
            destPk,
            mint
          )
        );
        tx.add(
          createTransferInstruction(agentAta, destAta, vault.publicKey, tokenAmount)
        );
        usdcTransferred = Number(tokenAmount) / 10 ** USDC_DECIMALS;
        usdcDestination = fundsDest;
        details.push(
          `USDC ${usdcTransferred} → ${fundsDest.slice(0, 4)}…${fundsDest.slice(-4)} (${destKind})`
        );
      } else if (tokenAmount > 0n) {
        return {
          ok: false,
          error: 'Cannot transfer USDC — no destination wallet',
          details,
        };
      }

      // Rent returns to operator (platform paid ATA create).
      tx.add(
        createCloseAccountInstruction(agentAta, operator.publicKey, vault.publicKey)
      );
      details.push(
        `close ATA → rent to operator ${operator.publicKey.toBase58().slice(0, 4)}…`
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [operator, vault], {
        commitment: 'confirmed',
      });
      signatures.push(sig);
      ataClosed = true;
    } else {
      details.push('no USDC ATA to close');
    }

    const lamportsLeft = await connection.getBalance(vault.publicKey, 'confirmed');
    if (lamportsLeft > 0) {
      const solDest = fundsDest || operator.publicKey.toBase58();
      const txSol = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: vault.publicKey,
          toPubkey: new PublicKey(solDest),
          lamports: lamportsLeft,
        })
      );
      // Operator pays fees so vault can empty completely.
      const sigSol = await sendAndConfirmTransaction(connection, txSol, [operator, vault], {
        commitment: 'confirmed',
      });
      signatures.push(sigSol);
      solTransferred = lamportsLeft / 1e9;
      solDestination = solDest;
      details.push(
        `SOL ${solTransferred} → ${solDest.slice(0, 4)}…${solDest.slice(-4)}`
      );
    }

    return {
      ok: true,
      usdcTransferred,
      usdcDestination,
      usdcDestinationKind: destKind,
      ataClosed,
      rentReclaimedTo: ataClosed ? operator.publicKey.toBase58() : undefined,
      solTransferred,
      solDestination,
      signatures,
      details,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: String(err?.message || err).slice(0, 300),
      details,
    };
  }
}

function toUnits(amountUsdc: number): bigint {
  return BigInt(Math.ceil(amountUsdc * 10 ** USDC_DECIMALS));
}

/**
 * One transaction: payer → seller ((1-share)·amount) + payer → treasury (share·amount).
 * Creates missing ATAs idempotently (payer funds rent + SOL network fees).
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

export type VaultWithdrawResult = {
  ok: boolean;
  skipped?: boolean;
  signature?: string;
  amountUsdc?: number;
  destination?: string;
  error?: string;
  explorerUrl?: string;
};

/**
 * Owner cash-out: move USDC from agent vault → owner's primary wallet.
 * Keeps the vault ATA open (unlike delete reclaim). Fee-payer is the vault when
 * it has SOL, otherwise the operator settlement wallet.
 */
export async function withdrawUsdcFromAgentVault(opts: {
  agent: AgentRecord;
  destinationWallet: string;
  /** Omit or 0 = withdraw entire USDC balance. */
  amountUsdc?: number;
}): Promise<VaultWithdrawResult> {
  if (config.paymentNetwork !== 'devnet') {
    return { ok: false, error: `Withdraw requires devnet (current: ${config.paymentNetwork})` };
  }
  if (!isPubkey(opts.destinationWallet)) {
    return { ok: false, error: 'Invalid destination wallet' };
  }
  if (!opts.agent.publicKey || !opts.agent.secretManagerPath) {
    return { ok: false, error: 'Agent vault missing' };
  }

  const vault = await loadAgentKeypair(opts.agent);
  if (!vault) {
    return { ok: false, error: `Vault key unavailable for agent ${opts.agent.id}` };
  }

  try {
    const connection = new Connection(config.solanaRpcUrl, 'confirmed');
    const mint = new PublicKey(config.usdcMint);
    const dest = new PublicKey(opts.destinationWallet);
    const agentAta = getAssociatedTokenAddressSync(mint, vault.publicKey);
    const destAta = getAssociatedTokenAddressSync(mint, dest);

    let balance = 0n;
    try {
      const acc = await getAccount(connection, agentAta, 'confirmed');
      balance = acc.amount;
    } catch {
      return { ok: true, skipped: true, amountUsdc: 0, destination: opts.destinationWallet };
    }
    if (balance <= 0n) {
      return { ok: true, skipped: true, amountUsdc: 0, destination: opts.destinationWallet };
    }

    let amount = balance;
    if (opts.amountUsdc != null && opts.amountUsdc > 0) {
      amount = toUnits(opts.amountUsdc);
      if (amount > balance) {
        return {
          ok: false,
          error: `Insufficient vault USDC (have ${Number(balance) / 10 ** USDC_DECIMALS}, asked ${opts.amountUsdc})`,
        };
      }
    }

    const vaultLamports = await connection.getBalance(vault.publicKey, 'confirmed');
    let feePayer = vault;
    const signers: Keypair[] = [vault];
    if (vaultLamports < 20_000) {
      const operator = await loadSettlementKeypair();
      if (!operator) {
        return {
          ok: false,
          error:
            'Vault has too little SOL for fees and settlement wallet is unavailable — top up vault SOL first',
        };
      }
      feePayer = operator;
      signers.unshift(operator);
    }

    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        feePayer.publicKey,
        destAta,
        dest,
        mint
      )
    );
    tx.add(createTransferInstruction(agentAta, destAta, vault.publicKey, amount));
    tx.feePayer = feePayer.publicKey;

    const signature = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
    });
    const amountUsdc = Number(amount) / 10 ** USDC_DECIMALS;
    return {
      ok: true,
      signature,
      amountUsdc,
      destination: opts.destinationWallet,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
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
