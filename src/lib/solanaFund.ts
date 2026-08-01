/**
 * Client-side Phantom transfers → agent vault (USDC / SOL).
 * Server never holds the user's private key; funding must be signed in-wallet.
 */
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const USDC_DECIMALS = 6;

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString: () => string } | null;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  signAndSendTransaction: (
    tx: Transaction,
    opts?: { skipPreflight?: boolean }
  ) => Promise<{ signature: string }>;
};

function getPhantom(): PhantomProvider | null {
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

/** Send USDC and/or SOL from connected Phantom → agent vault. */
export async function fundAgentVaultFromPhantom(opts: {
  rpcUrl: string;
  usdcMint: string;
  vaultAddress: string;
  usdcAmount?: number;
  solAmount?: number;
}): Promise<FundVaultResult> {
  const provider = getPhantom();
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

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = from;

    const { signature } = await provider.signAndSendTransaction(tx);
    await connection.confirmTransaction(signature, 'confirmed');
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
