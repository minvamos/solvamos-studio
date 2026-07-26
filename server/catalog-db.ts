/**
 * Sync runtime Agent → CatalogAgent (public discovery SoT in Postgres).
 * Catalog service reads the same CatalogAgent table.
 */

import { prisma } from './db.js';
import type { AgentRecord } from './agents-store.js';
import { config } from './config.js';

function networkAndMint() {
  const network = (config as any).paymentNetwork || process.env.PAYMENT_NETWORK || 'devnet';
  const usdcMint =
    process.env.USDC_MINT ||
    (network === 'mainnet-beta'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  return { network: String(network), usdcMint };
}

export type CatalogSyncOpts = {
  baseUrl?: string;
  ownerUserId?: string | null;
  ownerEmail?: string | null;
  description?: string;
  status?: 'listed' | 'unlisted' | 'paused';
};

export async function upsertCatalogAgentFromRecord(
  agent: AgentRecord,
  opts: CatalogSyncOpts = {}
) {
  let base = (opts.baseUrl || config.appUrl || '').replace(/\/$/, '');
  if (config.isProd && /localhost|127\.0\.0\.1/i.test(base)) {
    console.warn('[catalog-db] refusing localhost baseUrl in production; using APP_URL');
    base = (config.appUrl || '').replace(/\/$/, '');
  }
  if (config.isProd && /localhost|127\.0\.0\.1/i.test(base)) {
    throw new Error('APP_URL must be a public HTTPS origin in production');
  }
  // External AI fetchers reject mixed-content / plaintext agent-card URLs.
  if (/^http:\/\//i.test(base) && !/localhost|127\.0\.0\.1/i.test(base)) {
    base = base.replace(/^http:\/\//i, 'https://');
  }
  const fee =
    typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : 0;
  const { network, usdcMint } = networkAndMint();
  const protocol = fee > 0 ? 'x402 / MPP' : 'free';
  const catalogId = `solvamos_${agent.id}`;
  const originInvokeUrl = base ? `${base}/api/agents/${encodeURIComponent(agent.id)}/invoke` : '';
  // Paid agents MUST publish the pay-gateway URL (path A). Studio origin is not a paywall.
  const gatewayBase = (config.payGatewayUrl || '').replace(/\/$/, '');
  const gatewayOk =
    config.usePayGateway &&
    !!gatewayBase &&
    !/127\.0\.0\.1|localhost/i.test(gatewayBase);
  if (fee > 0 && config.isProd && !gatewayOk) {
    throw new Error(
      'Paid agents require a public PAY_GATEWAY_URL (USE_PAY_GATEWAY=true). Catalog will not list Studio-origin paywalls.'
    );
  }
  const invokeUrl =
    fee > 0 && gatewayOk
      ? `${gatewayBase}/v1/agents/${encodeURIComponent(agent.id)}/invoke`
      : originInvokeUrl;
  const agentCardUrl = base ? `${base}/api/agents/${encodeURIComponent(agent.id)}/agent-card` : null;
  const title = agent.agentName || agent.id;
  const roleLabel = String(agent.customRole || agent.role || '').trim();
  const toneLabel = String(agent.tone || '').trim();
  const userDescription = String(opts.description || agent.description || '').trim();
  // pay.sh-style: human description + explicit use_case for agent discovery
  const description =
    userDescription ||
    `${title} — SolVamos agent${roleLabel ? ` (${roleLabel})` : ''}${
      toneLabel ? `, tone: ${toneLabel}` : ''
    }.`;
  const useCase =
    roleLabel || userDescription
      ? `Use for ${roleLabel || 'task-specific assistance'}${
          userDescription ? `: ${userDescription.slice(0, 220)}` : '.'
        }`
      : `Use for SolVamos RAG / A2A assistance via ${protocol}.`;

  // Machine-readable endpoint list must mirror the ACTUAL public invoke path:
  // paid → gateway /v1 path, free → Studio origin /api path.
  const endpointPath =
    fee > 0 && gatewayOk
      ? `/v1/agents/${agent.id}/invoke`
      : `/api/agents/${agent.id}/invoke`;
  const settlement =
    fee > 0
      ? {
          seller_share: 1 - config.platformFeeShare,
          platform_share: config.platformFeeShare,
          seller_wallet: agent.publicKey,
          treasury_wallet: config.platformTreasuryPubkey,
        }
      : undefined;
  const endpoints = invokeUrl
    ? [
        {
          method: 'GET',
          path: endpointPath,
          description: 'Invoke with ?prompt=…',
          price_usdc: fee,
          payment_protocol: protocol,
          ...(settlement ? { settlement } : {}),
        },
        {
          method: 'POST',
          path: endpointPath,
          description: 'Invoke with JSON { "prompt": "…" }',
          price_usdc: fee,
          payment_protocol: protocol,
          ...(settlement ? { settlement } : {}),
        },
      ]
    : [];

  return prisma.catalogAgent.upsert({
    where: { agentId: agent.id },
    create: {
      catalogId,
      agentId: agent.id,
      fqn: `solvamos/${agent.id}`,
      title,
      description,
      useCase,
      category: 'ai_ml',
      role: agent.role,
      tone: agent.tone,
      invokeUrl: invokeUrl || `pending://${agent.id}`,
      originInvokeUrl: originInvokeUrl || null,
      agentCardUrl,
      feeUsdc: fee,
      token: 'USDC',
      network,
      usdcMint,
      paymentProtocol: protocol,
      recipientWallet: agent.publicKey,
      tags: ['solvamos', 'a2a', 'x402', agent.role, agent.tone].filter(Boolean) as string[],
      source: 'studio',
      studioOrigin: base || null,
      tenantId: agent.tenantId || null,
      ownerUserId: opts.ownerUserId || null,
      ownerEmail: opts.ownerEmail || null,
      status: opts.status || 'listed',
      endpoints,
    },
    update: {
      title,
      description,
      useCase,
      role: agent.role,
      tone: agent.tone,
      invokeUrl: invokeUrl || undefined,
      originInvokeUrl: originInvokeUrl || null,
      agentCardUrl,
      feeUsdc: fee,
      network,
      usdcMint,
      paymentProtocol: protocol,
      recipientWallet: agent.publicKey,
      tags: ['solvamos', 'a2a', 'x402', agent.role, agent.tone].filter(Boolean) as string[],
      studioOrigin: base || null,
      tenantId: agent.tenantId || null,
      ownerUserId: opts.ownerUserId !== undefined ? opts.ownerUserId : undefined,
      ownerEmail: opts.ownerEmail !== undefined ? opts.ownerEmail : undefined,
      status: opts.status || 'listed',
      endpoints,
    },
  });
}

export async function ensureOwnership(userId: string, agentId: string, role = 'owner') {
  return prisma.agentOwnership.upsert({
    where: { userId_agentId: { userId, agentId } },
    create: { userId, agentId, role },
    update: { role },
  });
}

export async function unlistCatalogAgent(agentId: string) {
  await prisma.catalogAgent
    .updateMany({ where: { agentId }, data: { status: 'unlisted' } })
    .catch(() => undefined);
}

/** Hard-remove CatalogAgent row (agent delete). */
export async function deleteCatalogAgentRow(agentId: string) {
  await prisma.catalogAgent.deleteMany({ where: { agentId } }).catch(() => undefined);
}

export async function userCanManageAgent(
  userId: string | undefined | null,
  agentId: string
): Promise<boolean> {
  if (!userId) return false;
  const row = await prisma.agentOwnership.findFirst({
    where: { userId, agentId, role: { in: ['owner', 'editor'] } },
  });
  return !!row;
}

/** Backfill CatalogAgent rows for every Agent missing a listing (e.g. after migrate). */
export async function syncAllAgentsToCatalog(opts?: { baseUrl?: string }): Promise<number> {
  const agents = await prisma.agent.findMany();
  let n = 0;
  const seedIds = new Set(['support-copilot-001', 'academic-research-001']);
  for (const a of agents) {
    const ownership = await prisma.agentOwnership.findFirst({
      where: { agentId: a.id, role: 'owner' },
      include: { user: true },
    });
    const isSeed = seedIds.has(a.id);
    // Seeds never appear on marketplace. User agents stay listed unless paused/error.
    const paused =
      a.status === 'PAUSED' || a.status === 'ERROR' || a.status === 'paused';
    const listStatus = isSeed ? 'unlisted' : paused ? 'paused' : 'listed';
    await upsertCatalogAgentFromRecord(
      {
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
        status: a.status,
        fee: a.feeUsdc,
        perCallPriceUsdc: a.feeUsdc,
        description: (a as any).description || undefined,
      },
      {
        baseUrl: opts?.baseUrl,
        description: (a as any).description || undefined,
        ownerUserId: ownership?.userId || null,
        ownerEmail: ownership?.user?.email || null,
        status: listStatus,
      }
    );
    n += 1;
  }
  return n;
}
