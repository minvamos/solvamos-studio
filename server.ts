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
import { ensureDriveDataStore, syncLocalCorpusToVertex } from './server/rag.js';
import { ingestDriveSourceForAgent } from './server/drive-ingest.js';
import { registerDriveAuthRoutes, isDriveAuthAvailable, isOAuthClientConfigured, requireGoogleSession, resolveSessionId, getSession } from './server/drive-oauth.js';
import { loadTenants, listTenants, getTenant, upsertTenant } from './server/tenants.js';
import { provisionCustomerProject, plannedProjectId, buildProvisionPlan, resolveTenancyMode } from './server/provision.js';
import { provisionTenantCloudRun } from './server/cloudrun-provision.js';
import { config, assertProductionSafety, networkLabel, setPaymentNetwork, paymentNetworkInfo } from './server/config.js';
import {
  loadAgents,
  listAgents,
  getAgent,
  putAgent,
  bumpInvoke,
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
import { orchestrateA2ATurn } from './server/a2a.js';
import { connectDb } from './server/db.js';
import { registerPlatformAuthRoutes } from './server/auth-routes.js';
import { getMeFromRequest } from './server/platform-auth.js';
import { sharedTenantId, ensureSharedCustomerTenant } from './server/tenant-seed.js';

dotenv.config();
assertProductionSafety();

const app = express();
app.use(express.json({ limit: '1mb' }));
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
    sandboxProofsAllowed: config.paymentNetwork === 'sandbox' || config.allowPaymentBypass,
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

    if (googleDriveFolderId && !sid) {
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
      secretManagerPath: gcpStorage.path,
      status: 'CREATING',
      fee: parsedFeeEarly,
      perCallPriceUsdc: parsedFeeEarly,
    });
    pipeline.push({ step: 'agent_record_draft', status: 'ok', detail: agentId });

    let vertexDataStoreId: string | undefined;
    let indexingStatus: AgentRecord['status'] = 'ACTIVE';
    let driveIngest: { docs: number; message?: string } | null = null;

    if (googleDriveFolderId) {
      const ds = await ensureDriveDataStore({
        displayName: agentName || agentId,
        driveFolderId: String(googleDriveFolderId),
      });
      vertexDataStoreId = ds.dataStoreId;
      indexingStatus =
        ds.status === 'pending' || ds.status === 'error' ? 'INDEXING' : 'ACTIVE';
      pipeline.push({
        step: 'vertex_datastore',
        status: ds.status === 'created' || ds.status === 'existing' ? 'ok' : 'warn',
        detail: `${ds.message || ds.dataStoreId}${
          (ds as any).engineId ? ` engine=${(ds as any).engineId}` : ''
        }`,
      });

      try {
        const corpus = await ingestDriveSourceForAgent({
          sessionId: sid!,
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
              : 'No text-extractable files (Docs/Sheets/txt/md/json). PDF는 현재 스킵됩니다.',
        });

        if (vertexDataStoreId && corpus.docs.length > 0 && ds.status !== 'error') {
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
    } else {
      pipeline.push({
        step: 'drive_rag',
        status: 'skip',
        detail: 'No Drive folder/file selected — answers without RAG grounding',
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

    const folderChanged =
      googleDriveFolderId !== undefined &&
      String(googleDriveFolderId || '') !== String(existing.googleDriveFolderId || '');

    let vertexDataStoreId = existing.vertexDataStoreId;
    let driveIngest: { docs: number } | null = null;
    let indexingStatus = nextStatus;

    if (folderChanged && googleDriveFolderId) {
      const me = await getMeFromRequest(req);
      const sid = me.sessionId || (await resolveSessionId(req));
      if (!sid) {
        res.status(401).json({
          status: 'error',
          message: 'Drive 연동이 필요합니다. 마이페이지에서 Google을 연결하세요.',
        });
        return;
      }
      const ds = await ensureDriveDataStore({
        displayName: nextName || existing.id,
        driveFolderId: String(googleDriveFolderId),
      });
      vertexDataStoreId = ds.dataStoreId;
      try {
        const corpus = await ingestDriveSourceForAgent({
          sessionId: sid,
          agentId: existing.id,
          driveSourceId: String(googleDriveFolderId),
        });
        driveIngest = { docs: corpus.docs.length };
        if (vertexDataStoreId && corpus.docs.length > 0 && ds.status !== 'error') {
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
      googleDriveFolderId:
        googleDriveFolderId !== undefined
          ? googleDriveFolderId
            ? String(googleDriveFolderId)
            : undefined
          : existing.googleDriveFolderId,
      vertexDataStoreId,
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

/** Runtime payment network switch — sandbox (test) ↔ devnet (product path) */
app.get('/api/payment/network', (_req, res) => {
  res.json({ status: 'success', ...paymentNetworkInfo() });
});

app.post('/api/payment/network', (req, res) => {
  const network = String(req.body?.network || '').toLowerCase();
  const result = setPaymentNetwork(network as any, {
    rpcUrl: req.body?.rpcUrl,
    usdcMint: req.body?.usdcMint,
  });
  if (!result.ok) {
    res.status(config.isProd ? 403 : 400).json({ status: 'error', message: result.error });
    return;
  }
  res.json({
    status: 'success',
    message: `Payment network switched to ${config.paymentNetwork}`,
    ...paymentNetworkInfo(),
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

    // Must be on pay.sh catalog to participate in A2A commerce
    let listing = getCatalogEntry(agentId);
    if (!listing || listing.status !== 'listed') {
      listing = await registerAgentOnPayShCatalog(agent, {
        baseUrl: `${req.protocol}://${req.get('host')}`,
      });
    }

    const feeAmount =
      typeof agent.fee === 'number'
        ? agent.fee
        : typeof agent.perCallPriceUsdc === 'number'
          ? agent.perCallPriceUsdc
          : config.defaultAgentFeeUsdc;

    // Studio sandbox: logged-in operator tests their agent → Vertex/RAG, no human→agent paywall.
    // External / catalog callers still hit x402 when fee>0.
    const me = await getMeFromRequest(req);
    const isStudioOwnerTest =
      (studioTest === true || req.headers['x-solvamos-studio'] === '1') && me.connected === true;

    const runOrchestrated = async (paymentLogs: string[]) => {
      const result = await orchestrateA2ATurn({
        agent,
        userPrompt,
        // Studio chat: answer via own Vertex/RAG first; peers only if explicitly enabled
        enablePeers: isStudioOwnerTest ? enableA2A === true : enableA2A !== false,
      });
      await bumpInvoke(agentId);
      res.json({
        status: 'success',
        answer: result.answer,
        data: result.answer,
        confidence: result.confidence,
        citations: result.citations,
        ragMode: result.ragMode,
        paymentLogs,
        network: networkLabel(),
        feeUsdc: isStudioOwnerTest ? 0 : feeAmount,
        paywallSkipped: isStudioOwnerTest,
        payShCatalogId: listing!.catalogId,
        generation: 'vertex_gemini_rag',
        a2a: {
          catalogUsed: result.catalogUsed,
          planningNote: result.planningNote,
          peerHops: result.peerHops,
          spendTier: result.spendTier,
        },
      });
    };

    if (isStudioOwnerTest) {
      await runOrchestrated([
        `[Studio Test] owner session — paywall skipped, Vertex Gemini + RAG (listed fee=${feeAmount} USDC still applies to external callers)`,
      ]);
      return;
    }

    // Free tier — no paywall
    if (feeAmount === 0) {
      await runOrchestrated([`[Free Tier] fee=0 USDC — paywall skipped on ${networkLabel()}`]);
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
        payShCatalogId: listing.catalogId,
        invokeUrl: listing.invokeUrl,
        message: `HTTP 402: Pay ${feeAmount} USDC on ${networkLabel()} (≈${(agentShare * 100).toFixed(0)}% agent / ${(config.platformFeeShare * 100).toFixed(0)}% platform). Attach signature in X-PAYMENT-PROOF. Agent is listed on pay.sh catalog for A2A.`,
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

    await runOrchestrated(audit.logs);
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

async function startServer() {
  if (process.env.DATABASE_URL) {
    try {
      await connectDb();
    } catch (err: any) {
      console.error('[db] connect failed — sessions will use file cache only', err?.message || err);
      if (config.isProd) throw err;
    }
  } else {
    console.warn('[db] DATABASE_URL unset — JWT refresh works, but Google tokens won’t survive restarts');
  }

  await loadTenants();
  await ensureSharedCustomerTenant();
  await loadAgents();
  for (const a of await listAgents()) {
    if (a.status !== 'PAUSED') {
      void registerAgentOnPayShCatalog(a);
    }
  }

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
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[${config.product}] v${config.version} http://0.0.0.0:${config.port}`);
  });
}

startServer().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
