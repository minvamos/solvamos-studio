/**
 * SolVamos Studio — Express API + Vite (dev) / static (prod)
 * Cloud Run paywall gateway + Vertex AI Search RAG
 */

import express from 'express';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';

import { compileSystemPrompt } from './server/prompt.js';
import { savePrivateKeyToGCP, createAgentVaultKeypair } from './server/vault.js';
import { listSettlementsForUser } from './server/settlements.js';
import { ensureAiApplication, syncLocalCorpusToVertex } from './server/rag.js';
import { aiApplicationsCatalog, getDataSourceType } from './server/ai-applications.js';
import { ingestDriveSourceForAgent } from './server/drive-ingest.js';
import { ingestLocalUploadsForAgent } from './server/local-ingest.js';
import { registerDriveAuthRoutes, isDriveAuthAvailable, isOAuthClientConfigured, requireGoogleSession, resolveSessionId, getSession } from './server/drive-oauth.js';
import { loadTenants, listTenants, getTenant, upsertTenant } from './server/tenants.js';
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
  type AgentRecord,
} from './server/agents-store.js';
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

dotenv.config();
assertProductionSafety();

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

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') || req.path === '/healthz') {
      console.log(
        JSON.stringify({
          severity: 'INFO',
          httpRequest: {
            requestMethod: req.method,
            requestUrl: req.originalUrl,
            status: res.statusCode,
            latency: `${(Date.now() - start) / 1000}s`,
          },
        })
      );
    }
  });
  next();
});

loadPayShCatalog();
registerPlatformAuthRoutes(app);
registerDriveAuthRoutes(app);

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

app.patch('/api/tenants/:id', async (req, res) => {
  const existing = await getTenant(req.params.id);
  if (!existing) {
    res.status(404).json({ status: 'error', message: 'Tenant not found' });
    return;
  }
  const updated = await upsertTenant({ ...existing, ...req.body, tenantId: existing.tenantId });
  res.json({ status: 'success', tenant: updated });
});

/** Redeploy / create tenant Cloud Run in shared project (Lab). */
app.post('/api/tenants/:id/cloud-run', async (req, res) => {
  try {
    const existing = await getTenant(req.params.id);
    if (!existing) {
      res.status(404).json({ status: 'error', message: 'Tenant not found' });
      return;
    }
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
  res.json({
    status: 'success',
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
      return {
        ...agent,
        fee,
        perCallPriceUsdc: fee,
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

    const systemPrompt = compileSystemPrompt(role, tone, securityLevel, customRole);

    const parsedFeeEarly =
      typeof fee === 'number'
        ? fee
        : typeof perCallPriceUsdc === 'number'
          ? perCallPriceUsdc
          : 0;

    const pipeline: { step: string; status: 'ok' | 'skip' | 'warn'; detail: string }[] = [];
    pipeline.push({
      step: 'tenant_bind',
      status: 'ok',
      detail: `tenant=${tenantId} project=${config.gcpProject || 'n/a'} (shared GCP as customer)`,
    });

    // Persist vault before DB row so create never leaves CREATING orphans on vault failure
    const gcpStorage = await savePrivateKeyToGCP(agentId, secretKeyBase64);
    pipeline.push({
      step: 'agent_vault',
      status: gcpStorage.mock ? 'warn' : 'ok',
      detail: `Dedicated agent vault ${publicKey.slice(0, 4)}…${publicKey.slice(-4)} (separate from user wallet ${
        userPrimary?.address ? userPrimary.address.slice(0, 4) + '…' : 'none'
      })`,
    });
    pipeline.push({
      step: 'vault_persist',
      status: gcpStorage.mock ? 'warn' : 'ok',
      detail: gcpStorage.mock
        ? `Dev local vault fallback: ${gcpStorage.path}`
        : `Secret Manager: ${gcpStorage.path}`,
    });

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
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
      secretManagerPath: gcpStorage.path,
      status: 'CREATING',
      fee: parsedFeeEarly,
      perCallPriceUsdc: parsedFeeEarly,
    });
    pipeline.push({ step: 'agent_record_draft', status: 'ok', detail: agentId });

    let vertexDataStoreId: string | undefined;
    let vertexEngineId: string | undefined;
    let indexingStatus: AgentRecord['status'] = 'ACTIVE';
    let driveIngest: { docs: number; message?: string } | null = null;

    // Always provision AI Applications (data store + app/engine) — Drive is optional source
    // Website URL forces PUBLIC_WEBSITE app type so site/* indexing can attach.
    const provisionAppType =
      resolvedSource === 'website_url' || websiteUri ? 'website' : aiAppType || 'search_docs';
    const aiApp = await ensureAiApplication({
      displayName: agentName || agentId,
      appType: provisionAppType,
      dataSourceType: resolvedSource === 'website_url' || websiteUri ? 'website_url' : resolvedSource,
      driveFolderId: googleDriveFolderId ? String(googleDriveFolderId) : undefined,
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
    });
    vertexDataStoreId = aiApp.dataStoreId;
    vertexEngineId = aiApp.engineId;
    indexingStatus =
      aiApp.status === 'pending' || aiApp.status === 'error' || !aiApp.engineId
        ? 'INDEXING'
        : 'ACTIVE';
    pipeline.push({
      step: 'ai_applications',
      status: aiApp.status === 'created' || aiApp.status === 'existing' ? 'ok' : 'warn',
      detail: `${aiApp.message || aiApp.dataStoreId}${
        aiApp.engineId ? ` engine=${aiApp.engineId}` : ' (NO ENGINE — Gemini-only fallback)'
      }${aiApp.sourceNote ? ` · ${aiApp.sourceNote}` : ''}`,
    });

    if (needsDrive && sid) {
      try {
        const corpus = await ingestDriveSourceForAgent({
          sessionId: sid,
          agentId,
          driveSourceId: String(googleDriveFolderId),
        });
        driveIngest = { docs: corpus.docs.length };
        indexingStatus = corpus.docs.length > 0 ? 'ACTIVE' : indexingStatus;
        pipeline.push({
          step: 'drive_rag_ingest',
          status: corpus.docs.length > 0 ? 'ok' : 'warn',
          detail:
            corpus.docs.length > 0
              ? `Ingested ${corpus.docs.length} Drive doc(s)`
              : 'No text-extractable files (Docs/Sheets/txt/md/json/pdf).',
        });

        if (vertexDataStoreId && corpus.docs.length > 0 && aiApp.status !== 'error') {
          try {
            const sync = await syncLocalCorpusToVertex(agentId, vertexDataStoreId);
            pipeline.push({
              step: 'vertex_import',
              status: sync.imported > 0 ? 'ok' : 'warn',
              detail: sync.message,
            });
            if (sync.imported > 0) indexingStatus = 'ACTIVE';
          } catch (err: any) {
            pipeline.push({
              step: 'vertex_import',
              status: 'warn',
              detail: err?.message || 'Vertex import failed — local corpus still usable',
            });
          }
        }
      } catch (err: any) {
        pipeline.push({
          step: 'drive_rag_ingest',
          status: 'warn',
          detail: err?.message || 'Drive ingest failed — Google 연동/권한을 확인하세요',
        });
        indexingStatus = 'INDEXING';
      }
    } else if (needsLocal) {
      try {
        const corpus = await ingestLocalUploadsForAgent({
          agentId,
          files: localFileList,
        });
        driveIngest = {
          docs: corpus.docs.length,
          message: corpus.skipped?.length
            ? `skipped: ${corpus.skipped.slice(0, 3).join('; ')}`
            : undefined,
        };
        indexingStatus = corpus.docs.length > 0 ? 'ACTIVE' : indexingStatus;
        pipeline.push({
          step: 'local_upload_ingest',
          status: corpus.docs.length > 0 ? 'ok' : 'warn',
          detail:
            corpus.docs.length > 0
              ? `Ingested ${corpus.docs.length} local file(s)`
              : `No text extracted. ${corpus.skipped?.join(' · ') || 'Use txt/md/json/csv/html/pdf'}`,
        });

        if (vertexDataStoreId && corpus.docs.length > 0 && aiApp.status !== 'error') {
          try {
            const sync = await syncLocalCorpusToVertex(agentId, vertexDataStoreId);
            pipeline.push({
              step: 'vertex_import',
              status: sync.imported > 0 ? 'ok' : 'warn',
              detail: sync.message,
            });
            if (sync.imported > 0) indexingStatus = 'ACTIVE';
          } catch (err: any) {
            pipeline.push({
              step: 'vertex_import',
              status: 'warn',
              detail: err?.message || 'Vertex import failed — local corpus still usable',
            });
          }
        }
      } catch (err: any) {
        pipeline.push({
          step: 'local_upload_ingest',
          status: 'warn',
          detail: err?.message || 'Local upload ingest failed',
        });
        indexingStatus = 'INDEXING';
      }
    } else if (resolvedSource === 'local_upload') {
      pipeline.push({
        step: 'local_upload',
        status: 'skip',
        detail: 'local_upload selected but no files — empty datastore + app only (add files later)',
      });
    } else if (resolvedSource !== 'google_drive') {
      pipeline.push({
        step: 'data_source',
        status: 'ok',
        detail:
          aiApp.sourceNote ||
          `Source=${resolvedSource} — app+datastore ready`,
      });
    } else {
      pipeline.push({
        step: 'drive_rag',
        status: 'skip',
        detail: 'google_drive selected but no folder/file — empty datastore + app only',
      });
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
    pipeline.push({ step: 'agent_record', status: 'ok', detail: agentId });

    const tenant = tenantId ? await getTenant(String(tenantId)) : undefined;
    const runtimeBase =
      (tenant?.cloudRunUri && String(tenant.cloudRunUri).replace(/\/$/, '')) ||
      `${req.protocol}://${req.get('host')}`;

    const listing = await registerAgentOnPayShCatalog(newAgent, {
      baseUrl: runtimeBase,
      description: req.body.description,
    });
    const publicBase = publicBaseFromReq(req);
    const payShCatalog = enrichCatalogListing(listing, publicBase);
    pipeline.push({
      step: 'paysh_catalog',
      status: 'ok',
      detail: `${payShCatalog.catalogId} · ${payShCatalog.catalogPageUrl}`,
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
    if (createdAgentId) {
      await deleteAgent(createdAgentId);
    }
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
      websiteUri,
      gcsUri,
      localFiles,
    } = req.body || {};

    const nextRole = role || existing.role;
    const nextTone = tone || existing.tone;
    const nextSecurity = securityLevel || existing.securityLevel;
    const nextCustom =
      customRole !== undefined ? customRole || undefined : existing.customRole;
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

    // Missing store (legacy agents) or Drive source change → ensure AI Applications bundle
    if (!vertexDataStoreId || (folderChanged && nextFolder) || hasLocalFiles) {
      const aiApp = await ensureAiApplication({
        displayName: nextName || existing.id,
        appType: nextAiAppType,
        dataSourceType: resolvedSource,
        driveFolderId: nextFolder,
        websiteUri: nextWebsite,
        gcsUri: nextGcs,
      });
      if (aiApp.status !== 'error') {
        vertexDataStoreId = aiApp.dataStoreId;
        vertexEngineId = aiApp.engineId || vertexEngineId;
      }
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
      try {
        const corpus = await ingestDriveSourceForAgent({
          sessionId: sid,
          agentId: existing.id,
          driveSourceId: String(nextFolder),
        });
        driveIngest = { docs: corpus.docs.length };
        if (vertexDataStoreId && corpus.docs.length > 0) {
          await syncLocalCorpusToVertex(existing.id, vertexDataStoreId).catch(() => null);
        }
        indexingStatus = corpus.docs.length > 0 ? 'ACTIVE' : 'INDEXING';
      } catch {
        indexingStatus = 'INDEXING';
      }
    } else if (hasLocalFiles) {
      try {
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
        if (vertexDataStoreId && corpus.docs.length > 0) {
          await syncLocalCorpusToVertex(existing.id, vertexDataStoreId).catch(() => null);
        }
        indexingStatus = corpus.docs.length > 0 ? 'ACTIVE' : 'INDEXING';
      } catch {
        indexingStatus = 'INDEXING';
      }
    }

    const updated: AgentRecord = {
      ...existing,
      agentName: nextName,
      role: nextRole,
      customRole: nextCustom,
      tone: nextTone,
      securityLevel: nextSecurity,
      systemPrompt: compileSystemPrompt(nextRole, nextTone, nextSecurity, nextCustom),
      fee: nextFee,
      perCallPriceUsdc: nextFee,
      status: indexingStatus,
      googleDriveFolderId: nextFolder,
      vertexDataStoreId,
      vertexEngineId,
      aiAppType: nextAiAppType,
      dataSourceType: resolvedSource,
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
    });
    const payShCatalog = enrichCatalogListing(listing, publicBaseFromReq(req));

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
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/agents/preview-prompt', (req, res) => {
  const { role, tone, securityLevel, customRole } = req.body;
  const systemPrompt = compileSystemPrompt(
    role || 'support',
    tone || 'professional',
    securityLevel || 'strict',
    customRole
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
  res.json({
    status: 'success',
    agentId: agent.id,
    solanaPubkey: agent.publicKey,
    payShConnected: !!listing && listing.status === 'listed',
    payShCatalogId: listing?.catalogId || null,
    currentUsdcBalance: null,
    note: 'Listed on SolVamos catalog for A2A; paid calls settle via x402/MPP gateway',
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
      message: 'network must be localnet | devnet. mainnet is not supported',
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

app.post('/api/catalog/:agentId/register', async (req, res) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
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
});
/** @deprecated alias */
app.post('/api/paysh/catalog/:agentId/register', async (req, res) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
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
});

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

    // Paid commercial path: gateway ONLY (A). Studio origin never settles X-PAYMENT-PROOF.
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
          ? `HTTP 402 (x402/MPP): pay fetch "${gw}?prompt=hello" (Devnet USDC, no --sandbox). Do not call Studio /api/agents/.../invoke with X-PAYMENT-PROOF.`
          : `HTTP 402 (x402/MPP): pay --sandbox fetch "${gw}?prompt=hello" (localnet). Gateway proxies to Studio after settlement.`,
    });
    return;
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** pay.sh gateway upstream — no paywall (settlement already done by gateway). */
function assertPayInternal(req: express.Request, res: express.Response): boolean {
  const secret = config.payInternalSecret;
  const provided =
    (req.headers['x-pay-internal-secret'] as string) ||
    (typeof req.query.pay_internal === 'string' ? req.query.pay_internal : '');

  if (secret) {
    if (provided !== secret) {
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
      },
      ['[pay.sh gateway] settled — origin internal invoke (paywall skipped)']
    );
    res.status(out.httpStatus).json(out.body);
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
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
