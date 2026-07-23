/**
 * User Solana wallet registry — operator/human wallets ONLY.
 * Never use these as Agent.publicKey / invoke paywall recipient.
 * Agent vaults are created per-agent in vault.ts (separate keypair).
 */

import { PublicKey } from '@solana/web3.js';
import { prisma } from './db.js';

export type UserWallet = {
  id: string;
  address: string;
  label: string;
  source: 'manual' | 'phantom' | 'solflare' | string;
  isPrimary: boolean;
  createdAt: string;
};

export function isValidSolanaAddress(address: string): boolean {
  try {
    const pk = new PublicKey(address.trim());
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

function mapWallet(wallet: {
  id: string;
  address: string;
  label: string;
  source: string;
  isPrimary: boolean;
  createdAt: Date;
}): UserWallet {
  return {
    ...wallet,
    createdAt: wallet.createdAt.toISOString(),
  };
}

export async function listWallets(userId: string): Promise<UserWallet[]> {
  const wallets = await prisma.wallet.findMany({
    where: { userId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
  });
  return wallets.map(mapWallet);
}

export async function getPrimaryWallet(userId: string): Promise<UserWallet | undefined> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  return wallet ? mapWallet(wallet) : undefined;
}

export async function addWallet(
  userId: string,
  input: { address: string; label?: string; source?: string; makePrimary?: boolean }
): Promise<UserWallet> {
  const address = input.address.trim();
  if (!isValidSolanaAddress(address)) {
    throw new Error('Invalid Solana address');
  }

  const wallet = await prisma.$transaction(async (tx) => {
    const count = await tx.wallet.count({ where: { userId } });
    const makePrimary = count === 0 || input.makePrimary === true;
    if (makePrimary) {
      await tx.wallet.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return tx.wallet.upsert({
      where: { userId_address: { userId, address } },
      create: {
        userId,
        address,
        label: (input.label || '').trim() || shortLabel(address),
        source: input.source || 'manual',
        isPrimary: makePrimary,
      },
      update: {
        ...(input.label ? { label: input.label.trim() || shortLabel(address) } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(makePrimary ? { isPrimary: true } : {}),
      },
    });
  });
  return mapWallet(wallet);
}

export async function setPrimaryWallet(
  userId: string,
  walletId: string
): Promise<UserWallet> {
  const target = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!target) throw new Error('Wallet not found');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.wallet.updateMany({
      where: { userId, isPrimary: true },
      data: { isPrimary: false },
    });
    return tx.wallet.update({ where: { id: walletId }, data: { isPrimary: true } });
  });
  return mapWallet(updated);
}

export async function removeWallet(userId: string, walletId: string): Promise<UserWallet[]> {
  await prisma.$transaction(async (tx) => {
    const removed = await tx.wallet.findFirst({ where: { id: walletId, userId } });
    if (!removed) throw new Error('Wallet not found');
    await tx.wallet.delete({ where: { id: walletId } });
    if (removed.isPrimary) {
      const next = await tx.wallet.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await tx.wallet.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });
  return listWallets(userId);
}

export async function updateWalletLabel(
  userId: string,
  walletId: string,
  label: string
): Promise<UserWallet> {
  const target = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!target) throw new Error('Wallet not found');
  const updated = await prisma.wallet.update({
    where: { id: walletId },
    data: { label: label.trim() || shortLabel(target.address) },
  });
  return mapWallet(updated);
}

function shortLabel(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
