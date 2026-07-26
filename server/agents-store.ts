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
  /** specialized = AI Applications Answer; autonomous = Gemini + Data Store RAG */
  runtimeMode?: 'specialized' | 'autonomous' | string;
  /** Catalog-facing description for discovery / A2A peer matching */
  description?: string;
  /** Free-form instructions appended into compiled systemPrompt */
  customInstructions?: string;
  /** Catalog A2A peer escalation (free then paid) */
  a2aPeersEnabled?: boolean;
  websiteUri?: string;
  gcsUri?: string;
  secretManagerPath?: string;
  status?: 'CREATING' | 'INDEXING' | 'ACTIVE' | 'PAUSED' | 'ERROR' | string;
  fee?: number;
  perCallPriceUsdc?: number;
  /** A2A spend policy — per-call cap (USDC). null → platform default */
  maxSpendPerCallUsdc?: number;
  /** A2A spend policy — daily budget (USDC, UTC day). null → platform default */
  dailyBudgetUsdc?: number;
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
    runtimeMode: ((a as any).runtimeMode as string) || 'specialized',
    description: (a as any).description || undefined,
    customInstructions: (a as any).customInstructions || undefined,
    a2aPeersEnabled: (a as any).a2aPeersEnabled !== false,
    websiteUri: (a as any).websiteUri || undefined,
    gcsUri: (a as any).gcsUri || undefined,
    secretManagerPath: a.secretManagerPath || undefined,
    status: a.status,
    fee: a.feeUsdc,
    perCallPriceUsdc: a.feeUsdc,
    maxSpendPerCallUsdc: (a as any).maxSpendPerCallUsdc ?? undefined,
    dailyBudgetUsdc: (a as any).dailyBudgetUsdc ?? undefined,
  };
}

async function syncListing(agent: AgentRecord, owner?: { userId?: string; email?: string }) {
  try {
    // Only pass owner fields when known — never wipe CatalogAgent.ownerUserId with null.
    await upsertCatalogAgentFromRecord(agent, {
      baseUrl: config.appUrl,
      description: agent.description,
      ...(owner?.userId
        ? { ownerUserId: owner.userId, ownerEmail: owner.email || null }
        : {}),
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
  // Anonymous callers must not see the full agent inventory (vault keys, prompts, Vertex IDs).
  if (!userId) return [];
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
  const runtimeMode =
    agent.runtimeMode === 'autonomous' || agent.runtimeMode === 'specialized'
      ? agent.runtimeMode
      : 'specialized';

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
      runtimeMode,
      description: agent.description || null,
      customInstructions: agent.customInstructions || null,
      a2aPeersEnabled: agent.a2aPeersEnabled !== false,
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
      runtimeMode,
      description: agent.description || null,
      customInstructions: agent.customInstructions || null,
      a2aPeersEnabled: agent.a2aPeersEnabled !== false,
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
  const { unlistCatalogAgent, deleteCatalogAgentRow } = await import('./catalog-db.js');
  await unlistCatalogAgent(id);
  await deleteCatalogAgentRow(id);
  await prisma.agent.delete({ where: { id } }).catch(() => undefined);
}

export type DestroyAgentResult = {
  agentId: string;
  dbDeleted: boolean;
  aiApp: {
    engineDeleted: boolean;
    dataStoreDeleted: boolean;
    skippedSharedLab: boolean;
    details: string[];
  };
  vault: { deleted: boolean; detail: string };
  corpusDeleted: boolean;
  catalogUnlisted: boolean;
  reclaim?: import('./pay-payer.js').VaultReclaimResult;
};

/**
 * Full teardown: vault reclaim → AI App + datastore, vault secret, corpus, catalog, DB.
 * @param opts.softReclaim  create-failure cleanup — log reclaim errors but continue teardown
 */
export async function destroyAgent(
  id: string,
  opts?: { softReclaim?: boolean }
): Promise<DestroyAgentResult> {
  const agent = await getAgent(id);
  const { destroyAiApplication } = await import('./rag.js');
  const { deletePrivateKeyFromGCP } = await import('./vault.js');
  const { deleteLocalRagCorpus } = await import('./drive-ingest.js');
  const { unlistFromCatalog } = await import('./paysh-catalog.js');
  const { unlistCatalogAgent, deleteCatalogAgentRow } = await import('./catalog-db.js');
  const { reclaimAgentVaultOnDelete } = await import('./pay-payer.js');
  const { getPrimaryWallet } = await import('./wallets.js');

  // On-chain sweep BEFORE deleting the vault secret (signing key required).
  let reclaim: DestroyAgentResult['reclaim'];
  if (agent) {
    const ownership = await prisma.agentOwnership.findFirst({
      where: { agentId: id, role: 'owner' },
    });
    const catalog = await prisma.catalogAgent.findUnique({ where: { agentId: id } }).catch(() => null);
    const ownerUserId = ownership?.userId ?? catalog?.ownerUserId ?? null;
    const primary = ownerUserId ? await getPrimaryWallet(ownerUserId) : undefined;
    reclaim = await reclaimAgentVaultOnDelete({
      agent,
      ownerWallet: primary?.address,
    });
    if (!reclaim.ok && !reclaim.skipped) {
      if (opts?.softReclaim) {
        console.warn(
          `[vault_reclaim] soft-continue agent=${id}: ${reclaim.error || 'failed'}`,
          reclaim.details
        );
      } else {
        throw new Error(
          `[vault_reclaim] ${reclaim.error || 'failed'} — agent not deleted (register a wallet or retry)`
        );
      }
    }
  }

  const aiApp = agent
    ? await destroyAiApplication({
        dataStoreId: agent.vertexDataStoreId,
        engineId: agent.vertexEngineId,
      })
    : {
        engineDeleted: false,
        dataStoreDeleted: false,
        skippedSharedLab: false,
        details: ['Agent not found — skipped GCP delete'],
      };

  const vault = await deletePrivateKeyFromGCP(agent?.secretManagerPath);
  const corpusDeleted = deleteLocalRagCorpus(id);

  await unlistFromCatalog(id).catch(() => undefined);
  await unlistCatalogAgent(id);
  await deleteCatalogAgentRow(id);

  const del = await prisma.agent.delete({ where: { id } }).catch(() => null);

  return {
    agentId: id,
    dbDeleted: !!del,
    aiApp,
    vault,
    corpusDeleted,
    catalogUnlisted: true,
    reclaim,
  };
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
