/**
 * User Solana wallet registry — operator/human wallets ONLY.
 * Never use these as Agent.publicKey / invoke paywall recipient.
 * Agent vaults are created per-agent in vault.ts (separate keypair).
 */

import fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { dataFile, ensureDataDir } from './data-paths.js';

export type UserWallet = {
  id: string;
  address: string;
  label: string;
  source: 'manual' | 'phantom' | 'solflare' | string;
  isPrimary: boolean;
  createdAt: string;
};

type WalletStore = Record<string, UserWallet[]>; // ownerKey → wallets

const WALLETS_FILE = dataFile('user-wallets.json');

let store: WalletStore = {};

export function loadWallets() {
  try {
    if (fs.existsSync(WALLETS_FILE)) {
      store = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[wallets] load failed', err);
    store = {};
  }
}

function save() {
  try {
    ensureDataDir();
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[wallets] save failed', err);
  }
}

loadWallets();

export function ownerKeyFromEmail(email?: string | null): string {
  if (!email) return 'anon';
  return email.trim().toLowerCase();
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const pk = new PublicKey(address.trim());
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

export function listWallets(ownerKey: string): UserWallet[] {
  return [...(store[ownerKey] || [])].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export function getPrimaryWallet(ownerKey: string): UserWallet | undefined {
  const list = store[ownerKey] || [];
  return list.find((w) => w.isPrimary) || list[0];
}

export function addWallet(
  ownerKey: string,
  input: { address: string; label?: string; source?: string; makePrimary?: boolean }
): UserWallet {
  const address = input.address.trim();
  if (!isValidSolanaAddress(address)) {
    throw new Error('Invalid Solana address');
  }

  const list = store[ownerKey] || [];
  const existing = list.find((w) => w.address === address);
  if (existing) {
    if (input.label) existing.label = input.label;
    if (input.source) existing.source = input.source;
    if (input.makePrimary || list.length === 1) {
      for (const w of list) w.isPrimary = w.id === existing.id;
    }
    store[ownerKey] = list;
    save();
    return existing;
  }

  const makePrimary = input.makePrimary !== false && (list.length === 0 || !!input.makePrimary);
  if (makePrimary) {
    for (const w of list) w.isPrimary = false;
  }

  const wallet: UserWallet = {
    id: `w_${Math.random().toString(36).slice(2, 10)}`,
    address,
    label: (input.label || '').trim() || shortLabel(address),
    source: input.source || 'manual',
    isPrimary: makePrimary || list.length === 0,
    createdAt: new Date().toISOString(),
  };
  if (list.length === 0) wallet.isPrimary = true;

  list.push(wallet);
  store[ownerKey] = list;
  save();
  return wallet;
}

export function setPrimaryWallet(ownerKey: string, walletId: string): UserWallet {
  const list = store[ownerKey] || [];
  const target = list.find((w) => w.id === walletId);
  if (!target) throw new Error('Wallet not found');
  for (const w of list) w.isPrimary = w.id === walletId;
  store[ownerKey] = list;
  save();
  return target;
}

export function removeWallet(ownerKey: string, walletId: string): UserWallet[] {
  let list = store[ownerKey] || [];
  const removed = list.find((w) => w.id === walletId);
  list = list.filter((w) => w.id !== walletId);
  if (removed?.isPrimary && list.length > 0) {
    list[0].isPrimary = true;
  }
  store[ownerKey] = list;
  save();
  return listWallets(ownerKey);
}

export function updateWalletLabel(
  ownerKey: string,
  walletId: string,
  label: string
): UserWallet {
  const list = store[ownerKey] || [];
  const target = list.find((w) => w.id === walletId);
  if (!target) throw new Error('Wallet not found');
  target.label = label.trim() || shortLabel(target.address);
  store[ownerKey] = list;
  save();
  return target;
}

function shortLabel(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
