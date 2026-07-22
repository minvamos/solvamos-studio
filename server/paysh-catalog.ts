/**
 * pay.sh catalog — internal (this Studio) vs main (external / lab-main mirror).
 *
 * Dev publish modes:
 * - internal: only local Studio catalog (A2A on this instance)
 * - main: publish to PAYSH_CATALOG_URL when set, else lab mirror file paysh-catalog-main.json
 * - both: internal + main
 */
import fs from 'fs';
import { config } from './config.js';
import type { AgentRecord } from './agents-store.js';
import { dataFile, ensureDataDir } from './data-paths.js';

export type CatalogPublishMode = 'internal' | 'main' | 'both';

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
  /** Where this listing was written */
  publishedTo?: Array<'internal' | 'main'>;
  remotePublish?: {
    attempted: boolean;
    ok: boolean;
    url?: string;
    message?: string;
  };
};

const INTERNAL_FILE = dataFile('paysh-catalog.json');
const MAIN_FILE = dataFile('paysh-catalog-main.json');

let internalCatalog: Record<string, PayShCatalogEntry> = {};
let mainCatalog: Record<string, PayShCatalogEntry> = {};

/** Runtime publish target (dev UI). Env PAYSH_CATALOG_PUBLISH can seed it. */
let publishMode: CatalogPublishMode = resolveInitialMode();

function resolveInitialMode(): CatalogPublishMode {
  const raw = (process.env.PAYSH_CATALOG_PUBLISH || process.env.PAYSH_CATALOG_MODE || 'internal')
    .toLowerCase()
    .trim();
  if (raw === 'main' || raw === 'remote') return 'main';
  if (raw === 'both' || raw === 'all') return 'both';
  return 'internal';
}

function loadFile(path: string): Record<string, PayShCatalogEntry> {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch (err) {
    console.error('[pay.sh catalog] load failed', path, err);
  }
  return {};
}

function saveFile(path: string, data: Record<string, PayShCatalogEntry>) {
  try {
    ensureDataDir();
    fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[pay.sh catalog] save failed', path, err);
  }
}

export function loadPayShCatalog() {
  internalCatalog = loadFile(INTERNAL_FILE);
  mainCatalog = loadFile(MAIN_FILE);
  console.log(
    `[pay.sh catalog] internal=${Object.keys(internalCatalog).length} main=${Object.keys(mainCatalog).length} publishMode=${publishMode}`
  );
}

export function getCatalogPublishMode(): CatalogPublishMode {
  return publishMode;
}

export function setCatalogPublishMode(
  mode: string
): { ok: boolean; error?: string; mode?: CatalogPublishMode } {
  if (config.isProd && (mode === 'main' || mode === 'both' || mode === 'remote')) {
    // Allow in prod only when remote URL configured
    if (!process.env.PAYSH_CATALOG_URL?.trim()) {
      return {
        ok: false,
        error: 'Production main catalog requires PAYSH_CATALOG_URL',
      };
    }
  }
  const m = mode.toLowerCase();
  if (m === 'internal' || m === 'local') {
    publishMode = 'internal';
  } else if (m === 'main' || m === 'remote') {
    publishMode = 'main';
  } else if (m === 'both' || m === 'all') {
    publishMode = 'both';
  } else {
    return { ok: false, error: 'mode must be internal | main | both' };
  }
  console.log(`[pay.sh catalog] publishMode → ${publishMode}`);
  return { ok: true, mode: publishMode };
}

export function catalogPublishInfo() {
  const remoteUrl = process.env.PAYSH_CATALOG_URL?.trim() || null;
  return {
    publishMode,
    remoteUrlConfigured: !!remoteUrl,
    remoteUrl: remoteUrl ? remoteUrl.replace(/\/$/, '') : null,
    labMainMirror: !remoteUrl,
    modes: [
      {
        id: 'internal' as const,
        label: '내부',
        description: '이 SolVamos 인스턴스 카탈로그만 (로컬 A2A)',
      },
      {
        id: 'main' as const,
        label: '메인',
        description: remoteUrl
          ? `외부 pay.sh 카탈로그 (${remoteUrl})`
          : 'Lab 메인 미러 파일 (PAYSH_CATALOG_URL 미설정 시)',
      },
      {
        id: 'both' as const,
        label: '둘 다',
        description: '내부 + 메인에 동시 게시',
      },
    ],
    counts: {
      internal: Object.values(internalCatalog).filter((e) => e.status === 'listed').length,
      main: Object.values(mainCatalog).filter((e) => e.status === 'listed').length,
    },
  };
}

export function listCatalog(opts?: {
  listedOnly?: boolean;
  scope?: 'internal' | 'main' | 'all';
}): PayShCatalogEntry[] {
  const scope = opts?.scope || 'all';
  const listedOnly = opts?.listedOnly !== false;
  const pick = (map: Record<string, PayShCatalogEntry>) => {
    const rows = Object.values(map);
    return listedOnly ? rows.filter((e) => e.status === 'listed') : rows;
  };

  if (scope === 'internal') return pick(internalCatalog);
  if (scope === 'main') return pick(mainCatalog);

  // Merge: prefer internal entry, annotate publishedTo
  const byId: Record<string, PayShCatalogEntry> = {};
  for (const e of pick(mainCatalog)) {
    byId[e.agentId] = { ...e, publishedTo: Array.from(new Set([...(e.publishedTo || []), 'main'])) };
  }
  for (const e of pick(internalCatalog)) {
    const prev = byId[e.agentId];
    byId[e.agentId] = {
      ...e,
      publishedTo: Array.from(
        new Set([...(prev?.publishedTo || []), ...(e.publishedTo || []), 'internal'])
      ) as Array<'internal' | 'main'>,
      remotePublish: e.remotePublish || prev?.remotePublish,
    };
  }
  return Object.values(byId);
}

/** A2A discovery uses internal (+ main when publish mode includes main). */
export function listCatalogForA2A(): PayShCatalogEntry[] {
  if (publishMode === 'main') return listCatalog({ scope: 'main', listedOnly: true });
  if (publishMode === 'both') return listCatalog({ scope: 'all', listedOnly: true });
  return listCatalog({ scope: 'internal', listedOnly: true });
}

export function getCatalogEntry(agentId: string): PayShCatalogEntry | undefined {
  return internalCatalog[agentId] || mainCatalog[agentId];
}

export function buildInvokeUrl(agentId: string, baseUrl?: string): string {
  const base = (baseUrl || config.appUrl || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/agents/${agentId}/invoke`;
}

async function publishToRemote(entry: PayShCatalogEntry): Promise<PayShCatalogEntry['remotePublish']> {
  const remote = process.env.PAYSH_CATALOG_URL?.trim();
  if (!remote) {
    return {
      attempted: false,
      ok: true,
      message: 'No PAYSH_CATALOG_URL — wrote lab main mirror only',
    };
  }
  const url = `${remote.replace(/\/$/, '')}/listings`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.PAYSH_CATALOG_API_KEY
          ? { Authorization: `Bearer ${process.env.PAYSH_CATALOG_API_KEY}` }
          : {}),
      },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        attempted: true,
        ok: false,
        url,
        message: `Remote ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    return { attempted: true, ok: true, url, message: 'Published to remote main catalog' };
  } catch (err: any) {
    return {
      attempted: true,
      ok: false,
      url,
      message: err?.message || 'Remote publish failed',
    };
  }
}

function targetsForMode(mode: CatalogPublishMode): Array<'internal' | 'main'> {
  if (mode === 'main') return ['main'];
  if (mode === 'both') return ['internal', 'main'];
  return ['internal'];
}

/** Register / refresh agent on catalog(s) according to publish mode. */
export async function registerAgentOnPayShCatalog(
  agent: AgentRecord,
  opts?: {
    baseUrl?: string;
    description?: string;
    /** Override runtime publish mode for this call */
    publishMode?: CatalogPublishMode;
  }
): Promise<PayShCatalogEntry> {
  const mode = opts?.publishMode || publishMode;
  const targets = targetsForMode(mode);

  const name =
    agent.agentName || agent.customRole || `${agent.role} / ${agent.tone}`;
  const fee =
    typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : config.defaultAgentFeeUsdc;

  const existing = internalCatalog[agent.id] || mainCatalog[agent.id];
  let entry: PayShCatalogEntry = {
    catalogId: `paysh_${agent.id}`,
    agentId: agent.id,
    name,
    description:
      opts?.description ||
      `SolVamos A2A agent (${agent.role}). Grounded RAG + x402 USDC paywall.`,
    role: agent.role,
    tone: agent.tone,
    invokeUrl: buildInvokeUrl(agent.id, opts?.baseUrl),
    recipientWallet: agent.publicKey,
    feeUsdc: fee,
    token: 'USDC',
    network: config.paymentNetwork,
    usdcMint: config.usdcMint,
    status: agent.status === 'PAUSED' ? 'paused' : 'listed',
    listedAt: existing?.listedAt || new Date().toISOString(),
    tenantId: agent.tenantId,
    tags: ['solvamos', 'a2a', 'x402', agent.role, agent.tone, `publish:${mode}`].filter(Boolean),
    publishedTo: [],
  };

  if (targets.includes('internal')) {
    entry = {
      ...entry,
      publishedTo: [...(entry.publishedTo || []), 'internal'],
    };
    internalCatalog[agent.id] = entry;
    saveFile(INTERNAL_FILE, internalCatalog);
  }

  if (targets.includes('main')) {
    const remotePublish = await publishToRemote(entry);
    entry = {
      ...entry,
      publishedTo: Array.from(new Set([...(entry.publishedTo || []), 'main'])) as Array<
        'internal' | 'main'
      >,
      remotePublish,
    };
    mainCatalog[agent.id] = entry;
    saveFile(MAIN_FILE, mainCatalog);
    // Keep internal copy in sync with remote status if also internal
    if (targets.includes('internal')) {
      internalCatalog[agent.id] = entry;
      saveFile(INTERNAL_FILE, internalCatalog);
    }
  }

  return entry;
}

export function unlistFromCatalog(agentId: string) {
  if (internalCatalog[agentId]) {
    internalCatalog[agentId].status = 'unlisted';
    saveFile(INTERNAL_FILE, internalCatalog);
  }
  if (mainCatalog[agentId]) {
    mainCatalog[agentId].status = 'unlisted';
    saveFile(MAIN_FILE, mainCatalog);
  }
}
