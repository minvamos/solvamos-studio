/**
 * Persist verified payment settlements (on-chain or sandbox proofs).
 */

import { prisma } from './db.js';

export type SettlementRecord = {
  id: string;
  agentId: string;
  recipientWallet: string;
  amount: number;
  status: 'success' | 'failed';
  timestamp: string;
  blockHeight: number;
  network?: string;
  proofKind?: string;
  explorerUrl?: string;
};

function explorerFor(network: string | undefined, signature: string): string | undefined {
  if (!signature || /^(MOCK_|SANDBOX_|PAYSH_)/i.test(signature)) return undefined;
  if (network === 'mainnet-beta') return `https://explorer.solana.com/tx/${signature}`;
  if (network === 'devnet') return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  return `https://explorer.solana.com/tx/${signature}?cluster=custom`;
}

function mapRow(row: {
  signature: string;
  agentId: string;
  recipientWallet: string;
  amountUsdc: number;
  status: string;
  blockHeight: number | null;
  network: string | null;
  proofKind: string | null;
  createdAt: Date;
}): SettlementRecord {
  return {
    id: row.signature,
    agentId: row.agentId,
    recipientWallet: row.recipientWallet,
    amount: row.amountUsdc,
    status: row.status === 'failed' ? 'failed' : 'success',
    timestamp: row.createdAt.toISOString().replace('T', ' ').substring(0, 19),
    blockHeight: row.blockHeight ?? 0,
    network: row.network || undefined,
    proofKind: row.proofKind || undefined,
    explorerUrl: explorerFor(row.network || undefined, row.signature),
  };
}

export async function recordSettlement(input: {
  signature: string;
  agentId: string;
  recipientWallet: string;
  amountUsdc: number;
  status?: 'success' | 'failed';
  blockHeight?: number | null;
  network?: string;
  proofKind?: string;
  ownerUserId?: string | null;
  /** Buyer agent when the payment came from an A2A peer call */
  payerAgentId?: string | null;
}): Promise<SettlementRecord> {
  const row = await prisma.paymentSettlement.upsert({
    where: { signature: input.signature },
    create: {
      signature: input.signature,
      agentId: input.agentId,
      recipientWallet: input.recipientWallet,
      amountUsdc: input.amountUsdc,
      status: input.status || 'success',
      blockHeight: input.blockHeight ?? null,
      network: input.network || null,
      proofKind: input.proofKind || null,
      ownerUserId: input.ownerUserId || null,
      payerAgentId: input.payerAgentId || null,
    },
    update: {
      status: input.status || 'success',
      blockHeight: input.blockHeight ?? undefined,
      network: input.network || undefined,
      proofKind: input.proofKind || undefined,
    },
  });
  return mapRow(row);
}

export async function listSettlementsForUser(userId: string): Promise<SettlementRecord[]> {
  try {
    const owned = await prisma.agentOwnership.findMany({
      where: { userId },
      select: { agentId: true },
    });
    const agentIds = owned.map((o) => o.agentId);
    if (agentIds.length === 0) return [];
    const rows = await prisma.paymentSettlement.findMany({
      where: {
        OR: [{ ownerUserId: userId }, { agentId: { in: agentIds } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(mapRow);
  } catch (err: any) {
    // Table not migrated yet — return empty rather than 500 the whole Studio shell.
    const msg = String(err?.message || err);
    if (
      err?.code === 'P2021' ||
      /PaymentSettlement.*does not exist|relation .*PaymentSettlement.*does not exist/i.test(msg)
    ) {
      console.warn('[settlements] PaymentSettlement table missing — run prisma migrate deploy');
      return [];
    }
    throw err;
  }
}
