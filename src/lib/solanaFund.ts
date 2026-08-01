/**
 * User-signed vault funding: Phantom browser extension + Solana Pay helpers.
 * Server never holds the user's private key.
 */
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import QRCode from 'qrcode';

const USDC_DECIMALS = 6;

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString: () => string } }>;
  signAndSendTransaction: (
    tx: Transaction,
    opts?: { skipPreflight?: boolean }
  ) => Promise<{ signature: string }>;
};

export function getPhantomProvider(): PhantomProvider | null {
  const official = (window as any).phantom?.solana as PhantomProvider | undefined;
  if (official?.isPhantom) return official;
  const legacy = (window as any).solana as PhantomProvider | undefined;
  if (legacy?.isPhantom) return legacy;
  return null;
}

function toUsdcUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

export type FundVaultResult = {
  ok: boolean;
  signature?: string;
  explorerUrl?: string;
  error?: string;
};

/** Send USDC and/or SOL from connected Phantom → agent vault (one TX). */
export async function fundAgentVaultFromPhantom(opts: {
  rpcUrl: string;
  usdcMint: string;
  vaultAddress: string;
  usdcAmount?: number;
  solAmount?: number;
}): Promise<FundVaultResult> {
  const provider = getPhantomProvider();
  if (!provider) {
    return {
      ok: false,
      error: 'Phantom이 없습니다. https://phantom.app 설치 후 Devnet으로 전환하세요.',
    };
  }

  const usdcAmount = opts.usdcAmount && opts.usdcAmount > 0 ? opts.usdcAmount : 0;
  const solAmount = opts.solAmount && opts.solAmount > 0 ? opts.solAmount : 0;
  if (usdcAmount <= 0 && solAmount <= 0) {
    return { ok: false, error: 'USDC 또는 SOL 금액을 입력하세요.' };
  }

  try {
    const connected = await provider.connect();
    const fromStr = connected.publicKey?.toString?.();
    if (!fromStr) return { ok: false, error: 'Phantom 주소를 받지 못했습니다.' };

    const connection = new Connection(opts.rpcUrl, 'confirmed');
    const from = new PublicKey(fromStr);
    const vault = new PublicKey(opts.vaultAddress);
    const tx = new Transaction();

    if (usdcAmount > 0) {
      const mint = new PublicKey(opts.usdcMint);
      const fromAta = getAssociatedTokenAddressSync(mint, from);
      const vaultAta = getAssociatedTokenAddressSync(mint, vault);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(from, vaultAta, vault, mint)
      );
      tx.add(
        createTransferInstruction(fromAta, vaultAta, from, toUsdcUnits(usdcAmount))
      );
    }

    if (solAmount > 0) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: vault,
          lamports: Math.round(solAmount * 1e9),
        })
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = from;

    const { signature } = await provider.signAndSendTransaction(tx);
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    return {
      ok: true,
      signature,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    };
  } catch (err: any) {
    const msg = String(err?.message || err?.error || err || '');
    if (err?.code === 4001 || /reject|denied|cancel/i.test(msg)) {
      return { ok: false, error: 'Phantom 서명이 취소되었습니다.' };
    }
    return { ok: false, error: msg.slice(0, 280) || '전송 실패' };
  }
}

export type SolanaPayIntentClient = {
  kind: 'usdc' | 'sol';
  amount: number;
  url: string;
  reference: string;
  phantomUrl?: string;
  qrDataUrl?: string;
};

/** Render Solana Pay URL as a QR data URL for mobile wallets. */
export async function qrDataUrlForPay(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    width: 220,
    margin: 2,
    color: { dark: '#0b1220', light: '#ffffff' },
  });
}

/**
 * Poll server until Solana Pay reference is confirmed on-chain.
 * Returns on first confirmed intent (caller can refresh balances).
 */
export async function waitForSolanaPayConfirmations(opts: {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  agentId: string;
  references: string[];
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (confirmed: string[]) => void;
}): Promise<{ ok: boolean; confirmed: string[]; explorerUrls: string[]; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 2500;
  const start = Date.now();
  const pending = new Set(opts.references);
  const confirmed: string[] = [];
  const explorerUrls: string[] = [];

  while (pending.size && Date.now() - start < timeoutMs) {
    for (const ref of [...pending]) {
      try {
        const res = await opts.authFetch(
          `/api/agents/${encodeURIComponent(opts.agentId)}/solana-pay/${encodeURIComponent(ref)}`
        );
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.confirmed) {
          pending.delete(ref);
          confirmed.push(ref);
          if (json.explorerUrl) explorerUrls.push(String(json.explorerUrl));
          opts.onProgress?.(confirmed);
        }
      } catch {
        /* keep polling */
      }
    }
    if (!pending.size) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (!confirmed.length) {
    return {
      ok: false,
      confirmed,
      explorerUrls,
      error: '결제 확인 시간 초과. 지갑에서 보냈다면 잔액을 새로고침해 보세요.',
    };
  }
  return { ok: pending.size === 0, confirmed, explorerUrls };
}
