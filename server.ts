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
import { verifyPayment } from './server/payment.js';
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
  getAgent,
  putAgent,
  deleteAgent,
  type AgentRecord,
} from './server/agents-store.js';
import {
  loadPayShCatalog,
  listCatalog,
  listCatalogForA2A,
  registerAgentOnPayShCatalog,
  getCatalogEntry,
  getCatalogPublishMode,
  setCatalogPublishMode,
  catalogPublishInfo,
} from './server/paysh-catalog.js';
import { loadWallets, listWallets, addWallet, setPrimaryWallet, removeWallet, getPrimaryWallet, ownerKeyFromEmail, updateWalletLabel } from './server/wallets.js';
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
loadWallets();
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
    payShCatalogListings: listCatalog({ listedOnly: true, scope: 'all' }).length,
    catalogPublishMode: getCatalogPublishMode(),
    catalogRemoteConfigured: !!process.env.PAYSH_CATALOG_URL?.trim(),
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

app.get('/api/agents', async (_req, res) => {
  res.json({ status: 'success', data: await listAgents() });
});

app.get('/api/ai-applications/catalog', (_req, res) => {
  res.json({ status: 'success', ...aiApplicationsCatalog() });
});

async function walletOwnerFromReq(req: import('express').Request): Promise<string> {
  const sid = await resolveSessionId(req);
  const session = sid ? getSession(sid) : undefined;
  return ownerKeyFromEmail(session?.email);
}

app.get('/api/wallets', async (req, res) => {
  const owner = await walletOwnerFromReq(req);
  const wallets = listWallets(owner);
  res.json({
    status: 'success',
    owner,
    primary: getPrimaryWallet(owner) || null,
    data: wallets,
  });
});

app.post('/api/wallets', async (req, res) => {
  try {
    const owner = await walletOwnerFromReq(req);
    const { address, label, source, makePrimary } = req.body || {};
    if (!address) {
      res.status(400).json({ status: 'error', message: 'address required' });
      return;
    }
    const wallet = addWallet(owner, {
      address: String(address),
      label: label ? String(label) : undefined,
      source: source ? String(source) : 'manual',
      makePrimary: makePrimary !== false,
    });
    res.status(201).json({
      status: 'success',
      wallet,
      primary: getPrimaryWallet(owner) || null,
      data: listWallets(owner),
    });
  } catch (err: any) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

app.post('/api/wallets/:id/primary', async (req, res) => {
  try {
    const owner = await walletOwnerFromReq(req);
    const wallet = setPrimaryWallet(owner, req.params.id);
    res.json({
      status: 'success',
      wallet,
      primary: wallet,
      data: listWallets(owner),
    });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
});

app.patch('/api/wallets/:id', async (req, res) => {
  try {
    const owner = await walletOwnerFromReq(req);
    const wallet = updateWalletLabel(owner, req.params.id, String(req.body?.label || ''));
    res.json({ status: 'success', wallet, data: listWallets(owner) });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
});

app.delete('/api/wallets/:id', async (req, res) => {
  try {
    const owner = await walletOwnerFromReq(req);
    const data = removeWallet(owner, req.params.id);
    res.json({
      status: 'success',
      primary: getPrimaryWallet(owner) || null,
      data,
    });
  } catch (err: any) {
    res.status(404).json({ status: 'error', message: err.message });
  }
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

    const ownerEmail = me.user?.email || authSession?.email;
    const owner = ownerKeyFromEmail(ownerEmail);
    // User wallet = operator only (funding / display). Never agent vault.
    const userPrimary = getPrimaryWallet(owner);

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
    const aiApp = await ensureAiApplication({
      displayName: agentName || agentId,
      appType: aiAppType || 'search_docs',
      dataSourceType: resolvedSource,
      driveFolderId: googleDriveFolderId ? String(googleDriveFolderId) : undefined,
      websiteUri: websiteUri ? String(websiteUri) : undefined,
      gcsUri: gcsUri ? String(gcsUri) : undefined,
    });
    vertexDataStoreId = aiApp.dataStoreId;
    vertexEngineId = aiApp.engineId;
    indexingStatus =
      aiApp.status === 'pending' || aiApp.status === 'error' ? 'INDEXING' : 'ACTIVE';
    pipeline.push({
      step: 'ai_applications',
      status: aiApp.status === 'created' || aiApp.status === 'existing' ? 'ok' : 'warn',
      detail: `${aiApp.message || aiApp.dataStoreId}${
        aiApp.engineId ? ` engine=${aiApp.engineId}` : ''
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

    await putAgent(newAgent);
    pipeline.push({ step: 'agent_record', status: 'ok', detail: agentId });

    const tenant = tenantId ? await getTenant(String(tenantId)) : undefined;
    const runtimeBase =
      (tenant?.cloudRunUri && String(tenant.cloudRunUri).replace(/\/$/, '')) ||
      `${req.protocol}://${req.get('host')}`;

    const listing = await registerAgentOnPayShCatalog(newAgent, {
      baseUrl: runtimeBase,
      description: req.body.description,
    });
    pipeline.push({
      step: 'paysh_catalog',
      status: 'ok',
      detail: listing.catalogId || listing.agentId,
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
      payShCatalog: listing,
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

    res.json({
      status: 'success',
      agent: updated,
      driveIngest,
      payShCatalog: listing,
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
    note: 'Listed on pay.sh catalog for A2A; USDC balance audit is Solana workstream',
  });
});

/** pay.sh catalog — discover agents other A2A callers can pay-invoke */
app.get('/api/paysh/catalog', (req, res) => {
  const scopeRaw = String(req.query.scope || 'all').toLowerCase();
  const scope =
    scopeRaw === 'internal' || scopeRaw === 'main' || scopeRaw === 'all' ? scopeRaw : 'all';
  res.json({
    status: 'success',
    protocol: 'pay.sh / x402',
    network: networkLabel(),
    paymentNetwork: config.paymentNetwork,
    publishMode: getCatalogPublishMode(),
    scope,
    ...catalogPublishInfo(),
    data: listCatalog({ listedOnly: true, scope }),
  });
});

/** Dev: catalog publish target — internal | main | both */
app.get('/api/paysh/catalog/mode', (_req, res) => {
  res.json({ status: 'success', ...catalogPublishInfo() });
});

app.post('/api/paysh/catalog/mode', (req, res) => {
  const mode = String(req.body?.mode || '').toLowerCase();
  const result = setCatalogPublishMode(mode);
  if (!result.ok) {
    res.status(config.isProd ? 403 : 400).json({ status: 'error', message: result.error });
    return;
  }
  res.json({
    status: 'success',
    message: `Catalog publish mode → ${result.mode}`,
    ...catalogPublishInfo(),
  });
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

app.post('/api/paysh/catalog/:agentId/register', async (req, res) => {
  try {
    const agent = await getAgent(req.params.agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: 'Agent not found' });
      return;
    }
    const override = req.body?.publishMode
      ? String(req.body.publishMode).toLowerCase()
      : undefined;
    const listing = await registerAgentOnPayShCatalog(agent, {
      baseUrl: `${req.protocol}://${req.get('host')}`,
      description: req.body?.description,
      publishMode:
        override === 'internal' || override === 'main' || override === 'both'
          ? override
          : undefined,
    });
    res.json({
      status: 'success',
      listing,
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
    const { prompt, query, enableA2A, studioTest } = req.body || {};
    const userPrompt = prompt || query;
    const paymentProof =
      (req.headers['x-payment-proof'] as string) ||
      (req.headers['x-pay-sh-proof'] as string);

    const agent = await getAgent(agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: `Agent with ID ${agentId} not found.` });
      return;
    }
    if (!userPrompt) {
      res.status(400).json({ status: 'error', message: 'Missing input parameter: prompt' });
      return;
    }

    const listing = await ensureListed(agent, `${req.protocol}://${req.get('host')}`);
    const feeAmount = agentFeeUsdc(agent);

    // Studio sandbox: logged-in operator tests their agent → Vertex/RAG, no human→agent paywall.
    const me = await getMeFromRequest(req);
    const isStudioOwnerTest =
      (studioTest === true || req.headers['x-solvamos-studio'] === '1') && me.connected === true;

    const finish = async (paymentLogs: string[]) => {
      const out = await runAgentInvoke(
        {
          agentId,
          prompt: userPrompt,
          enableA2A,
          studioOwnerTest: isStudioOwnerTest,
          baseUrl: `${req.protocol}://${req.get('host')}`,
        },
        paymentLogs
      );
      res.status(out.httpStatus).json(out.body);
    };

    if (isStudioOwnerTest) {
      await finish([
        `[Studio Test] owner session — paywall skipped, Vertex Gemini + RAG (listed fee=${feeAmount} USDC still applies to external callers)`,
      ]);
      return;
    }

    // Free tier — no paywall
    if (feeAmount === 0) {
      await finish([`[Free Tier] fee=0 USDC — paywall skipped on ${networkLabel()}`]);
      return;
    }

    // Commercial path: prefer official pay.sh gateway (standard 402 / X-PAYMENT)
    if (config.usePayGateway && !paymentProof) {
      const gw = listing?.invokeUrl || gatewayInvokeUrl(agentId);
      res.status(402).json({
        status: 'payment_required',
        protocol: 'pay.sh-gateway',
        amount: feeAmount,
        token: 'USDC',
        gatewayUrl: gw,
        payGatewayUrl: config.payGatewayUrl,
        recipientWallet: agent.publicKey,
        network: networkLabel(),
        payShCatalogId: listing?.catalogId,
        invokeUrl: gw,
        message: `HTTP 402: Use pay.sh gateway — pay --sandbox curl -X POST ${gw} -H "Content-Type: application/json" -d '{"prompt":"..."}'. Origin no longer settles payments when USE_PAY_GATEWAY=true.`,
      });
      return;
    }

    if (!paymentProof) {
      const agentShare = 1 - config.platformFeeShare;
      res.status(402).json({
        status: 'payment_required',
        amount: feeAmount,
        token: 'USDC',
        recipientWallet: agent.publicKey,
        platformTreasury: config.platformTreasuryPubkey || null,
        agentShareUsdc: feeAmount * agentShare,
        platformShareUsdc: feeAmount * config.platformFeeShare,
        network: networkLabel(),
        paymentNetwork: config.paymentNetwork,
        usdcMint: config.usdcMint,
        payShCatalogId: listing?.catalogId,
        invokeUrl: listing?.invokeUrl,
        message: `HTTP 402: Pay ${feeAmount} USDC on ${networkLabel()} (≈${(agentShare * 100).toFixed(0)}% agent / ${(config.platformFeeShare * 100).toFixed(0)}% platform). Attach signature in X-PAYMENT-PROOF (legacy). Prefer pay.sh gateway.`,
      });
      return;
    }

    const audit = await verifyPayment(paymentProof, agent.publicKey, feeAmount);
    if (!audit.verified) {
      res.status(402).json({
        status: 'payment_verification_failed',
        message: `On-chain validation failed: ${audit.error || 'Transaction verification error'}`,
        logs: audit.logs,
        network: audit.network,
      });
      return;
    }

    await finish(audit.logs);
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
    const out = await runAgentInvoke(
      {
        agentId,
        prompt: userPrompt,
        enableA2A,
        studioOwnerTest: false,
        baseUrl: config.payOriginUrl || config.appUrl,
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
    for (const a of await listAgents()) {
      if (a.status !== 'PAUSED') {
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
