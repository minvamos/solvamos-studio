/**
 * SolVamos catalog client — solvamos-catalog is the discovery source of truth.
 * Studio publishes listings there and reads them back for A2A / UI enrichment.
 * Payments still settle via x402/MPP gateway (USE_PAY_GATEWAY).
 */
import { config } from './config.js';
import type { AgentRecord } from './agents-store.js';

export type CatalogPublishMode = 'internal';

export type PayShCatalogEntry = {
  catalogId: string;
  agentId: string;
  name: string;
  description: string;
  role: string;
  tone: string;
  invokeUrl: string;
  recipientWallet: string;
  feeUsdc: number;
  token: 'USDC';
  network: string;
  usdcMint: string;
  status: 'listed' | 'unlisted' | 'paused';
  listedAt: string;
  tenantId?: string;
  tags: string[];
  publishedTo?: Array<'internal'>;
  pageUrl?: string;
  apiUrl?: string;
  markdownUrl?: string;
  originInvokeUrl?: string;
  agentCardUrl?: string;
  paymentProtocol?: string;
};

/** In-memory mirror of the remote catalog (solvamos-catalog). */
let catalog: Record<string, PayShCatalogEntry> = {};
let lastFetchAt = 0;
const CACHE_TTL_MS = 15_000;

function catalogSite(): string {
  return (config.catalogSiteUrl || '').replace(/\/$/, '');
}

function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.catalogAdminSecret) {
    headers['X-Catalog-Admin-Secret'] = config.catalogAdminSecret;
  }
  return headers;
}

function fromRemoteAgent(row: any): PayShCatalogEntry | null {
  const agentId = String(row.agentId || row.agent_id || '');
  if (!agentId) return null;
  return {
    catalogId: String(row.catalogId || row.catalog_id || `solvamos_${agentId}`),
    agentId,
    name: String(row.name || row.title || agentId),
    description: String(row.description || ''),
    role: String(row.role || ''),
    tone: String(row.tone || ''),
    invokeUrl: String(row.invokeUrl || row.invoke_url || row.publicInvokeUrl || ''),
    recipientWallet: String(row.recipientWallet || row.recipient_wallet || ''),
    feeUsdc: Number(row.feeUsdc ?? row.fee_usdc ?? 0) || 0,
    token: 'USDC',
    network: String(row.network || config.paymentNetwork),
    usdcMint: String(row.usdcMint || row.usdc_mint || config.usdcMint),
    status: (row.status as PayShCatalogEntry['status']) || 'listed',
    listedAt: String(row.listedAt || row.listed_at || new Date().toISOString()),
    tenantId: row.tenantId || row.tenant_id ? String(row.tenantId || row.tenant_id) : undefined,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    publishedTo: ['internal'],
    pageUrl: row.pageUrl || row.page_url,
    apiUrl: row.apiUrl || row.api_url,
    markdownUrl: row.markdownUrl || row.markdown_url,
    originInvokeUrl: row.originInvokeUrl || row.origin_invoke_url,
    agentCardUrl: row.agentCardUrl || row.agent_card_url,
    paymentProtocol: row.paymentProtocol || row.payment_protocol,
  };
}

export async function refreshCatalogFromRemote(opts?: {
  tenantId?: string;
  force?: boolean;
}): Promise<void> {
  const site = catalogSite();
  if (!site) return;
  if (!opts?.force && Date.now() - lastFetchAt < CACHE_TTL_MS && Object.keys(catalog).length > 0) {
    return;
  }
  const qs = new URLSearchParams();
  // Prefer this Studio's listings when filtering
  qs.set('studioOrigin', config.appUrl.replace(/\/$/, ''));
  if (opts?.tenantId) qs.set('tenantId', opts.tenantId);
  const url = `${site}/api/catalog?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.agents) ? json.agents : [];
    const next: Record<string, PayShCatalogEntry> = {};
    for (const row of rows) {
      const entry = fromRemoteAgent(row);
      if (entry && entry.status === 'listed') next[entry.agentId] = entry;
    }
    // If studioOrigin filter returned empty but catalog has global agents, fetch unfiltered once
    if (Object.keys(next).length === 0 && !opts?.tenantId) {
      const resAll = await fetch(`${site}/api/catalog`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (resAll.ok) {
        const all = (await resAll.json()) as any;
        const allRows = Array.isArray(all.data) ? all.data : Array.isArray(all.agents) ? all.agents : [];
        for (const row of allRows) {
          const entry = fromRemoteAgent(row);
          if (entry && entry.status === 'listed') next[entry.agentId] = entry;
        }
      }
    }
    catalog = next;
    lastFetchAt = Date.now();
    console.log(`[catalog-client] synced ${Object.keys(catalog).length} from ${site}`);
  } catch (err: any) {
    console.warn('[catalog-client] refresh failed', err?.message || err);
  }
}

export function loadPayShCatalog() {
  // Kick off async sync; callers that need fresh data await refreshCatalogFromRemote.
  void refreshCatalogFromRemote({ force: true });
  console.log(
    `[catalog-client] site=${catalogSite() || '(unset — local-only until CATALOG_SITE_URL)'} secret=${
      config.catalogAdminSecret ? 'set' : 'unset'
    }`
  );
}

export function getCatalogPublishMode(): CatalogPublishMode {
  return 'internal';
}

export function setCatalogPublishMode(
  _mode: string
): { ok: boolean; error?: string; mode?: CatalogPublishMode } {
  return {
    ok: false,
    error:
      'Catalog publish mode is fixed. Public discovery lives on solvamos-catalog (CATALOG_SITE_URL).',
    mode: 'internal',
  };
}

export function catalogPublishInfo() {
  const listed = Object.values(catalog).filter((e) => e.status === 'listed').length;
  const site = catalogSite();
  return {
    publishMode: 'internal' as const,
    platformOnly: true,
    remoteUrlConfigured: !!site,
    remoteUrl: site || null,
    catalogSiteUrl: site || null,
    labMainMirror: false,
    modes: [
      {
        id: 'internal' as const,
        label: 'SolVamos Catalog',
        description: '공개 디스커버리는 solvamos-catalog 저장소. Studio는 등록·조회 클라이언트.',
      },
    ],
    counts: {
      internal: listed,
      platform: listed,
      main: 0,
    },
  };
}

export function listCatalog(opts?: {
  listedOnly?: boolean;
  scope?: 'internal' | 'main' | 'all';
}): PayShCatalogEntry[] {
  const listedOnly = opts?.listedOnly !== false;
  const rows = Object.values(catalog);
  return listedOnly ? rows.filter((e) => e.status === 'listed') : rows;
}

export function listCatalogForA2A(): PayShCatalogEntry[] {
  return listCatalog({ listedOnly: true });
}

export function getCatalogEntry(agentId: string): PayShCatalogEntry | undefined {
  return catalog[agentId];
}

export function enrichCatalogListing(
  entry: PayShCatalogEntry,
  publicBaseUrl: string
): PayShCatalogEntry & {
  catalogPageUrl: string;
  catalogApiUrl: string;
  agentCardUrl: string;
  publicInvokeUrl: string;
  originInvokeUrl: string;
  paymentProtocol: string;
} {
  const base = publicBaseUrl.replace(/\/$/, '');
  const site = catalogSite();
  const originInvokeUrl =
    entry.originInvokeUrl || `${base}/api/agents/${encodeURIComponent(entry.agentId)}/invoke`;
  const hasPublicGateway =
    entry.feeUsdc > 0 &&
    /^https:\/\//i.test(entry.invokeUrl) &&
    !/localhost|127\.0\.0\.1/i.test(entry.invokeUrl);
  return {
    ...entry,
    catalogPageUrl: entry.pageUrl || (site ? `${site}/a/${encodeURIComponent(entry.agentId)}` : `${site || base}/marketplace`),
    catalogApiUrl: site ? `${site}/api/catalog` : `${base}/api/catalog`,
    agentCardUrl:
      entry.agentCardUrl || `${base}/api/agents/${encodeURIComponent(entry.agentId)}/agent-card`,
    publicInvokeUrl: hasPublicGateway ? entry.invokeUrl : originInvokeUrl,
    originInvokeUrl,
    paymentProtocol: entry.paymentProtocol || (entry.feeUsdc > 0 ? 'x402 / MPP' : 'free'),
  };
}

export function buildInvokeUrl(agentId: string, baseUrl?: string): string {
  if (config.usePayGateway) {
    const gw = (process.env.PAY_GATEWAY_URL || config.payGatewayUrl || 'http://127.0.0.1:1402').replace(
      /\/$/,
      ''
    );
    return `${gw}/v1/agents/${agentId}/invoke`;
  }
  const base = (baseUrl || config.appUrl || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/agents/${agentId}/invoke`;
}

function buildLocalEntry(
  agent: AgentRecord,
  opts?: { baseUrl?: string; description?: string }
): PayShCatalogEntry {
  const name = agent.agentName || agent.customRole || `${agent.role} / ${agent.tone}`;
  const configuredFee =
    typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : config.defaultAgentFeeUsdc;
  const fee =
    config.usePayGateway && configuredFee > 0 ? config.payGatewayPriceUsdc : configuredFee;
  const originBase = (opts?.baseUrl || config.appUrl || 'http://localhost:3000').replace(/\/$/, '');
  const existing = catalog[agent.id];
  return {
    catalogId: `solvamos_${agent.id}`,
    agentId: agent.id,
    name,
    description:
      opts?.description ||
      `SolVamos RAG agent (${agent.role}). A2A discovery + x402/MPP USDC paywall when paid.`,
    role: agent.role,
    tone: agent.tone,
    invokeUrl:
      fee === 0 ? `${originBase}/api/agents/${agent.id}/invoke` : buildInvokeUrl(agent.id, opts?.baseUrl),
    originInvokeUrl: `${originBase}/api/agents/${agent.id}/invoke`,
    agentCardUrl: `${originBase}/api/agents/${agent.id}/agent-card`,
    recipientWallet: agent.publicKey,
    feeUsdc: fee,
    token: 'USDC',
    network: config.paymentNetwork,
    usdcMint: config.usdcMint,
    status: agent.status === 'PAUSED' ? 'paused' : 'listed',
    listedAt: existing?.listedAt || new Date().toISOString(),
    tenantId: agent.tenantId,
    tags: ['solvamos', 'a2a', 'x402', 'mpp', agent.role, agent.tone].filter(Boolean),
    publishedTo: ['internal'],
    paymentProtocol: fee > 0 ? 'x402 / MPP' : 'free',
  };
}

async function publishToRemote(entry: PayShCatalogEntry): Promise<PayShCatalogEntry> {
  const site = catalogSite();
  if (!site) return entry;
  const res = await fetch(`${site}/api/catalog/agents`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      studioOrigin: config.appUrl.replace(/\/$/, ''),
      listing: entry,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(json.message || `catalog publish HTTP ${res.status}`);
  }
  const remote = json.data ? fromRemoteAgent(json.data) : json.agent ? fromRemoteAgent(json.agent) : null;
  return remote || entry;
}

/** Register / refresh agent on solvamos-catalog (source of truth). */
export async function registerAgentOnPayShCatalog(
  agent: AgentRecord,
  opts?: {
    baseUrl?: string;
    description?: string;
    publishMode?: string;
  }
): Promise<PayShCatalogEntry> {
  const entry = buildLocalEntry(agent, opts);
  try {
    const published = await publishToRemote(entry);
    catalog[agent.id] = published;
    lastFetchAt = 0; // invalidate so next list refreshes
    return published;
  } catch (err: any) {
    console.warn('[catalog-client] publish failed, keeping local mirror', err?.message || err);
    catalog[agent.id] = entry;
    return entry;
  }
}

export async function unlistFromCatalog(agentId: string) {
  if (catalog[agentId]) {
    catalog[agentId] = { ...catalog[agentId], status: 'unlisted' };
  }
  const site = catalogSite();
  if (!site) return;
  try {
    await fetch(`${site}/api/catalog/agents/${encodeURIComponent(agentId)}/unlist`, {
      method: 'POST',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err: any) {
    console.warn('[catalog-client] unlist failed', err?.message || err);
  }
}

/** Push all local agents to catalog (hydrate after catalog cold start). */
export async function hydrateCatalogRemote(
  agents: AgentRecord[],
  opts?: { baseUrl?: string }
): Promise<number> {
  const site = catalogSite();
  if (!site || agents.length === 0) return 0;
  const listings = agents.map((a) => buildLocalEntry(a, opts));
  try {
    const res = await fetch(`${site}/api/catalog/agents/bulk`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        studioOrigin: config.appUrl.replace(/\/$/, ''),
        agents: listings,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`bulk HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    await refreshCatalogFromRemote({ force: true });
    return listings.length;
  } catch (err: any) {
    console.warn('[catalog-client] hydrate failed', err?.message || err);
    return 0;
  }
}
