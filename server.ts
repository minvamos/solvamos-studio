/**
 * SolVamos Studio — Express API + Vite (dev) / static (prod)
 * Cloud Run paywall gateway + Vertex AI Search RAG
 */

import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';

import { compileSystemPrompt } from './server/prompt.js';
import { savePrivateKeyToGCP, createAgentVaultKeypair } from './server/vault.js';
import {
  listSettlementsForUser,
  recordSettlement,
  aggregateSettlementsByAgent,
} from './server/settlements.js';
import { verifyPayment } from './server/payment.js';
import {
  payoutGatewaySale,
  getWalletBalances,
  ensureUsdcAtaForOwner,
} from './server/pay-payer.js';
import {
  parseGatewayReceiptHeaders,
  settleVerifiedGatewaySale,
} from './server/gateway-settle.js';
import { parseCallChainHeader } from './server/spend-policy.js';
import { payApiRouter } from './server/payapi.js';
import { ensureAiApplication, destroyAiApplication, syncLocalCorpusToVertex } from './server/rag.js';
import { aiApplicationsCatalog, getDataSourceType } from './server/ai-applications.js';
import { ingestDriveSourceForAgent } from './server/drive-ingest.js';
import { ingestLocalUploadsForAgent } from './server/local-ingest.js';
import { registerDriveAuthRoutes, isDriveAuthAvailable, isOAuthClientConfigured, requireGoogleSession, resolveSessionId, getSession } from './server/drive-oauth.js';
import { loadTenants, listTenants, getTenant, upsertTenant, userIsTenantAdmin } from './server/tenants.js';
import { provisionCustomerProject, plannedProjectId, buildProvisionPlan, resolveTenancyMode } from './server/provision.js';
import { provisionTenantCloudRun } from './server/cloudrun-provision.js';
import {
  config,
  assertProductionSafety,
  networkLabel,
  setPaymentNetwork,
  paymentNetworkInfo,
  normalizePaymentNetwork,
} from './server/config.js';
import {
  loadAgents,
  listAgents,
  listAgentsForUser,
  getAgent,
  putAgent,
  deleteAgent,
  destroyAgent,
  type AgentRecord,
} from './server/agents-store.js';
import { userCanManageAgent } from './server/catalog-db.js';
import {
  loadPayShCatalog,
  listCatalog,
  enrichCatalogListing,
  listCatalogForA2A,
  registerAgentOnPayShCatalog,
  getCatalogEntry,
  getCatalogPublishMode,
  setCatalogPublishMode,
  catalogPublishInfo,
  refreshCatalogFromRemote,
  hydrateCatalogRemote,
} from './server/paysh-catalog.js';
import {
  listWallets,
  addWallet,
  setPrimaryWallet,
  removeWallet,
  getPrimaryWallet,
  updateWalletLabel,
} from './server/wallets.js';
import { connectDb, prisma } from './server/db.js';
import { registerPlatformAuthRoutes } from './server/auth-routes.js';
import { getMeFromRequest } from './server/platform-auth.js';
import { sharedTenantId, ensureSharedCustomerTenant } from './server/tenant-seed.js';
import { runAgentInvoke, agentFeeUsdc, ensureListed } from './server/invoke-handler.js';
import { buildAgentCard } from './server/agent-card.js';
import { gatewayInvokeUrl } from './server/pay-client.js';
import {
  payGatewayStatus,
  restartManagedPayGateway,
  stopManagedPayGateway,
} from './server/pay-gateway-manager.js';
import { installConsoleCapture, serverLog, listDevLogs, clearDevLogs, devLogStats } from './server/dev-log.js';
import {
  listInvokeEvidence,
  getInvokeEvidence,
  clearInvokeEvidence,
  evidenceStats,
  countStudioOwnerTestsByAgent,
} from './server/invoke-evidence.js';

dotenv.config();
assertProductionSafety();
installConsoleCapture();

const app = express();
app.use(express.json({ limit: '20mb' }));

/** Public catalog CORS — for solvamos-catalog site / external clients (pay.sh/api style). */
app.use((req, res, next) => {
  const isPublicCatalog =
    req.path === '/api/catalog' ||
    req.path.startsWith('/api/catalog/') ||
    req.path === '/api/paysh/catalog' ||
    req.path.startsWith('/api/paysh/catalog/') ||
    /^\/api\/agents\/[^/]+\/agent-card$/.test(req.path);

  if (!isPublicCatalog) {
    next();
    return;
  }

  const origins = config.catalogCorsOrigins;
  const reqOrigin = String(req.headers.origin || '');
  const allow =
    origins.includes('*') || !reqOrigin
      ? '*'
      : origins.includes(reqOrigin)
        ? reqOrigin
        : origins[0] || '*';

  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Devnet buyer support: pay CLI balance shim + pay.sh API passthrough.
// Usage: PAY_API_URL=https://<studio-host>/payapi pay fetch "<gateway url>"
app.use('/payapi', payApiRouter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || req.path === '/healthz') {
      const level =
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      serverLog(level, 'http', `${req.method} ${req.originalUrl} → ${res.statusCode}`, {
        latencyMs: Date.now() - start,
        status: res.statusCode,
      });
    }
  });
  next();
});

loadPayShCatalog();
registerPlatformAuthRoutes(app);
registerDriveAuthRoutes(app);

/** Developer: ring-buffer server logs — login required (may contain secrets/paths). */
app.get('/api/dev/logs', requireGoogleSession, (req, res) => {
  const level = String(req.query.level || 'all') as any;
  const tag = req.query.tag ? String(req.query.tag) : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 300;
  res.json({
    status: 'success',
    stats: devLogStats(),
    logs: listDevLogs({ level, tag, q, limit }),
  });
});

app.delete('/api/dev/logs', requireGoogleSession, (_req, res) => {
  const cleared = clearDevLogs();
  res.json({ status: 'success', cleared });
});

/** Developer: invoke evidence (citations, referenced sites, tools) */
app.get('/api/dev/evidence', requireGoogleSession, (req, res) => {
  const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({
    status: 'success',
    stats: evidenceStats(),
    evidence: listInvokeEvidence({ agentId, q, limit }),
  });
});

app.get('/api/dev/evidence/:id', requireGoogleSession, (req, res) => {
  const row = getInvokeEvidence(req.params.id);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Evidence not found' });
    return;
  }
  res.json({ status: 'success', evidence: row });
});

app.delete('/api/dev/evidence', requireGoogleSession, (req, res) => {
  const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
  const cleared = clearInvokeEvidence(agentId);
  res.json({ status: 'success', cleared });
});

/** Cloud Run / GCLB health */
app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, product: config.product, version: config.version });
});

app.get('/readyz', (_req, res) => {
  const ready = !config.isProd || !!config.gcpProject;
  res.status(ready ? 200 : 503).json({
    ready,
    gcpProject: config.gcpProject || null,
    vaultFallback: config.allowLocalVaultFallback,
    paymentBypass: config.allowPaymentBypass,
  });
});

app.get('/api/status', async (req, res) => {
  const agents = await listAgents();
  const tenants = await listTenants();
  res.json({
    product: config.product,
    version: config.version,
    geminiConfigured: !!config.geminiApiKey,
    /** Developer API key present (optional). LLM can still run via Vertex ADC. */
    geminiApiKeyConfigured: !!config.geminiApiKey,
    /** Vertex Gemini via Cloud Run SA / ADC — primary production path. */
    vertexAdcProject: config.gcpProject || null,
    llmPreferredBackend: config.geminiApiKey
      ? 'gemini_api_key_or_vertex_adc'
      : config.gcpProject
        ? 'vertex_adc'
        : 'none',
    vertexProject: config.gcpProject || null,
    vertexSearchLocation: process.env.VERTEX_SEARCH_LOCATION || 'global',
    vertexAiLocation: process.env.VERTEX_AI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    ragBackends: ['vertex_search', 'drive_local', 'vertex_gemini_adc', 'gemini_api_key'],
    gcpProject: config.gcpProject || null,
    tenantId: config.tenantId || null,
    tier: config.tier,
    tenancyMode: resolveTenancyMode(),
    provisionMode: config.provisionMode,
    enableOrgProjectCreate: config.enableOrgProjectCreate,
    deployTenantCloudRun: config.deployTenantCloudRun,
    sharedCloudRunImage: config.sharedCloudRunImage || null,
    cloudRunRegion: config.cloudRunRegion,
    orgConfigured: !!(config.orgId || config.customersFolderId),
    billingConfigured: !!config.billingAccount,
    vertexDataStore: config.vertexDataStoreId || null,
    oauthConfigured: isOAuthClientConfigured(),
    driveAuthAvailable: isDriveAuthAvailable(),
    driveAuthMode: isOAuthClientConfigured() ? 'oauth' : 'adc',
    allowLocalVaultFallback: config.allowLocalVaultFallback,
    allowPaymentBypass: config.allowPaymentBypass,
    paymentNetwork: config.paymentNetwork,
    networkLabel: networkLabel(),
    solanaRpcUrl: config.solanaRpcUrl,
    usdcMint: config.usdcMint,
    platformFeeShare: config.platformFeeShare,
    platformTreasuryConfigured: !!config.platformTreasuryPubkey,
    platformTreasuryPubkey: config.platformTreasuryPubkey,
    sandboxProofsAllowed:
      config.allowLegacySandboxProof &&
      (config.paymentNetwork === 'localnet' || config.allowPaymentBypass),
    paySh: paymentNetworkInfo().paySh,
    payGateway: payGatewayStatus(),
    paymentModes: paymentNetworkInfo().modes,
    defaultAgentFeeUsdc: config.defaultAgentFeeUsdc,
    apiEndpoint: `${req.protocol}://${req.get('host')}`,
    totalAgents: agents.length,
    payShCatalogListings: listCatalog({ listedOnly: true }).length,
    catalogPublishMode: getCatalogPublishMode(),
    catalogPlatformOnly: true,
    catalogRemoteConfigured: false,
    catalogSiteUrl: config.catalogSiteUrl || null,
    catalogPageUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/marketplace`
      : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace',
    catalogApiUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/api/catalog`
      : `${req.protocol}://${req.get('host')}/api/catalog`,
    catalogMarketplaceUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/marketplace`
      : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace',
    a2aEnabled: true,
    totalTenants: tenants.length,
  });
});

app.get('/api/tenants', async (_req, res) => {
  res.json({
    status: 'success',
    tenancyMode: resolveTenancyMode(),
    provisionMode: config.provisionMode,
    sharedProjectId: config.gcpProject || null,
    data: await listTenants(),
  });
});

app.get('/api/tenants/plan/preview', (req, res) => {
  const tenantId = String(req.query.tenantId || 'demo');
  const displayName = String(req.query.displayName || tenantId);
  const plan = buildProvisionPlan({ tenantId, displayName });
  res.json({ status: 'success', plan });
});

app.post('/api/tenants', requireGoogleSession, async (req, res) => {
  try {
    const { tenantId, displayName, tier, byoProjectId, tenancyMode } = req.body;
    if (!tenantId || !displayName) {
      res.status(400).json({ status: 'error', message: 'tenantId and displayName required' });
      return;
    }
    const existingTenant = await getTenant(tenantId);
    if (existingTenant && !byoProjectId) {
      res.status(409).json({
        status: 'error',
        message: 'Tenant already exists',
        tenant: existingTenant,
      });
      return;
    }
    const plan = buildProvisionPlan({
      tenantId,
      displayName,
      tier,
      byoProjectId,
      tenancyMode,
    });
    const tenant = await provisionCustomerProject({
      tenantId,
      displayName,
      tier,
      byoProjectId,
      tenancyMode,
    });
    res.status(201).json({
      status: 'success',
      tenant,
      plan,
      plannedProjectId: plannedProjectId(tenantId),
      note:
        plan.tenancyMode === 'shared'
          ? 'Dev/shared: tenant metadata only — all workloads use GOOGLE_CLOUD_PROJECT'
          : 'Product/isolated: cust-* project under Org (live create needs billing + folder)',
      terraformHint:
        plan.tenancyMode === 'isolated'
          ? `infra/terraform customer-project project_id=${tenant.projectId}`
          : null,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/tenants/:id', async (req, res) => {
  const t = await getTenant(req.params.id);
  if (!t) {
    res.status(404).json({ status: 'error', message: 'Tenant not found' });
    return;
  }
  res.json({ status: 'success', tenant: t });
});

async function requireTenantAdminFromReq(
  req: express.Request,
  res: express.Response,
  tenantId: string
): Promise<boolean> {
  const me = await getMeFromRequest(req);
  if (!me.connected || !me.user?.id) {
    res.status(401).json({ status: 'error', message: '로그인이 필요합니다.' });
    return false;
  }
  const ok = await userIsTenantAdmin(me.user.id, tenantId);
  if (!ok) {
    res.status(403).json({
      status: 'error',
      message: '이 테넌트를 변경할 권한이 없습니다. (owner/admin 필요)',
    });
    return false;
  }
  return true;
}

app.patch('/api/tenants/:id', requireGoogleSession, async (req, res) => {
  const existing = await getTenant(req.params.id);
  if (!existing) {
    res.status(404).json({ status: 'error', message: 'Tenant not found' });
    return;
  }
  if (!(await requireTenantAdminFromReq(req, res, existing.tenantId))) return;
  const updated = await upsertTenant({ ...existing, ...req.body, tenantId: existing.tenantId });
  res.json({ status: 'success', tenant: updated });
});

/** Redeploy / create tenant Cloud Run in shared project (Lab). */
app.post('/api/tenants/:id/cloud-run', requireGoogleSession, async (req, res) => {
  try {
    const existing = await getTenant(req.params.id);
    if (!existing) {
      res.status(404).json({ status: 'error', message: 'Tenant not found' });
      return;
    }
    if (!(await requireTenantAdminFromReq(req, res, existing.tenantId))) return;
    const cloudRun = await provisionTenantCloudRun({
      tenantId: existing.tenantId,
      displayName: existing.displayName,
      tier: existing.tier,
    });
    const updated = await upsertTenant({
      ...existing,
      cloudRunUri: cloudRun.uri || existing.cloudRunUri,
      cloudRunServiceName: cloudRun.serviceName,
      cloudRunStatus: cloudRun.status,
      errorMessage: cloudRun.status === 'error' ? cloudRun.message : undefined,
      provisionNotes: [
        ...(existing.provisionNotes || []),
        ...(cloudRun.message ? [cloudRun.message] : []),
      ],
    });
    res.json({
      status: cloudRun.status === 'error' ? 'error' : 'success',
      cloudRun,
      tenant: updated,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

function publicBaseFromReq(req: express.Request): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol)
    .split(',')[0]
    .trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  return (config.appUrl || 'http://localhost:3000').replace(/\/$/, '');
}

app.get('/api/agents', async (req, res) => {
  const publicBase = publicBaseFromReq(req);
  await refreshCatalogFromRemote();
  const me = await getMeFromRequest(req);
  const agents = await listAgentsForUser(me.user?.id || null);
  const agentIds = agents.map((a) => a.id);
  const sellerShare = Math.min(1, Math.max(0, 1 - config.platformFeeShare));
  const studioTests = countStudioOwnerTestsByAgent(agentIds);
  const settlements = await aggregateSettlementsByAgent(agentIds);
  // Devnet vault balances for list cards (bounded concurrency).
  const balanceById: Record<string, { sol: number | null; usdc: number | null }> = {};
  if (config.paymentNetwork === 'devnet' && agents.length > 0) {
    const chunk = 6;
    for (let i = 0; i < agents.length; i += chunk) {
      const slice = agents.slice(i, i + chunk);
      const rows = await Promise.all(
        slice.map(async (agent) => {
          const bal = await getWalletBalances(agent.publicKey);
          return [agent.id, { sol: bal.sol, usdc: bal.usdc }] as const;
        })
      );
      for (const [id, bal] of rows) balanceById[id] = bal;
    }
  }
  res.json({
    status: 'success',
    platformFeeShare: config.platformFeeShare,
    sellerShare,
    catalogPageUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/marketplace`
      : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace',
    catalogApiUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/api/catalog`
      : `${publicBase}/api/catalog`,
    data: agents.map((agent) => {
      const fee = agentFeeUsdc(agent);
      const listing = getCatalogEntry(agent.id);
      const catalog = listing ? enrichCatalogListing(listing, publicBase) : null;
      const studioN = studioTests[agent.id] || 0;
      const paid = settlements[agent.id] || { paidCalls: 0, grossUsdc: 0 };
      // Paid agents: count verified settlements only (Studio tests never settle).
      // Free agents: strip Studio owner-tests from the DB counter.
      const billableInvokeCount =
        fee > 0
          ? paid.paidCalls
          : Math.max(0, (agent.invokeCount || 0) - studioN);
      // Seller take after platform cut — settlements store full call fee.
      const estSellerRevenueUsdc = Number((paid.grossUsdc * sellerShare).toFixed(6));
      const vault = balanceById[agent.id] || { sol: null, usdc: null };
      return {
        ...agent,
        fee,
        perCallPriceUsdc: fee,
        invokeCount: billableInvokeCount,
        rawInvokeCount: agent.invokeCount || 0,
        studioTestCount: studioN,
        paidCallCount: paid.paidCalls,
        estSellerRevenueUsdc,
        vaultSol: vault.sol,
        vaultUsdc: vault.usdc,
        payShCatalog: catalog,
        catalogPageUrl: catalog?.catalogPageUrl || (config.catalogSiteUrl
          ? `${config.catalogSiteUrl}/a/${encodeURIComponent(agent.id)}`
          : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace'),
        catalogApiUrl: catalog?.catalogApiUrl || (config.catalogSiteUrl
          ? `${config.catalogSiteUrl}/api/catalog`
          : `${publicBase}/api/catalog`),
        invokeUrl: catalog?.publicInvokeUrl || `${publicBase}/api/agents/${agent.id}/invoke`,
        agentCardUrl: catalog?.agentCardUrl || `${publicBase}/api/agents/${agent.id}/agent-card`,
      };
    }),
  });
});

app.get('/api/ai-applications/catalog', (_req, res) => {
  res.json({ status: 'success', ...aiApplicationsCatalog() });
});

async function walletUserIdFromReq(
  req: express.Request,
  res: express.Response
): Promise<string | null> {
  const me = await getMeFromRequest(req);
  if (!me.connected || !me.user) {
    res.status(401).json({ status: 'error', message: 'Login required' });
    return null;
  }
  return me.user.id;
}

app.get('/api/wallets', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const wallets = await listWallets(userId);
    res.json({
      status: 'success',
      primary: (await getPrimaryWallet(userId)) || null,
      data: wallets,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/wallets', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const { address, label, source, makePrimary } = req.body || {};
    if (!address) {
      res.status(400).json({ status: 'error', message: 'address required' });
      return;
    }
    const wallet = await addWallet(userId, {
      address: String(address),
      label: label ? String(label) : undefined,
      source: source ? String(source) : 'manual',
      makePrimary: makePrimary !== false,
    });
    res.status(201).json({
      status: 'success',
      wallet,
      primary: (await getPrimaryWallet(userId)) || null,
      data: await listWallets(userId),
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/wallets/:id/primary', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const wallet = await setPrimaryWallet(userId, req.params.id);
    res.json({
      status: 'success',
      wallet,
      primary: wallet,
      data: await listWallets(userId),
    });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
});

app.patch('/api/wallets/:id', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const wallet = await updateWalletLabel(userId, req.params.id, String(req.body?.label || ''));
    res.json({ status: 'success', wallet, data: await listWallets(userId) });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/wallets/:id', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const data = await removeWallet(userId, req.params.id);
    res.json({
      status: 'success',
      primary: (await getPrimaryWallet(userId)) || null,
      data,
    });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
});

app.get('/api/settlements', async (req, res) => {
  try {
    const userId = await walletUserIdFromReq(req, res);
    if (!userId) return;
    const data = await listSettlementsForUser(userId);
    res.json({ status: 'success', data });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** Public marketplace lives on solvamos-catalog — never serve a Studio duplicate UI. */
app.get('/catalog', (_req, res) => {
  const dest = config.catalogSiteUrl
    ? `${config.catalogSiteUrl}/marketplace`
    : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace';
  res.redirect(302, dest);
});
app.get('/catalog/*', (_req, res) => {
  const dest = config.catalogSiteUrl
    ? `${config.catalogSiteUrl}/marketplace`
    : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace';
  res.redirect(302, dest);
});

app.post('/api/agents/create', requireGoogleSession, async (req, res) => {
  let createdAgentId: string | null = null;
  try {
    const {
      role,
      tone,
      securityLevel,
      customRole,
      googleDriveFolderId,
      tenantId: bodyTenantId,
      agentName,
      perCallPriceUsdc,
      fee,
      aiAppType,
      dataSourceType,
      runtimeMode: bodyRuntimeMode,
      customInstructions,
      websiteUri,
      gcsUri,
      localFiles,
    } = req.body;

    if (!role || !tone || !securityLevel) {
      res.status(400).json({
        status: 'error',
        message: 'Missing parameters: role, tone, and securityLevel are required.',
      });
      return;
    }

    const runtimeMode =
      bodyRuntimeMode === 'autonomous' ? 'autonomous' : 'specialized';
    const customInstructionsText =
      typeof customInstructions === 'string' ? customInstructions.trim() : '';

    const me = await getMeFromRequest(req);
    const sid = me.sessionId || (await resolveSessionId(req));
    const authSession = sid ? getSession(sid) : undefined;

    await ensureSharedCustomerTenant();
    const tenantId =
      me.user?.tenantId ||
      bodyTenantId ||
      authSession?.tenantId ||
      sharedTenantId() ||
      config.tenantId ||
      undefined;

    // User wallet = operator only (funding / display). Never agent vault.
    const userPrimary = me.user?.id ? await getPrimaryWallet(me.user.id) : undefined;

    const sourceMeta = getDataSourceType(dataSourceType);
    const localFileList = Array.isArray(localFiles) ? localFiles : [];
    const hasLocalFiles = localFileList.length > 0;
    const resolvedSource =
      sourceMeta.id === 'google_drive' || googleDriveFolderId
        ? 'google_drive'
        : hasLocalFiles || sourceMeta.id === 'local_upload'
          ? 'local_upload'
          : sourceMeta.id;
    const needsDrive = resolvedSource === 'google_drive' && !!googleDriveFolderId;
    const needsLocal = resolvedSource === 'local_upload' && hasLocalFiles;

    if (needsDrive && !sid) {
      res.status(401).json({
        status: 'error',
        message: 'Drive 연동이 필요합니다. 마이페이지에서 Google을 연결하세요.',
      });
      return;
    }

    // Agent vault = dedicated keypair per agent (security boundary)
    const agentId = `${role}-${tone}-${Math.random().toString(36).substr(2, 6)}`;
    createdAgentId = agentId;
    const vaultKeys = createAgentVaultKeypair();
    const publicKey = vaultKeys.publicKey;
    const secretKeyBase64 = vaultKeys.secretKeyBase64;
    const vaultMode = 'agent_vault' as const;

    const systemPrompt = compileSystemPrompt(
      role,
      tone,
      securityLevel,
      customRole,
      customInstructionsText || undefined
    );

    const parsedFeeEarly =
      typeof fee === 'number'
        ? fee
        : typeof perCallPriceUsdc === 'number'
          ? perCallPriceUsdc
          : 0;

    const pipeline: { step: string; status: 'ok' | 'error'; detail: string }[] = [];
    const failCreate = (step: string, detail: string): never => {
      serverLog('error', 'create', `${step} failed — aborting agent create`, { agentId, detail });
      pipeline.push({ step, status: 'error', detail });
      throw new Error(`[${step}] ${detail}`);
    };
    const okStep = (step: string, detail: string) => {
      serverLog('info', 'create', `${step}: ${detail}`, { agentId });
      pipeline.push({ step, status: 'ok', detail });
    };

    okStep(
      'tenant_bind',
      `tenant=${tenantId} project=${config.gcpProject || 'n/a'} mode=${runtimeMode}`
    );

    // Empty datastore is allowed — customers may create an agent first and add knowledge later.
    if (resolvedSource === 'google_drive' && !googleDriveFolderId) {
      serverLog('info', 'create', 'google_drive with no folder — empty datastore + app', {
        agentId,
      });
    }
    if (resolvedSource === 'local_upload' && !hasLocalFiles) {
      serverLog('info', 'create', 'local_upload with no files — empty datastore + app', {
        agentId,
      });
    }
    if (resolvedSource === 'website_url' && !websiteUri) {
      serverLog('info', 'create', 'website_url with no URI — empty datastore + app', { agentId });
    }

    // Persist vault before DB row so create never leaves CREATING orphans on vault failure
    const gcpStorage = await savePrivateKeyToGCP(agentId, secretKeyBase64);
    okStep(
      'agent_vault',
      `Dedicated agent vault ${publicKey.slice(0, 4)}…${publicKey.slice(-4)} (user wallet ${
        userPrimary?.address ? userPrimary.address.slice(0, 4) + '…' : 'none'
      })`
    );
    if (gcpStorage.mock) {
      // Intentional local-only path — still recorded loudly in server logs.
      serverLog(
        'warn',
        'create',
        'Vault stored via LOCAL MOCK (ALLOW_LOCAL_VAULT_FALLBACK). Production must use Secret Manager.',
        { agentId, path: gcpStorage.path }
      );
      okStep('vault_persist', `LOCAL MOCK vault: ${gcpStorage.path}`);
    } else {
      okStep('vault_persist', `Secret Manager: ${gcpStorage.path}`);
    }

    // USDC ATA must exist before pay-gateway can accept MPP splits for this vault.
    // Operator/settlement wallet pays rent so payment works immediately (no boot wait).
    const ataEnsure = await ensureUsdcAtaForOwner(publicKey);
    if (ataEnsure.ok) {
      okStep(
        'usdc_ata',
        ataEnsure.created
          ? `created ${ataEnsure.ata}${ataEnsure.signature ? ` sig=${ataEnsure.signature.slice(0, 12)}…` : ''}`
          : `exists ${ataEnsure.ata}`
      );
    } else if (parsedFeeEarly > 0) {
      failCreate('usdc_ata', ataEnsure.error || 'USDC ATA create failed');
    } else {
      serverLog('warn', 'create', `USDC ATA skipped/failed (free agent): ${ataEnsure.error}`, {
        agentId,
        publicKey,
      });
      pipeline.push({
        step: 'usdc_ata',
        status: 'error',
        detail: ataEnsure.error || 'skipped',
      });
    }

    // Persist agent row early so RagDocument FK / catalog can attach
    await putAgent({
      id: agentId,
      tenantId,
      agentName,
      role,
      customRole,
      tone,
      securityLevel,
      publicKey,
      systemPrompt,
      created: new Date().toISOString(),
      invokeCount: 0,
      googleDriveFolderId: googleDriveFolderId ? String(googleDriveFolderId) : undefined,
      aiAppType: aiAppType || 'search_docs',
      dataSourceType: resolvedSource,
      runtimeMode,
      customInstructions: customInstructionsText || undefined,
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
      secretManagerPath: gcpStorage.path,
      status: 'CREATING',
      fee: parsedFeeEarly,
      perCallPriceUsdc: parsedFeeEarly,
    });
    okStep('agent_record_draft', agentId);

    let vertexDataStoreId: string | undefined;
    let vertexEngineId: string | undefined;
    let indexingStatus: AgentRecord['status'] = 'ACTIVE';
    let driveIngest: { docs: number; message?: string } | null = null;

    // Specialized: Engine + Data Store. Autonomous: Data Store only (Gemini + retrieve).
    // Website URL forces PUBLIC_WEBSITE app type so site/* indexing can attach.
    const provisionAppType =
      resolvedSource === 'website_url' || websiteUri ? 'website' : aiAppType || 'search_docs';
    serverLog('info', 'create', 'Provisioning AI Applications / Data Store', {
      agentId,
      provisionAppType,
      resolvedSource,
      runtimeMode,
    });
    const aiApp = await ensureAiApplication({
      displayName: agentName || agentId,
      appType: provisionAppType,
      dataSourceType: resolvedSource === 'website_url' || websiteUri ? 'website_url' : resolvedSource,
      driveFolderId: googleDriveFolderId ? String(googleDriveFolderId) : undefined,
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
      runtimeMode,
      skipEngine: runtimeMode === 'autonomous',
    });
    vertexDataStoreId = aiApp.dataStoreId;
    vertexEngineId = runtimeMode === 'autonomous' ? undefined : aiApp.engineId;

    const provisionFailed =
      aiApp.status === 'error' ||
      aiApp.status === 'pending' ||
      !aiApp.dataStoreId ||
      (runtimeMode === 'specialized' && !aiApp.engineId);
    if (provisionFailed) {
      if (aiApp.dataStoreId) {
        await destroyAiApplication({
          dataStoreId: aiApp.dataStoreId,
          engineId: aiApp.engineId,
        }).catch((err: any) =>
          serverLog('warn', 'create', `orphan AI App cleanup: ${err?.message || err}`)
        );
      }
      failCreate(
        'ai_applications',
        runtimeMode === 'autonomous'
          ? `Data Store 생성 실패: ${
              aiApp.message || 'Discovery Engine data store missing'
            }. GOOGLE_CLOUD_PROJECT·ADC·discoveryengine.googleapis.com·Discovery Engine Admin IAM을 확인하세요.`
          : `AI Applications 앱/엔진 생성 실패: ${
              aiApp.message || 'Discovery Engine engine/app missing'
            }. GOOGLE_CLOUD_PROJECT·ADC·discoveryengine.googleapis.com·Discovery Engine Admin IAM을 확인하세요.`
      );
    }
    indexingStatus = 'ACTIVE';
    okStep(
      'ai_applications',
      runtimeMode === 'autonomous'
        ? `${aiApp.message || aiApp.dataStoreId} (datastore-only)${
            aiApp.sourceNote ? ` · ${aiApp.sourceNote}` : ''
          }`
        : `${aiApp.message || aiApp.dataStoreId} engine=${aiApp.engineId}${
            aiApp.sourceNote ? ` · ${aiApp.sourceNote}` : ''
          }`
    );

    if (needsDrive && sid) {
      let corpus;
      try {
        corpus = await ingestDriveSourceForAgent({
          sessionId: sid,
          agentId,
          driveSourceId: String(googleDriveFolderId),
        });
      } catch (err: any) {
        failCreate(
          'drive_rag_ingest',
          err?.message || 'Drive ingest failed — Google 연동/권한을 확인하세요'
        );
      }
      driveIngest = { docs: corpus.docs.length };
      if (corpus.docs.length === 0) {
        okStep(
          'drive_rag_ingest',
          'Drive 문서 0건 — 빈 데이터스토어로 생성 (나중에 지식 추가 가능)'
        );
      } else {
        okStep('drive_rag_ingest', `Ingested ${corpus.docs.length} Drive doc(s)`);
        if (!vertexDataStoreId) {
          failCreate('vertex_import', 'vertexDataStoreId missing after AI Applications provision');
        }
        let sync;
        try {
          sync = await syncLocalCorpusToVertex(agentId, vertexDataStoreId);
        } catch (err: any) {
          failCreate('vertex_import', err?.message || 'Vertex import failed');
        }
        if (sync.imported <= 0) {
          failCreate('vertex_import', sync.message || 'Vertex import imported 0 documents');
        }
        okStep('vertex_import', sync.message);
      }
      indexingStatus = 'ACTIVE';
    } else if (needsLocal) {
      let corpus;
      try {
        corpus = await ingestLocalUploadsForAgent({
          agentId,
          files: localFileList,
        });
      } catch (err: any) {
        failCreate('local_upload_ingest', err?.message || 'Local upload ingest failed');
      }
      driveIngest = {
        docs: corpus.docs.length,
        message: corpus.skipped?.length
          ? `skipped: ${corpus.skipped.slice(0, 3).join('; ')}`
          : undefined,
      };
      if (corpus.docs.length === 0) {
        okStep(
          'local_upload_ingest',
          `추출 문서 0건 — 빈 데이터스토어로 생성${
            corpus.skipped?.length ? ` (${corpus.skipped.slice(0, 2).join('; ')})` : ''
          }`
        );
      } else {
        okStep('local_upload_ingest', `Ingested ${corpus.docs.length} local file(s)`);
        if (!vertexDataStoreId) {
          failCreate('vertex_import', 'vertexDataStoreId missing after AI Applications provision');
        }
        let sync;
        try {
          sync = await syncLocalCorpusToVertex(agentId, vertexDataStoreId);
        } catch (err: any) {
          failCreate('vertex_import', err?.message || 'Vertex import failed');
        }
        if (sync.imported <= 0) {
          failCreate('vertex_import', sync.message || 'Vertex import imported 0 documents');
        }
        okStep('vertex_import', sync.message);
      }
      indexingStatus = 'ACTIVE';
    } else {
      okStep(
        'data_source',
        aiApp.sourceNote ||
          `Source=${resolvedSource} — empty datastore + app ready (add knowledge later)`
      );
    }

    const parsedFee = parsedFeeEarly;

    const newAgent: AgentRecord = {
      id: agentId,
      tenantId,
      agentName,
      role,
      customRole,
      tone,
      securityLevel,
      publicKey,
      systemPrompt,
      created: new Date().toISOString(),
      invokeCount: 0,
      googleDriveFolderId: googleDriveFolderId ? String(googleDriveFolderId) : undefined,
      vertexDataStoreId,
      vertexEngineId,
      aiAppType: aiApp.appType,
      dataSourceType: aiApp.dataSourceType,
      runtimeMode,
      customInstructions: customInstructionsText || undefined,
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
      secretManagerPath: gcpStorage.path,
      status: indexingStatus,
      fee: parsedFee,
      perCallPriceUsdc: parsedFee,
    };

    await putAgent(newAgent, {
      ownerUserId: me.user?.id,
      ownerEmail: me.user?.email,
    });
    okStep('agent_record', agentId);

    const tenant = tenantId ? await getTenant(String(tenantId)) : undefined;
    const runtimeBase =
      (tenant?.cloudRunUri && String(tenant.cloudRunUri).replace(/\/$/, '')) ||
      `${req.protocol}://${req.get('host')}`;

    let listing;
    try {
      listing = await registerAgentOnPayShCatalog(newAgent, {
        baseUrl: runtimeBase,
        description: req.body.description,
        // Catalog URL이 설정된 환경에서는 원격 게시 실패 = 생성 실패
        requireRemote: !!config.catalogSiteUrl,
      });
    } catch (err: any) {
      failCreate('paysh_catalog', err?.message || 'Catalog register failed');
    }
    const publicBase = publicBaseFromReq(req);
    const payShCatalog = enrichCatalogListing(listing, publicBase);
    okStep('paysh_catalog', `${payShCatalog.catalogId} · ${payShCatalog.catalogPageUrl}`);

    serverLog('info', 'create', `Agent create succeeded ${agentId}`, {
      engineId: vertexEngineId,
      dataStoreId: vertexDataStoreId,
      pipeline,
    });

    res.status(201).json({
      status: 'success',
      agentId,
      publicKey,
      agentVaultPubkey: publicKey,
      vaultMode,
      userWallet: userPrimary
        ? { address: userPrimary.address, label: userPrimary.label, role: 'operator_only' }
        : null,
      walletsSeparated: true,
      note:
        'Agent vault ≠ user wallet. Invoke/A2A paywall recipient is agentVaultPubkey only.',
      gcpVaultPath: gcpStorage.path,
      isGcpMocked: gcpStorage.mock,
      vertexDataStoreId,
      vertexEngineId,
      aiAppType: newAgent.aiAppType,
      dataSourceType: newAgent.dataSourceType,
      driveIngest,
      pipeline,
      agent: newAgent,
      payShCatalog,
      catalogPageUrl: payShCatalog.catalogPageUrl,
      catalogApiUrl: payShCatalog.catalogApiUrl,
      runtimeBase,
      cloudRunUri: tenant?.cloudRunUri || null,
      message: `Agent vault created ${publicKey.slice(0, 4)}…${publicKey.slice(-4)} (keys in Secret Manager${
        gcpStorage.mock ? ' / local fallback' : ''
      }). User wallet is separate.`,
    });
  } catch (err: any) {
    serverLog('error', 'create', `Agent create failed: ${err?.message || err}`, {
      agentId: createdAgentId,
    });
    if (createdAgentId) {
      // Full teardown (vault / partial AI App / catalog / DB) on create failure.
      // softReclaim: don't block cleanup if ATA close fails in localdev.
      await destroyAgent(createdAgentId, { softReclaim: true }).catch(async () => {
        await deleteAgent(createdAgentId);
      });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/agents/:id', requireGoogleSession, async (req, res) => {
  try {
    const agentId = req.params.id;
    const existing = await getAgent(agentId);
    if (!existing) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
      return;
    }

    const me = await getMeFromRequest(req);
    if (!me.user?.id) {
      res.status(401).json({ status: 'error', message: '로그인이 필요합니다.' });
      return;
    }
    const allowed = await userCanManageAgent(me.user.id, agentId);
    if (!allowed) {
      res.status(403).json({ status: 'error', message: '이 에이전트를 삭제할 권한이 없습니다.' });
      return;
    }

    const result = await destroyAgent(agentId);
    res.json({
      status: 'success',
      message:
        'Agent deleted (vault USDC→owner wallet, ATA rent→operator, AI App, vault secret, catalog, DB)',
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.patch('/api/agents/:id', requireGoogleSession, async (req, res) => {
  try {
    const existing = await getAgent(req.params.id);
    if (!existing) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
      return;
    }

    const me = await getMeFromRequest(req);
    if (!me.user?.id) {
      res.status(401).json({ status: 'error', message: '로그인이 필요합니다.' });
      return;
    }
    if (!(await userCanManageAgent(me.user.id, existing.id))) {
      res.status(403).json({ status: 'error', message: '이 에이전트를 수정할 권한이 없습니다.' });
      return;
    }

    const {
      role,
      tone,
      securityLevel,
      customRole,
      agentName,
      fee,
      perCallPriceUsdc,
      status,
      googleDriveFolderId,
      description,
      aiAppType,
      dataSourceType,
      runtimeMode: bodyRuntimeMode,
      customInstructions,
      websiteUri,
      gcsUri,
      localFiles,
    } = req.body || {};

    const nextRole = role || existing.role;
    const nextTone = tone || existing.tone;
    const nextSecurity = securityLevel || existing.securityLevel;
    const nextCustom =
      customRole !== undefined ? customRole || undefined : existing.customRole;
    const nextRuntimeMode =
      bodyRuntimeMode === 'autonomous' || bodyRuntimeMode === 'specialized'
        ? bodyRuntimeMode
        : existing.runtimeMode === 'autonomous'
          ? 'autonomous'
          : 'specialized';
    const nextCustomInstructions =
      customInstructions !== undefined
        ? typeof customInstructions === 'string'
          ? customInstructions.trim() || undefined
          : undefined
        : existing.customInstructions;
    const nextName = agentName !== undefined ? agentName : existing.agentName;
    const nextFee =
      typeof fee === 'number'
        ? fee
        : typeof perCallPriceUsdc === 'number'
          ? perCallPriceUsdc
          : existing.fee ?? existing.perCallPriceUsdc ?? 0;
    const nextStatus =
      status === 'PAUSED' || status === 'inactive' || status === 'paused'
        ? 'PAUSED'
        : status === 'ACTIVE' || status === 'active'
          ? 'ACTIVE'
          : existing.status || 'ACTIVE';
    const nextAiAppType = aiAppType || existing.aiAppType || 'search_docs';
    const localFileList = Array.isArray(localFiles) ? localFiles : [];
    const hasLocalFiles = localFileList.length > 0;
    const sourceMeta = getDataSourceType(
      dataSourceType || (hasLocalFiles ? 'local_upload' : existing.dataSourceType)
    );
    const nextWebsite =
      websiteUri !== undefined
        ? websiteUri
          ? String(websiteUri)
          : undefined
        : existing.websiteUri;
    const nextGcs =
      gcsUri !== undefined ? (gcsUri ? String(gcsUri) : undefined) : existing.gcsUri;

    const folderChanged =
      googleDriveFolderId !== undefined &&
      String(googleDriveFolderId || '') !== String(existing.googleDriveFolderId || '');
    const nextFolder =
      googleDriveFolderId !== undefined
        ? googleDriveFolderId
          ? String(googleDriveFolderId)
          : undefined
        : existing.googleDriveFolderId;
    const resolvedSource =
      sourceMeta.id === 'google_drive' || nextFolder
        ? 'google_drive'
        : hasLocalFiles || sourceMeta.id === 'local_upload'
          ? 'local_upload'
          : sourceMeta.id;

    let vertexDataStoreId = existing.vertexDataStoreId;
    let vertexEngineId = existing.vertexEngineId;
    let driveIngest: { docs: number; message?: string } | null = null;
    let indexingStatus = nextStatus;

    // Missing store (legacy agents) or Drive source change → ensure store (+ engine if specialized)
    if (!vertexDataStoreId || (folderChanged && nextFolder) || hasLocalFiles) {
      serverLog('info', 'update', 'Ensuring AI Applications / Data Store', {
        agentId: existing.id,
        folderChanged,
        hasLocalFiles,
        runtimeMode: nextRuntimeMode,
      });
      const aiApp = await ensureAiApplication({
        displayName: nextName || existing.id,
        appType: nextAiAppType,
        dataSourceType: resolvedSource,
        driveFolderId: nextFolder,
        websiteUri: nextWebsite,
        gcsUri: nextGcs,
        runtimeMode: nextRuntimeMode,
        skipEngine: nextRuntimeMode === 'autonomous',
      });
      const updateProvisionFailed =
        aiApp.status === 'error' ||
        !aiApp.dataStoreId ||
        (nextRuntimeMode === 'specialized' && !aiApp.engineId);
      if (updateProvisionFailed) {
        serverLog('error', 'update', 'AI Applications ensure failed', {
          agentId: existing.id,
          message: aiApp.message,
        });
        throw new Error(
          `[ai_applications] ${
            aiApp.message ||
            (nextRuntimeMode === 'autonomous'
              ? 'Data Store missing on update'
              : 'AI Applications engine/app missing on update')
          }`
        );
      }
      vertexDataStoreId = aiApp.dataStoreId;
      if (nextRuntimeMode === 'autonomous') {
        vertexEngineId = undefined;
      } else {
        vertexEngineId = aiApp.engineId || vertexEngineId;
      }
    } else if (nextRuntimeMode === 'autonomous') {
      // Switching to autonomous: keep store, drop engine requirement
      vertexEngineId = undefined;
    } else if (nextRuntimeMode === 'specialized' && vertexDataStoreId && !vertexEngineId) {
      const aiApp = await ensureAiApplication({
        displayName: nextName || existing.id,
        appType: nextAiAppType,
        dataSourceType: resolvedSource,
        driveFolderId: nextFolder,
        websiteUri: nextWebsite,
        gcsUri: nextGcs,
        runtimeMode: 'specialized',
      });
      if (aiApp.status === 'error' || !aiApp.engineId) {
        throw new Error(
          `[ai_applications] ${aiApp.message || 'Engine required for specialized mode'}`
        );
      }
      vertexEngineId = aiApp.engineId;
      vertexDataStoreId = aiApp.dataStoreId || vertexDataStoreId;
    }

    if (folderChanged && nextFolder) {
      const me = await getMeFromRequest(req);
      const sid = me.sessionId || (await resolveSessionId(req));
      if (!sid) {
        res.status(401).json({
          status: 'error',
          message: 'Drive 연동이 필요합니다. 마이페이지에서 Google을 연결하세요.',
        });
        return;
      }
      const corpus = await ingestDriveSourceForAgent({
        sessionId: sid,
        agentId: existing.id,
        driveSourceId: String(nextFolder),
      });
      driveIngest = { docs: corpus.docs.length };
      if (corpus.docs.length === 0) {
        // Empty folder is OK — keep empty datastore
        serverLog('info', 'update', 'Drive re-ingest: 0 docs — empty datastore kept', {
          agentId: existing.id,
        });
      } else {
        if (!vertexDataStoreId) {
          throw new Error('[vertex_import] vertexDataStoreId missing');
        }
        const sync = await syncLocalCorpusToVertex(existing.id, vertexDataStoreId);
        if (sync.imported <= 0) {
          throw new Error(`[vertex_import] ${sync.message || 'imported 0 documents'}`);
        }
        serverLog('info', 'update', 'Drive re-ingest ok', {
          agentId: existing.id,
          docs: corpus.docs.length,
          imported: sync.imported,
        });
      }
      indexingStatus = 'ACTIVE';
    } else if (hasLocalFiles) {
      const corpus = await ingestLocalUploadsForAgent({
        agentId: existing.id,
        files: localFileList,
        append: true,
      });
      driveIngest = {
        docs: corpus.docs.length,
        message: corpus.skipped?.length
          ? `skipped: ${corpus.skipped.slice(0, 3).join('; ')}`
          : undefined,
      };
      if (corpus.docs.length === 0) {
        serverLog('info', 'update', 'Local upload: 0 extractable docs — empty datastore kept', {
          agentId: existing.id,
          skipped: corpus.skipped?.slice(0, 3),
        });
      } else {
        if (!vertexDataStoreId) {
          throw new Error('[vertex_import] vertexDataStoreId missing');
        }
        const sync = await syncLocalCorpusToVertex(existing.id, vertexDataStoreId);
        if (sync.imported <= 0) {
          throw new Error(`[vertex_import] ${sync.message || 'imported 0 documents'}`);
        }
        serverLog('info', 'update', 'Local upload ingest ok', {
          agentId: existing.id,
          docs: corpus.docs.length,
          imported: sync.imported,
        });
      }
      indexingStatus = 'ACTIVE';
    }

    if (nextFee > 0 && existing.publicKey) {
      const ataEnsure = await ensureUsdcAtaForOwner(existing.publicKey);
      if (!ataEnsure.ok) {
        throw new Error(
          `[usdc_ata] ${ataEnsure.error || 'USDC ATA required before paid listing'}`
        );
      }
      serverLog('info', 'update', 'USDC ATA ready for paid agent', {
        agentId: existing.id,
        created: ataEnsure.created,
        ata: ataEnsure.ata,
      });
    }

    const updated: AgentRecord = {
      ...existing,
      agentName: nextName,
      role: nextRole,
      customRole: nextCustom,
      tone: nextTone,
      securityLevel: nextSecurity,
      systemPrompt: compileSystemPrompt(
        nextRole,
        nextTone,
        nextSecurity,
        nextCustom,
        nextCustomInstructions
      ),
      fee: nextFee,
      perCallPriceUsdc: nextFee,
      status: indexingStatus,
      googleDriveFolderId: nextFolder,
      vertexDataStoreId,
      vertexEngineId,
      aiAppType: nextAiAppType,
      dataSourceType: resolvedSource,
      runtimeMode: nextRuntimeMode,
      customInstructions: nextCustomInstructions,
      websiteUri: nextWebsite,
      gcsUri: nextGcs,
      // Vault pubkey never changes on edit
      publicKey: existing.publicKey,
      secretManagerPath: existing.secretManagerPath,
    };

    await putAgent(updated);

    const tenant = updated.tenantId ? await getTenant(String(updated.tenantId)) : undefined;
    const runtimeBase =
      (tenant?.cloudRunUri && String(tenant.cloudRunUri).replace(/\/$/, '')) ||
      `${req.protocol}://${req.get('host')}`;
    const listing = await registerAgentOnPayShCatalog(updated, {
      baseUrl: runtimeBase,
      description,
      requireRemote: !!config.catalogSiteUrl,
    });
    const payShCatalog = enrichCatalogListing(listing, publicBaseFromReq(req));

    serverLog('info', 'update', `Agent update succeeded ${updated.id}`);

    res.json({
      status: 'success',
      agent: updated,
      driveIngest,
      payShCatalog,
      catalogPageUrl: payShCatalog.catalogPageUrl,
      catalogApiUrl: payShCatalog.catalogApiUrl,
      updated: true,
      message: 'Agent updated (same id/vault; catalog metadata synced)',
    });
  } catch (err: any) {
    serverLog('error', 'update', `Agent update failed: ${err?.message || err}`);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/agents/preview-prompt', (req, res) => {
  const { role, tone, securityLevel, customRole, customInstructions } = req.body;
  const systemPrompt = compileSystemPrompt(
    role || 'support',
    tone || 'professional',
    securityLevel || 'strict',
    customRole,
    typeof customInstructions === 'string' ? customInstructions : undefined
  );
  res.json({ systemPrompt });
});

app.get('/api/agents/:id/balance', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ status: 'error', message: 'Agent not found' });
    return;
  }
  const listing = getCatalogEntry(agent.id);
  const balances =
    config.paymentNetwork === 'devnet'
      ? await getWalletBalances(agent.publicKey)
      : { sol: null, usdc: null, error: 'on-chain balance only on devnet' };
  res.json({
    status: 'success',
    agentId: agent.id,
    solanaPubkey: agent.publicKey,
    payShConnected: !!listing && listing.status === 'listed',
    payShCatalogId: listing?.catalogId || null,
    network: config.paymentNetwork,
    usdcMint: config.usdcMint,
    currentSolBalance: balances.sol,
    currentUsdcBalance: balances.usdc,
    balanceError: balances.error || null,
    topUp: {
      address: agent.publicKey,
      note: '에이전트 vault로 devnet SOL(수수료)과 USDC(A2A 결제)를 충전하세요.',
      solFaucet: 'https://faucet.solana.com',
      usdcFaucet: 'https://faucet.circle.com',
    },
  });
});

async function sendCatalogJson(req: express.Request, res: express.Response) {
  const publicBaseUrl = publicBaseFromReq(req);
  // Prefer live data from solvamos-catalog (source of truth).
  if (config.catalogSiteUrl) {
    try {
      const qs = new URLSearchParams();
      if (typeof req.query.tenantId === 'string') qs.set('tenantId', req.query.tenantId);
      const url = `${config.catalogSiteUrl}/api/catalog${qs.toString() ? `?${qs}` : ''}`;
      const upstream = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (upstream.ok) {
        const remote = (await upstream.json()) as any;
        const rows = Array.isArray(remote.data)
          ? remote.data
          : Array.isArray(remote.agents)
            ? remote.agents
            : [];
        res.json({
          status: 'success',
          protocol: 'solvamos / x402-mpp',
          catalog: 'solvamos-catalog',
          catalogUrl: `${config.catalogSiteUrl}/api/catalog`,
          publicPageUrl: `${config.catalogSiteUrl}/marketplace`,
          catalogSiteUrl: config.catalogSiteUrl,
          network: networkLabel(),
          paymentNetwork: config.paymentNetwork,
          paymentHint:
            'Paid agents: call invokeUrl with pay CLI (x402/MPP). Free agents: plain HTTP POST. Discovery source: solvamos-catalog.',
          ...catalogPublishInfo(),
          data: rows,
          agents: remote.agents,
        });
        return;
      }
    } catch (err: any) {
      console.warn('[catalog] proxy to catalog site failed', err?.message || err);
    }
  }

  await refreshCatalogFromRemote({ force: true });
  const data = listCatalog({ listedOnly: true }).map((entry) =>
    enrichCatalogListing(entry, publicBaseUrl)
  );
  res.json({
    status: 'success',
    protocol: 'solvamos / x402-mpp',
    catalog: config.catalogSiteUrl ? 'solvamos-catalog-cache' : 'solvamos-local-fallback',
    catalogUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/api/catalog`
      : `${publicBaseUrl}/api/catalog`,
    publicPageUrl: config.catalogSiteUrl
      ? `${config.catalogSiteUrl}/marketplace`
      : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace',
    catalogSiteUrl: config.catalogSiteUrl || null,
    network: networkLabel(),
    paymentNetwork: config.paymentNetwork,
    paymentHint:
      'Paid agents: call invokeUrl with pay CLI (x402/MPP). Free agents: plain HTTP POST.',
    ...catalogPublishInfo(),
    data,
  });
}

/** SolVamos platform catalog — A2A discovery (no official pay.sh registry). */
app.get('/api/catalog', sendCatalogJson);
/** @deprecated alias — prefer /api/catalog */
app.get('/api/paysh/catalog', sendCatalogJson);

/** Catalog mode is fixed to SolVamos platform-only. */
app.get('/api/catalog/mode', (_req, res) => {
  res.json({ status: 'success', ...catalogPublishInfo() });
});
app.get('/api/paysh/catalog/mode', (_req, res) => {
  res.json({ status: 'success', ...catalogPublishInfo() });
});

app.post('/api/catalog/mode', (req, res) => {
  const result = setCatalogPublishMode(String(req.body?.mode || ''));
  res.status(403).json({ status: 'error', message: result.error, ...catalogPublishInfo() });
});
app.post('/api/paysh/catalog/mode', (req, res) => {
  const result = setCatalogPublishMode(String(req.body?.mode || ''));
  res.status(403).json({ status: 'error', message: result.error, ...catalogPublishInfo() });
});

/** Local Lab payment mode + managed pay.sh gateway status. */
app.get('/api/payment/network', (_req, res) => {
  res.json({
    status: 'success',
    ...paymentNetworkInfo(),
    gateway: payGatewayStatus(),
  });
});

app.post('/api/payment/network', async (req, res) => {
  if (config.isProd) {
    res.status(403).json({
      status: 'error',
      message:
        'Cloud Run에서는 프로세스 로컬 게이트웨이 전환을 지원하지 않습니다. 배포 설정으로 고정하세요.',
    });
    return;
  }

  let me: Awaited<ReturnType<typeof getMeFromRequest>>;
  try {
    me = await getMeFromRequest(req);
  } catch (err: any) {
    res.status(503).json({
      status: 'error',
      message: `로그인 세션을 확인할 수 없습니다: ${err?.message || err}`,
    });
    return;
  }
  if (!me.connected) {
    res.status(401).json({
      status: 'error',
      message: '게이트웨이 모드 전환은 로그인한 Studio 운영자만 가능합니다.',
    });
    return;
  }
  const membership = await prisma.tenantMember.findUnique({
    where: {
      tenantId_userId: {
        tenantId: me.user?.tenantId || sharedTenantId(),
        userId: me.user!.id,
      },
    },
  });
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    res.status(403).json({
      status: 'error',
      message: '게이트웨이 모드 전환은 tenant owner/admin만 가능합니다.',
    });
    return;
  }

  const network = String(req.body?.network || '').toLowerCase();
  const normalized = normalizePaymentNetwork(network);
  if (!normalized) {
    res.status(400).json({
      status: 'error',
      message: 'network must be Devnet. localnet/sandbox are retired; mainnet is not supported',
    });
    return;
  }

  const previousNetwork = config.paymentNetwork;
  try {
    await restartManagedPayGateway(normalized);
  } catch (err: any) {
    let rollbackMessage = '';
    if (normalized !== previousNetwork) {
      try {
        await restartManagedPayGateway(previousNetwork);
        rollbackMessage = ` 이전 ${previousNetwork} 게이트웨이로 복구했습니다.`;
      } catch (rollbackErr: any) {
        rollbackMessage = ` 이전 모드 복구도 실패했습니다: ${rollbackErr?.message || rollbackErr}`;
      }
    }
    res.status(503).json({
      status: 'error',
      message: `pay.sh gateway 전환 실패: ${err?.message || err}.${rollbackMessage}`,
      gateway: payGatewayStatus(),
    });
    return;
  }

  const result = setPaymentNetwork(normalized, {
    rpcUrl: req.body?.rpcUrl,
    usdcMint: req.body?.usdcMint,
  });
  if (!result.ok) {
    res.status(400).json({ status: 'error', message: result.error });
    return;
  }
  res.json({
    status: 'success',
    message: `Payment network and pay.sh gateway switched to ${config.paymentNetwork}`,
    ...paymentNetworkInfo(),
    gateway: payGatewayStatus(),
  });
});

async function handleCatalogRegister(req: express.Request, res: express.Response) {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
      return;
    }
    const me = await getMeFromRequest(req);
    if (!me.user?.id) {
      res.status(401).json({ status: 'error', message: '로그인이 필요합니다.' });
      return;
    }
    if (!(await userCanManageAgent(me.user.id, agent.id))) {
      res.status(403).json({
        status: 'error',
        message: '이 에이전트를 Catalog에 등록할 권한이 없습니다.',
      });
      return;
    }
    const listing = await registerAgentOnPayShCatalog(agent, {
      baseUrl: publicBaseFromReq(req),
      description: req.body?.description,
    });
    res.json({
      status: 'success',
      listing: enrichCatalogListing(listing, publicBaseFromReq(req)),
      publishMode: getCatalogPublishMode(),
      catalog: catalogPublishInfo(),
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

app.post('/api/catalog/:agentId/register', requireGoogleSession, handleCatalogRegister);
/** @deprecated alias */
app.post('/api/paysh/catalog/:agentId/register', requireGoogleSession, handleCatalogRegister);

app.post('/api/agents/:id/invoke', async (req, res) => {
  try {
    const agentId = req.params.id;
    const { prompt, query, enableA2A, studioTest, history, attachments, webSearch, answerSession } =
      req.body || {};
    const userPrompt = prompt || query;

    const chatHistory = Array.isArray(history)
      ? history
          .filter(
            (h: any) =>
              h &&
              (h.role === 'user' || h.role === 'model') &&
              typeof h.text === 'string' &&
              h.text.trim()
          )
          .slice(-12)
          .map((h: any) => ({ role: h.role as 'user' | 'model', text: String(h.text) }))
      : [];

    const chatAttachments = Array.isArray(attachments)
      ? attachments
          .filter(
            (a: any) =>
              a &&
              typeof a.dataBase64 === 'string' &&
              a.dataBase64.length > 0 &&
              typeof a.mimeType === 'string'
          )
          .slice(0, 8)
          .map((a: any) => ({
            name: String(a.name || 'file').slice(0, 200),
            mimeType: String(a.mimeType).slice(0, 120),
            dataBase64: String(a.dataBase64).replace(/^data:[^;]+;base64,/, ''),
          }))
      : [];

    const agent = await getAgent(agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: `Agent with ID ${agentId} not found.` });
      return;
    }
    if (!userPrompt && chatAttachments.length === 0) {
      res.status(400).json({ status: 'error', message: 'Missing input parameter: prompt' });
      return;
    }

    const listing = await ensureListed(agent, `${req.protocol}://${req.get('host')}`);
    const feeAmount = agentFeeUsdc(agent);

    // Studio owner test: authenticated member of the agent tenant → no human→agent paywall.
    const me = await getMeFromRequest(req);
    const requestedStudioTest =
      studioTest === true || req.headers['x-solvamos-studio'] === '1';
    let isStudioOwnerTest = false;
    if (requestedStudioTest) {
      if (!me.connected || !me.user) {
        res.status(401).json({
          status: 'auth_required',
          message: 'Studio session expired. Refresh the session and retry.',
        });
        return;
      }
      const membership = agent.tenantId
        ? await prisma.tenantMember.findUnique({
            where: {
              tenantId_userId: {
                tenantId: agent.tenantId,
                userId: me.user.id,
              },
            },
          })
        : null;
      const ownership = await prisma.agentOwnership.findUnique({
        where: {
          userId_agentId: {
            userId: me.user.id,
            agentId: agent.id,
          },
        },
      });
      if (!membership && !ownership) {
        res.status(403).json({
          status: 'forbidden',
          message: 'This agent does not belong to your account.',
        });
        return;
      }
      isStudioOwnerTest = true;
    }

    const callChain = parseCallChainHeader(req.headers['x-a2a-chain']);

    const finish = async (paymentLogs: string[]) => {
      const out = await runAgentInvoke(
        {
          agentId,
          prompt: userPrompt || (chatAttachments.length ? '첨부한 파일을 분석해 주세요.' : ''),
          enableA2A,
          studioOwnerTest: isStudioOwnerTest,
          baseUrl: `${req.protocol}://${req.get('host')}`,
          history: chatHistory,
          attachments: chatAttachments,
          webSearch: webSearch === true,
          answerSession: typeof answerSession === 'string' ? answerSession : undefined,
          callChain,
        },
        paymentLogs
      );
      res.status(out.httpStatus).json(out.body);
    };

    if (isStudioOwnerTest) {
      await finish([
        `[Studio Test] owner session — paywall skipped, Vertex Gemini + RAG (listed fee=${feeAmount} USDC still applies to external callers via pay-gateway)`,
      ]);
      return;
    }

    // Free tier — no paywall
    if (feeAmount === 0) {
      await finish([`[Free Tier] fee=0 USDC — paywall skipped on ${networkLabel()}`]);
      return;
    }

    // Paid + on-chain proof (A2A vault split payment): verify 90/10 split and settle.
    const paymentProof =
      (typeof req.headers['x-payment-proof'] === 'string' && req.headers['x-payment-proof']) ||
      (typeof req.body?.paymentProof === 'string' && req.body.paymentProof) ||
      '';
    if (paymentProof) {
      const audit = await verifyPayment(paymentProof, agent.publicKey, feeAmount);
      if (!audit.verified) {
        res.status(402).json({
          status: 'payment_required',
          message: audit.error || 'Payment proof verification failed',
          paymentLogs: audit.logs,
          network: networkLabel(),
        });
        return;
      }
      const payerAgentId =
        typeof req.headers['x-a2a-from'] === 'string'
          ? req.headers['x-a2a-from'].slice(0, 80)
          : null;
      try {
        await recordSettlement({
          signature: paymentProof,
          agentId: agent.id,
          recipientWallet: agent.publicKey,
          amountUsdc: feeAmount,
          status: 'success',
          blockHeight: audit.slot ?? null,
          network: audit.network,
          proofKind: audit.proofKind === 'onchain' ? 'a2a_onchain' : audit.proofKind,
          payerAgentId,
        });
      } catch (err: any) {
        console.warn('[settlement] record failed (invoke continues):', err?.message || err);
      }
      await finish([
        `[A2A Paid] proof ${paymentProof.slice(0, 20)}… verified (${(1 - config.platformFeeShare) * 100}% → agent vault, ${config.platformFeeShare * 100}% → treasury) — paywall passed`,
        ...audit.logs,
      ]);
      return;
    }

    // Paid commercial path without proof: gateway ONLY (A).
    const gw =
      (listing?.invokeUrl && !/\/api\/agents\//.test(listing.invokeUrl)
        ? listing.invokeUrl
        : null) || gatewayInvokeUrl(agentId);
    if (!config.usePayGateway || !config.payGatewayUrl) {
      res.status(503).json({
        status: 'payment_gateway_required',
        message:
          'Paid agents must be invoked via pay-gateway (USE_PAY_GATEWAY + PAY_GATEWAY_URL). Legacy origin proofs are disabled.',
        invokeUrl: gw,
        payGatewayUrl: config.payGatewayUrl || null,
      });
      return;
    }
    res.status(402).json({
      status: 'payment_required',
      protocol: 'x402 / MPP',
      gateway: 'pay.sh-compatible',
      amount: feeAmount,
      token: 'USDC',
      gatewayUrl: gw,
      payGatewayUrl: config.payGatewayUrl,
      recipientWallet: agent.publicKey,
      network: networkLabel(),
      catalogId: listing?.catalogId,
      payShCatalogId: listing?.catalogId,
      invokeUrl: gw,
      message:
        config.paymentNetwork === 'devnet'
          ? `HTTP 402 (x402/MPP): PAY_API_URL=${config.appUrl}/payapi pay fetch "${gw}?prompt=hello" (Devnet USDC; the pay CLI's hosted balance check is mainnet-only, so point PAY_API_URL at this shim).`
          : `HTTP 402 (x402/MPP): pay --sandbox fetch "${gw}?prompt=hello" (localnet). Gateway proxies to Studio after settlement.`,
    });
    return;
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** pay.sh gateway upstream — no paywall (settlement already done by gateway). */
function assertPayInternal(req: express.Request, res: express.Response): boolean {
  const secret = config.payInternalSecret;
  // Header only — never accept ?pay_internal= (logs / Referer leakage).
  const provided = String(req.headers['x-pay-internal-secret'] || '');

  if (secret) {
    if (!secretsEqual(provided, secret)) {
      res.status(403).json({
        status: 'error',
        message: 'Forbidden — set PAY_INTERNAL_SECRET and configure gateway routing.auth',
      });
      return false;
    }
    return true;
  }

  // Dev fallback: loopback only when secret unset
  const ip = req.ip || req.socket.remoteAddress || '';
  const loopback =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('127.0.0.1');
  if (!config.isProd && loopback) return true;

  res.status(403).json({
    status: 'error',
    message: 'Forbidden — configure PAY_INTERNAL_SECRET for gateway → origin',
  });
  return false;
}

async function handleInternalInvoke(req: express.Request, res: express.Response) {
  try {
    if (!assertPayInternal(req, res)) return;
    const agentId = req.params.agentId || req.params.id;
    const body = req.body || {};
    const userPrompt =
      body.prompt || body.query || (typeof req.query.prompt === 'string' ? req.query.prompt : '');
    const enableA2A =
      body.enableA2A === true ||
      req.query.enableA2A === 'true' ||
      req.query.enableA2A === '1';
    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            (h: any) =>
              h &&
              (h.role === 'user' || h.role === 'model') &&
              typeof h.text === 'string' &&
              h.text.trim()
          )
          .slice(-12)
          .map((h: any) => ({ role: h.role as 'user' | 'model', text: String(h.text) }))
      : [];
    const attachments = Array.isArray(body.attachments)
      ? body.attachments
          .filter(
            (a: any) =>
              a && typeof a.dataBase64 === 'string' && a.dataBase64 && typeof a.mimeType === 'string'
          )
          .slice(0, 8)
          .map((a: any) => ({
            name: String(a.name || 'file').slice(0, 200),
            mimeType: String(a.mimeType).slice(0, 120),
            dataBase64: String(a.dataBase64).replace(/^data:[^;]+;base64,/, ''),
          }))
      : [];
    const receipt = parseGatewayReceiptHeaders(req);
    const out = await runAgentInvoke(
      {
        agentId,
        prompt: userPrompt,
        enableA2A,
        studioOwnerTest: false,
        baseUrl: config.payOriginUrl || config.appUrl,
        history,
        attachments,
        webSearch: body.webSearch === true || req.query.webSearch === 'true',
        answerSession: typeof body.answerSession === 'string' ? body.answerSession : undefined,
        callChain: parseCallChainHeader(req.headers['x-a2a-chain']),
      },
      ['[pay.sh gateway] settled — origin internal invoke (paywall skipped)']
    );
    res.status(out.httpStatus).json(out.body);

    // Native MPP already moved USDC on-chain. Ledger PaymentSettlement after
    // verifyPayment (header signature or recent vault ATA scan).
    if (out.httpStatus === 200) {
      void settleExternalGatewaySale(agentId, receipt);
    }
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
}

/**
 * Ledger a gateway-settled external sale (fire-and-forget).
 *
 * Native MPP: buyer TX already split seller% → vault + remainder → treasury.
 * We verify on-chain (header sig or ATA scan) then upsert PaymentSettlement.
 * No second operator→seller payout unless GATEWAY_LEGACY_PAYOUT=true.
 */
async function settleExternalGatewaySale(
  agentId: string,
  receipt: {
    signature: string | null;
    amountUsdc: number | null;
    payer: string | null;
    network: string | null;
  }
) {
  try {
    const agent = await getAgent(agentId);
    if (!agent) return;
    const fee = agentFeeUsdc(agent);
    if (!(fee > 0)) return;

    const settled = await settleVerifiedGatewaySale({
      agent,
      feeUsdc: fee,
      hint: receipt,
      payer: receipt.payer,
    });
    if (settled.recorded) {
      serverLog('info', 'payment', `gateway ledger ok agent=${agent.id} fee=${fee}`, {
        signature: settled.signature,
        source: settled.source,
        payer: receipt.payer || undefined,
        sellerShareUsdc: fee * (1 - config.platformFeeShare),
        platformShareUsdc: fee * config.platformFeeShare,
      });
    } else if (settled.skipped && settled.skipped !== 'idempotent') {
      console.warn(
        `[gateway-settle] ledger skipped agent=${agent.id}: ${settled.skipped}${
          settled.error ? ` (${settled.error})` : ''
        }`
      );
    }

    const legacyPayout = String(process.env.GATEWAY_LEGACY_PAYOUT || '').toLowerCase() === 'true';
    if (!legacyPayout || !settled.signature) {
      return;
    }

    const payout = await payoutGatewaySale(agent.publicKey, fee);
    if (payout.ok && payout.signature) {
      await recordSettlement({
        signature: payout.signature,
        agentId: agent.id,
        recipientWallet: agent.publicKey,
        amountUsdc: fee,
        status: 'success',
        network: config.paymentNetwork,
        proofKind: 'gateway_payout',
      });
      serverLog('info', 'payment', `gateway legacy payout agent=${agent.id} fee=${fee}`, {
        receipt: settled.signature,
        signature: payout.signature,
        sellerShareUsdc: payout.sellerShareUsdc,
        platformShareUsdc: payout.platformShareUsdc,
      });
    } else {
      console.warn('[gateway-settle] legacy payout failed:', payout.error);
    }
  } catch (err: any) {
    console.warn('[gateway-settle] error:', err?.message || err);
  }
}

// Paths must match pay/solvamos-provider.yml (gateway proxies same path to origin)
app.get('/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    product: config.product,
    version: config.version,
    payGateway: config.usePayGateway,
    payGatewayUrl: config.payGatewayUrl,
  });
});
app.get('/v1/agents/:agentId/invoke', handleInternalInvoke);
app.post('/v1/agents/:agentId/invoke', handleInternalInvoke);
app.post('/api/internal/agents/:id/invoke', handleInternalInvoke);

/** Google A2A–style Agent Card (discovery). Payments via extensions.solvamos.pay.invokeUrl */
app.get('/.well-known/agent.json', async (_req, res) => {
  res.json({
    name: 'SolVamos Studio',
    description: 'Multi-agent RAG studio. Per-agent cards at /api/agents/:id/agent-card',
    url: config.usePayGateway ? config.payGatewayUrl : config.appUrl,
    version: config.version,
    provider: { organization: 'SolVamos', url: config.appUrl },
  });
});
app.get('/api/agents/:id/agent-card', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ status: 'error', message: 'Agent not found' });
    return;
  }
  res.json(buildAgentCard(agent));
});
app.get('/.well-known/agent/:id.json', async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ status: 'error', message: 'Agent not found' });
    return;
  }
  res.json(buildAgentCard(agent));
});

async function startServer() {
  const degraded = process.env.BOOT_ALLOW_DEGRADED === 'true';

  // Bind PORT first — Cloud Run probes :8080 before DB warm completes.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(`[${config.product}] v${config.version} http://0.0.0.0:${config.port}`);
      resolve();
    });
    server.on('error', reject);
  });

  // Static UI after listen is fine — Express can add middleware late for unmatched routes,
  // but register early so first HTML requests work once DB warm finishes.
  if (config.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api') || req.path === '/healthz' || req.path === '/readyz') {
        return res.status(404).json({ status: 'error', message: 'Not found' });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (config.payGatewayManaged) {
    try {
      await restartManagedPayGateway(config.paymentNetwork);
    } catch (err: any) {
      // Keep Studio usable even when pay CLI/account setup is missing.
      console.warn('[pay gateway] automatic startup failed:', err?.message || err);
    }
  }

  let dbReady = false;
  if (process.env.DATABASE_URL) {
    try {
      await connectDb();
      dbReady = true;
    } catch (err: any) {
      console.error('[db] connect failed', err?.message || err);
      if (config.isProd && !degraded) {
        console.error('[boot] DATABASE_URL unreachable in production — exiting');
        process.exit(1);
      }
      console.warn('[boot] continuing without DB (degraded or non-prod)');
    }
  } else {
    console.warn('[db] DATABASE_URL unset — JWT refresh works, but Google tokens won’t survive restarts');
    if (config.isProd && !degraded) {
      console.error('[boot] DATABASE_URL required in production — exiting');
      process.exit(1);
    }
  }

  if (!dbReady) {
    console.warn('[boot] skipping tenant/agent catalog warm — database not ready');
    return;
  }

  try {
    await loadTenants();
    await ensureSharedCustomerTenant();
    await loadAgents();
    const active = (await listAgents()).filter((a) => a.status !== 'PAUSED');
    if (config.catalogSiteUrl) {
      const n = await hydrateCatalogRemote(active, { baseUrl: config.appUrl });
      console.log(`[boot] hydrated ${n} agents → ${config.catalogSiteUrl}`);
    } else {
      for (const a of active) {
        void registerAgentOnPayShCatalog(a);
      }
    }
  } catch (err: any) {
    console.error('[boot] catalog warm failed', err?.message || err);
    if (config.isProd && !degraded) {
      process.exit(1);
    }
  }
}

startServer().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopManagedPayGateway().finally(() => process.exit(0));
  });
}
