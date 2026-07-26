/**
 * Persisted invoke evidence for developer dashboard.
 * Captures citations / tools / datastore / website sources so agents are not black boxes.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './data-paths.js';
import { serverLog } from './dev-log.js';

export type CitationEvidence = {
  title?: string;
  uri?: string;
  snippet?: string;
  sourceType?: string;
};

export type InvokeEvidence = {
  id: string;
  ts: string;
  agentId: string;
  agentName?: string;
  prompt: string;
  answer: string;
  confidence?: number;
  citations: CitationEvidence[];
  toolsUsed: string[];
  ragMode?: string;
  generation?: string;
  engineId?: string | null;
  dataStoreId?: string | null;
  websiteUri?: string;
  dataSourceType?: string;
  aiAppType?: string;
  gcsUri?: string;
  googleDriveFolderId?: string;
  relatedQuestions?: string[];
  retrievalError?: string;
  a2a?: unknown;
  studioOwnerTest?: boolean;
  referencedHosts: string[];
  referencedUrls: string[];
};

const MAX = Math.max(100, Number(process.env.INVOKE_EVIDENCE_BUFFER_SIZE || 500) || 500);
const store: InvokeEvidence[] = [];
let seq = 0;
let hydrated = false;

function evidenceFile() {
  return dataFile('invoke-evidence.json');
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const file = evidenceFile();
    if (!fs.existsSync(file)) return;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as InvokeEvidence[];
    if (Array.isArray(rows)) {
      store.push(...rows.slice(-MAX));
    }
  } catch (err: any) {
    serverLog('warn', 'evidence', `hydrate failed: ${err?.message || err}`);
  }
}

function persist() {
  try {
    ensureDataDir();
    fs.writeFileSync(evidenceFile(), JSON.stringify(store.slice(-MAX), null, 0), 'utf8');
  } catch (err: any) {
    serverLog('warn', 'evidence', `persist failed: ${err?.message || err}`);
  }
}

function extractUrls(citations: CitationEvidence[], answer: string): {
  referencedUrls: string[];
  referencedHosts: string[];
} {
  const urls = new Set<string>();
  for (const c of citations || []) {
    if (c.uri && /^https?:\/\//i.test(c.uri)) urls.add(c.uri);
  }
  const fromAnswer = answer?.match(/https?:\/\/[^\s)\]>'"]+/gi) || [];
  for (const u of fromAnswer) urls.add(u.replace(/[.,;]+$/, ''));

  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      hosts.add(new URL(u).hostname);
    } catch {
      /* ignore */
    }
  }
  return {
    referencedUrls: [...urls].slice(0, 40),
    referencedHosts: [...hosts].slice(0, 40),
  };
}

export function recordInvokeEvidence(
  partial: Omit<InvokeEvidence, 'id' | 'ts' | 'referencedHosts' | 'referencedUrls'> & {
    referencedHosts?: string[];
    referencedUrls?: string[];
  }
): InvokeEvidence {
  hydrate();
  const refs = extractUrls(partial.citations || [], partial.answer || '');
  const entry: InvokeEvidence = {
    ...partial,
    id: `ev_${Date.now().toString(36)}_${(++seq).toString(36)}`,
    ts: new Date().toISOString(),
    citations: partial.citations || [],
    toolsUsed: partial.toolsUsed || [],
    referencedHosts: refs.referencedHosts,
    referencedUrls: refs.referencedUrls,
  };
  store.push(entry);
  while (store.length > MAX) store.shift();
  persist();
  serverLog('info', 'evidence', `Recorded invoke evidence ${entry.id}`, {
    agentId: entry.agentId,
    citations: entry.citations.length,
    tools: entry.toolsUsed,
    hosts: entry.referencedHosts,
    ragMode: entry.ragMode,
  });
  return entry;
}

export function listInvokeEvidence(opts?: {
  agentId?: string;
  q?: string;
  limit?: number;
}): InvokeEvidence[] {
  hydrate();
  let rows = store.slice();
  if (opts?.agentId) rows = rows.filter((r) => r.agentId === opts.agentId);
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.prompt.toLowerCase().includes(q) ||
        r.answer.toLowerCase().includes(q) ||
        r.agentId.toLowerCase().includes(q) ||
        r.referencedHosts.some((h) => h.toLowerCase().includes(q)) ||
        r.citations.some(
          (c) =>
            (c.title || '').toLowerCase().includes(q) ||
            (c.uri || '').toLowerCase().includes(q) ||
            (c.snippet || '').toLowerCase().includes(q)
        )
    );
  }
  const limit = Math.min(Math.max(opts?.limit || 100, 1), MAX);
  return rows.slice(-limit).reverse();
}

export function getInvokeEvidence(id: string): InvokeEvidence | undefined {
  hydrate();
  return store.find((r) => r.id === id);
}

export function clearInvokeEvidence(agentId?: string): number {
  hydrate();
  let n = 0;
  if (!agentId) {
    n = store.length;
    store.length = 0;
  } else {
    for (let i = store.length - 1; i >= 0; i--) {
      if (store[i].agentId === agentId) {
        store.splice(i, 1);
        n += 1;
      }
    }
  }
  persist();
  serverLog('info', 'evidence', `Cleared ${n} evidence row(s)`, { agentId: agentId || 'all' });
  return n;
}

export function evidenceStats() {
  hydrate();
  const byAgent: Record<string, number> = {};
  for (const r of store) byAgent[r.agentId] = (byAgent[r.agentId] || 0) + 1;
  return { total: store.length, max: MAX, byAgent };
}

/** Studio owner-test invokes in the evidence buffer (for display correction of invokeCount). */
export function countStudioOwnerTestsByAgent(agentIds?: string[]): Record<string, number> {
  hydrate();
  const want = agentIds && agentIds.length > 0 ? new Set(agentIds) : null;
  const out: Record<string, number> = {};
  for (const r of store) {
    if (!r.studioOwnerTest) continue;
    if (want && !want.has(r.agentId)) continue;
    out[r.agentId] = (out[r.agentId] || 0) + 1;
  }
  return out;
}
