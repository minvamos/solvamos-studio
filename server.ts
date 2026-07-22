/**
 * SolVamos Studio — Express API + Vite (dev) / static (prod)
 * Cloud Run paywall gateway + Vertex AI Search RAG
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';

import { compileSystemPrompt } from './server/prompt.js';
import { savePrivateKeyToGCP } from './server/vault.js';
import { verifyPayment } from './server/payment.js';
import { ensureDriveDataStore, generateGroundedAnswer } from './server/rag.js';
import { registerDriveAuthRoutes } from './server/drive-oauth.js';
import { loadTenants, listTenants, getTenant, upsertTenant } from './server/tenants.js';
import { provisionCustomerProject, plannedProjectId } from './server/provision.js';
import { config, assertProductionSafety, networkLabel } from './server/config.js';
import {
  loadAgents,
  listAgents,
  getAgent,
  putAgent,
  bumpInvoke,
  type AgentRecord,
} from './server/agents-store.js';

dotenv.config();
assertProductionSafety();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

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

loadTenants();
loadAgents();
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

app.get('/api/status', (req, res) => {
  res.json({
    product: config.product,
    version: config.version,
    geminiConfigured: !!config.geminiApiKey,
    gcpProject: config.gcpProject || null,
    tenantId: config.tenantId || null,
    tier: config.tier,
    vertexDataStore: config.vertexDataStoreId || null,
    oauthConfigured: !!(config.googleClientId && config.googleClientSecret),
    allowLocalVaultFallback: config.allowLocalVaultFallback,
    allowPaymentBypass: config.allowPaymentBypass,
    paymentNetwork: config.paymentNetwork,
    networkLabel: networkLabel(),
    solanaRpcUrl: config.solanaRpcUrl,
    usdcMint: config.usdcMint,
    platformFeeShare: config.platformFeeShare,
    platformTreasuryConfigured: !!config.platformTreasuryPubkey,
    defaultAgentFeeUsdc: config.defaultAgentFeeUsdc,
    apiEndpoint: `${req.protocol}://${req.get('host')}`,
    totalAgents: listAgents().length,
    totalTenants: listTenants().length,
  });
});

app.get('/api/tenants', (_req, res) => {
  res.json({ status: 'success', data: listTenants() });
});

app.post('/api/tenants', async (req, res) => {
  try {
    const { tenantId, displayName, tier, byoProjectId } = req.body;
    if (!tenantId || !displayName) {
      res.status(400).json({ status: 'error', message: 'tenantId and displayName required' });
      return;
    }
    if (getTenant(tenantId) && !byoProjectId) {
      res.status(409).json({
        status: 'error',
        message: 'Tenant already exists',
        tenant: getTenant(tenantId),
      });
      return;
    }
    const tenant = await provisionCustomerProject({
      tenantId,
      displayName,
      tier,
      byoProjectId,
    });
    res.status(201).json({
      status: 'success',
      tenant,
      plannedProjectId: plannedProjectId(tenantId),
      note:
        'Default path: SolVamos Org manages cust-* projects. BYO only when customer IT provides projectId.',
      terraformHint: `solvamos-cloudrun / infra customer-project project_id=${tenant.projectId}`,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/tenants/:id', (req, res) => {
  const t = getTenant(req.params.id);
  if (!t) {
    res.status(404).json({ status: 'error', message: 'Tenant not found' });
    return;
  }
  res.json({ status: 'success', tenant: t });
});

app.patch('/api/tenants/:id', (req, res) => {
  const existing = getTenant(req.params.id);
  if (!existing) {
    res.status(404).json({ status: 'error', message: 'Tenant not found' });
    return;
  }
  const updated = upsertTenant({ ...existing, ...req.body, tenantId: existing.tenantId });
  res.json({ status: 'success', tenant: updated });
});

app.get('/api/agents', (_req, res) => {
  res.json({ status: 'success', data: listAgents() });
});

app.post('/api/agents/create', async (req, res) => {
  try {
    const {
      role,
      tone,
      securityLevel,
      customRole,
      googleDriveFolderId,
      tenantId,
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

    const solvamosKeypair = Keypair.generate();
    const publicKey = solvamosKeypair.publicKey.toBase58();
    const secretKeyBase64 = Buffer.from(solvamosKeypair.secretKey).toString('base64');
    const agentId = `${role}-${tone}-${Math.random().toString(36).substr(2, 6)}`;
    const systemPrompt = compileSystemPrompt(role, tone, securityLevel, customRole);

    let vertexDataStoreId: string | undefined;
    let indexingStatus: AgentRecord['status'] = 'ACTIVE';
    if (googleDriveFolderId) {
      const ds = await ensureDriveDataStore({
        displayName: agentName || agentId,
        driveFolderId: googleDriveFolderId,
      });
      vertexDataStoreId = ds.dataStoreId;
      indexingStatus = ds.status === 'pending' ? 'INDEXING' : 'ACTIVE';
    }

    const gcpStorage = await savePrivateKeyToGCP(agentId, secretKeyBase64);

    const parsedFee =
      typeof fee === 'number'
        ? fee
        : typeof perCallPriceUsdc === 'number'
          ? perCallPriceUsdc
          : config.defaultAgentFeeUsdc;

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
      googleDriveFolderId,
      vertexDataStoreId,
      secretManagerPath: gcpStorage.path,
      status: indexingStatus,
      fee: parsedFee,
      perCallPriceUsdc: parsedFee,
    };

    putAgent(newAgent);

    res.status(201).json({
      status: 'success',
      agentId,
      publicKey,
      gcpVaultPath: gcpStorage.path,
      isGcpMocked: gcpStorage.mock,
      vertexDataStoreId,
      agent: newAgent,
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

app.get('/api/agents/:id/balance', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ status: 'error', message: 'Agent not found' });
    return;
  }
  res.json({
    status: 'success',
    agentId: agent.id,
    solanaPubkey: agent.publicKey,
    payShConnected: true,
    currentUsdcBalance: null,
    note: 'USDC SPL balance audit is Solana workstream; pubkey exposed for RPC clients',
  });
});

app.post('/api/agents/:id/invoke', async (req, res) => {
  try {
    const agentId = req.params.id;
    const { prompt, query } = req.body;
    const userPrompt = prompt || query;
    const paymentProof =
      (req.headers['x-payment-proof'] as string) ||
      (req.headers['x-pay-sh-proof'] as string);

    const agent = getAgent(agentId);
    if (!agent) {
      res.status(404).json({ status: 'error', message: `Agent with ID ${agentId} not found.` });
      return;
    }
    if (!userPrompt) {
      res.status(400).json({ status: 'error', message: 'Missing input parameter: prompt' });
      return;
    }

    const feeAmount =
      typeof agent.fee === 'number'
        ? agent.fee
        : typeof agent.perCallPriceUsdc === 'number'
          ? agent.perCallPriceUsdc
          : config.defaultAgentFeeUsdc;

    const runRag = async (paymentLogs: string[]) => {
      const rag = await generateGroundedAnswer({
        systemPrompt: agent.systemPrompt,
        userPrompt,
        dataStoreId: agent.vertexDataStoreId,
        geminiApiKey: config.geminiApiKey || undefined,
      });
      bumpInvoke(agentId);
      res.json({
        status: 'success',
        answer: rag.answer,
        data: rag.answer,
        confidence: rag.confidence,
        citations: rag.citations,
        ragMode: rag.mode,
        paymentLogs,
        network: networkLabel(),
        feeUsdc: feeAmount,
      });
    };

    // Free tier — no paywall
    if (feeAmount === 0) {
      await runRag([`[Free Tier] fee=0 USDC — paywall skipped on ${networkLabel()}`]);
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
        message: `HTTP 402: Pay ${feeAmount} USDC on ${networkLabel()} (≈${(agentShare * 100).toFixed(0)}% agent / ${(config.platformFeeShare * 100).toFixed(0)}% platform). Attach signature in X-PAYMENT-PROOF.`,
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

    await runRag(audit.logs);
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

async function startServer() {
  if (config.nodeEnv !== 'production') {
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

startServer();
