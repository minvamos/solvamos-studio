/**
 * Agent metadata — PostgreSQL (Prisma).
 */

import { compileSystemPrompt } from './prompt.js';
import { prisma } from './db.js';
import type { Agent as DbAgent } from '@prisma/client';
import { upsertCatalogAgentFromRecord } from './catalog-db.js';
import { config } from './config.js';

export interface AgentRecord {
  id: string;
  tenantId?: string;
  agentName?: string;
  role: string;
  customRole?: string;
  tone: string;
  securityLevel: string;
  publicKey: string;
  systemPrompt: string;
  created: string;
  invokeCount: number;
  googleDriveFolderId?: string;
  vertexDataStoreId?: string;
  vertexEngineId?: string;
  aiAppType?: string;
  dataSourceType?: string;
  websiteUri?: string;
  gcsUri?: string;
  secretManagerPath?: string;
  status?: 'CREATING' | 'INDEXING' | 'ACTIVE' | 'PAUSED' | 'ERROR' | string;
  fee?: number;
  perCallPriceUsdc?: number;
}

function toRecord(a: DbAgent): AgentRecord {
  return {
    id: a.id,
    tenantId: a.tenantId || undefined,
    agentName: a.agentName || undefined,
    role: a.role,
    customRole: a.customRole || undefined,
    tone: a.tone,
    securityLevel: a.securityLevel,
    publicKey: a.publicKey,
    systemPrompt: a.systemPrompt,
    created: a.createdAt.toISOString(),
    invokeCount: a.invokeCount,
    googleDriveFolderId: a.googleDriveFolderId || undefined,
    vertexDataStoreId: a.vertexDataStoreId || undefined,
    vertexEngineId: (a as any).vertexEngineId || undefined,
    aiAppType: (a as any).aiAppType || undefined,
    dataSourceType: (a as any).dataSourceType || undefined,
    websiteUri: (a as any).websiteUri || undefined,
    gcsUri: (a as any).gcsUri || undefined,
    secretManagerPath: a.secretManagerPath || undefined,
    status: a.status,
    fee: a.feeUsdc,
    perCallPriceUsdc: a.feeUsdc,
  };
}

async function syncListing(agent: AgentRecord, owner?: { userId?: string; email?: string }) {
  try {
    await upsertCatalogAgentFromRecord(agent, {
      baseUrl: config.appUrl,
      ownerUserId: owner?.userId || null,
      ownerEmail: owner?.email || null,
    });
  } catch (err: any) {
    console.warn('[agents-store] catalog sync failed', agent.id, err?.message || err);
  }
}

export async function loadAgents(): Promise<void> {
  const count = await prisma.agent.count();
  const allowSeed =
    process.env.NODE_ENV !== 'production' &&
    process.env.SKIP_SEED_AGENTS !== '1' &&
    process.env.SKIP_SEED_AGENTS !== 'true';
  if (count === 0 && allowSeed) {
    await seedDefaultAgents();
  } else if (allowSeed) {
    await ensureAcademicPeerSeed();
  }
  await ensureLocalSeedAgentsFree();
  const { syncAllAgentsToCatalog } = await import('./catalog-db.js');
  const synced = await syncAllAgentsToCatalog({ baseUrl: config.appUrl });
  const n = await prisma.agent.count();
  console.log(`Loaded ${n} agents from database; catalog rows synced=${synced}.`);
}

const SEED_AGENT_IDS = ['support-copilot-001', 'academic-research-001'] as const;

async function ensureAcademicPeerSeed() {
  const existing = await prisma.agent.findUnique({ where: { id: 'academic-research-001' } });
  if (existing) return;
  await prisma.agent.create({
    data: {
      id: 'academic-research-001',
      agentName: 'Academic Research Peer',
      role: 'academic',
      tone: 'academic',
      securityLevel: 'balanced',
      publicKey: 'AcadPeer111111111111111111111111111111111111',
      systemPrompt: compileSystemPrompt('academic', 'academic', 'balanced'),
      invokeCount: 0,
      status: 'ACTIVE',
      feeUsdc: 0,
    },
  });
  console.log('Seeded academic-research-001 for A2A pay.sh catalog demos.');
}

async function seedDefaultAgents() {
  await prisma.agent.create({
    data: {
      id: 'support-copilot-001',
      agentName: 'Support Copilot',
      role: 'support',
      tone: 'professional',
      securityLevel: 'strict',
      publicKey: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      systemPrompt: compileSystemPrompt('support', 'professional', 'strict'),
      invokeCount: 0,
      status: 'ACTIVE',
      feeUsdc: 0,
    },
  });
  await ensureAcademicPeerSeed();
}

/** Local/lab: keep seed agents free so create→chat works without paywall. */
export async function ensureLocalSeedAgentsFree(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  for (const id of SEED_AGENT_IDS) {
    const row = await prisma.agent.findUnique({ where: { id } });
    if (!row) continue;
    if (row.feeUsdc !== 0) {
      await prisma.agent.update({ where: { id }, data: { feeUsdc: 0 } });
    }
  }
}

export async function listAgents(): Promise<AgentRecord[]> {
  const rows = await prisma.agent.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toRecord);
}

/** Agents owned by a user (via AgentOwnership). Seeds shown if user has none yet. */
export async function listAgentsForUser(userId?: string | null): Promise<AgentRecord[]> {
  if (!userId) return listAgents();
  const owned = await prisma.agentOwnership.findMany({
    where: { userId },
    include: { agent: true },
    orderBy: { createdAt: 'desc' },
  });
  if (owned.length === 0) {
    const seeds = await prisma.agent.findMany({
      where: { id: { in: [...SEED_AGENT_IDS] } },
      orderBy: { createdAt: 'desc' },
    });
    return seeds.map(toRecord);
  }
  return owned.map((o) => toRecord(o.agent));
}

export async function getAgent(id: string): Promise<AgentRecord | undefined> {
  const a = await prisma.agent.findUnique({ where: { id } });
  return a ? toRecord(a) : undefined;
}

export async function putAgent(
  agent: AgentRecord,
  opts?: { ownerUserId?: string; ownerEmail?: string }
): Promise<AgentRecord> {
  const fee =
    typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : 0.001;

  const saved = await prisma.agent.upsert({
    where: { id: agent.id },
    create: {
      id: agent.id,
      tenantId: agent.tenantId || null,
      agentName: agent.agentName || null,
      role: agent.role,
      customRole: agent.customRole || null,
      tone: agent.tone,
      securityLevel: agent.securityLevel,
      publicKey: agent.publicKey,
      systemPrompt: agent.systemPrompt,
      invokeCount: agent.invokeCount || 0,
      googleDriveFolderId: agent.googleDriveFolderId || null,
      vertexDataStoreId: agent.vertexDataStoreId || null,
      vertexEngineId: agent.vertexEngineId || null,
      aiAppType: agent.aiAppType || 'search_docs',
      dataSourceType: agent.dataSourceType || 'none',
      websiteUri: agent.websiteUri || null,
      gcsUri: agent.gcsUri || null,
      secretManagerPath: agent.secretManagerPath || null,
      status: agent.status || 'ACTIVE',
      feeUsdc: fee,
    },
    update: {
      tenantId: agent.tenantId || null,
      agentName: agent.agentName || null,
      role: agent.role,
      customRole: agent.customRole || null,
      tone: agent.tone,
      securityLevel: agent.securityLevel,
      publicKey: agent.publicKey,
      systemPrompt: agent.systemPrompt,
      invokeCount: agent.invokeCount || 0,
      googleDriveFolderId: agent.googleDriveFolderId || null,
      vertexDataStoreId: agent.vertexDataStoreId || null,
      vertexEngineId: agent.vertexEngineId || null,
      aiAppType: agent.aiAppType || 'search_docs',
      dataSourceType: agent.dataSourceType || 'none',
      websiteUri: agent.websiteUri || null,
      gcsUri: agent.gcsUri || null,
      secretManagerPath: agent.secretManagerPath || null,
      status: agent.status || 'ACTIVE',
      feeUsdc: fee,
    },
  });

  const record = toRecord(saved);
  if (opts?.ownerUserId) {
    const { ensureOwnership } = await import('./catalog-db.js');
    await ensureOwnership(opts.ownerUserId, record.id, 'owner');
  }
  await syncListing(record, { userId: opts?.ownerUserId, email: opts?.ownerEmail });
  return record;
}

export async function bumpInvoke(id: string): Promise<void> {
  await prisma.agent.update({
    where: { id },
    data: { invokeCount: { increment: 1 } },
  });
}

export async function deleteAgent(id: string): Promise<void> {
  const { unlistCatalogAgent } = await import('./catalog-db.js');
  await unlistCatalogAgent(id);
  await prisma.agent.delete({ where: { id } }).catch(() => undefined);
}

export type AgentPatch = {
  agentName?: string;
  role?: string;
  customRole?: string | null;
  tone?: string;
  securityLevel?: string;
  fee?: number;
  status?: string;
  googleDriveFolderId?: string | null;
};
