/**
 * Vertex AI Search / AI Applications (Discovery Engine) —
 * create data store + engine (app) for a chosen app type, then optional import.
 */
import { GoogleAuth } from 'google-auth-library';
import type { LocalRagCorpus } from './drive-ingest.js';
import {
  getAiAppType,
  getDataSourceType,
  type AiAppType,
  type DataSourceType,
} from './ai-applications.js';

function projectId(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function location(): string {
  return process.env.VERTEX_SEARCH_LOCATION || 'global';
}

function collection(): string {
  return process.env.VERTEX_SEARCH_COLLECTION || 'default_collection';
}

function apiHost(): string {
  const loc = location();
  return loc === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${loc}-discoveryengine.googleapis.com`;
}

function parentCollection(): string | null {
  const project = projectId();
  if (!project) return null;
  return `projects/${project}/locations/${location()}/collections/${collection()}`;
}

export async function getGcpAccessToken(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: projectId(),
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token || null;
  } catch (err) {
    console.warn('[vertex-search] ADC token failed', err);
    return null;
  }
}

async function gcpFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getGcpAccessToken();
  if (!token) {
    throw new Error(
      'GCP ADC unavailable. Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS, and GOOGLE_CLOUD_PROJECT.'
    );
  }
  const project = projectId();
  const url = path.startsWith('http') ? path : `${apiHost()}/v1/${path.replace(/^\//, '')}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Required for many ADC identities — without this, Discovery Engine create
      // often returns 403 and engines never appear in AI Applications console.
      ...(project ? { 'X-Goog-User-Project': project } : {}),
      ...(init?.headers || {}),
    },
  });
}

function isSharedLabStore(dataStoreId: string | undefined): boolean {
  if (!dataStoreId) return false;
  const sharedLab =
    process.env.VERTEX_SHARED_DATA_STORE === 'true' ||
    process.env.VERTEX_SHARED_DATA_STORE === '1';
  const configured = process.env.VERTEX_DATA_STORE_ID?.trim();
  return sharedLab && !!configured && dataStoreId === configured;
}

/**
 * Wait for a Discovery Engine LRO.
 * Create responses often already include `done: true`; completed create-data-store
 * ops are then immediately unreadable and GET returns 404 — treat that as success
 * so callers can confirm the resource with a direct GET.
 */
async function waitOperation(
  opName: string,
  timeoutMs = 180_000,
  initial?: { done?: boolean; error?: any; response?: any }
): Promise<any> {
  if (initial?.done) {
    if (initial.error) {
      throw new Error(initial.error.message || JSON.stringify(initial.error));
    }
    return initial.response || initial;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await gcpFetch(opName);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Completed create/delete ops are frequently evicted → 404.
      if (res.status === 404) {
        console.warn(
          '[vertex-search] operation GET 404 (likely already finished):',
          opName.slice(0, 160)
        );
        return { done: true, assumedComplete: true };
      }
      throw new Error(`Operation poll failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    }
    if (json.done) {
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      return json.response || json;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Timed out waiting for operation ${opName}`);
}

function sanitizeId(displayName: string, hint: string): string {
  const safe = displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18);
  const suffix = (hint || 'app').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'app';
  const id = `sv-${safe || 'agent'}-${suffix}-${Date.now().toString(36)}`;
  return id.slice(0, 63);
}

export async function getDataStore(dataStoreId: string): Promise<boolean> {
  const parent = parentCollection();
  if (!parent) return false;
  const res = await gcpFetch(`${parent}/dataStores/${dataStoreId}`);
  return res.ok;
}

type EnsureEngineResult = {
  engineId?: string;
  error?: string;
};

async function waitForDataStoreReady(dataStoreId: string, attempts = 8): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await getDataStore(dataStoreId).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function ensureEngine(opts: {
  dataStoreId: string;
  displayName: string;
  appType: AiAppType;
}): Promise<EnsureEngineResult> {
  const parent = parentCollection();
  if (!parent) return { error: 'GOOGLE_CLOUD_PROJECT not set (no collection parent)' };
  const meta = getAiAppType(opts.appType);
  // Keep suffix intact — do not truncate mid-id after appending -eng.
  const baseId = opts.dataStoreId.slice(0, 59);
  const engineId = `${baseId}-eng`.slice(0, 63);

  const get = await gcpFetch(`${parent}/engines/${engineId}`);
  if (get.ok) return { engineId };

  // Datastore create LRO can report done before GET is consistent — wait briefly.
  const ready = await waitForDataStoreReady(opts.dataStoreId);
  if (!ready) {
    return { error: `Data store ${opts.dataStoreId} not readable yet; cannot create engine/app` };
  }

  const errors: string[] = [];

  const tryCreate = async (searchTier: string | null): Promise<string | null> => {
    const body: Record<string, unknown> = {
      displayName: `${opts.displayName} (${meta.label})`.slice(0, 128),
      solutionType: meta.solutionType,
      industryVertical: meta.industryVertical,
      dataStoreIds: [opts.dataStoreId],
    };

    if (meta.solutionType === 'SOLUTION_TYPE_SEARCH') {
      // LLM add-on required for engines/.../servingConfigs/*:answer grounded generation
      body.searchEngineConfig = {
        searchTier: searchTier || 'SEARCH_TIER_STANDARD',
        searchAddOns: ['SEARCH_ADD_ON_LLM'],
      };
    } else {
      body.chatEngineConfig = {
        agentCreationConfig: {
          business: opts.displayName.slice(0, 60) || 'SolVamos Agent',
          defaultLanguageCode: 'ko',
          timeZone: 'Asia/Seoul',
        },
      };
    }

    const res = await gcpFetch(`${parent}/engines?engineId=${encodeURIComponent(engineId)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) {
      if (json.name && String(json.name).includes('/operations/')) {
        await waitOperation(json.name, 180_000, json).catch((err) =>
          console.warn('[vertex-search] engine op wait', err?.message || err)
        );
      }
      // Confirm GET — console lists engines that exist as resources.
      const confirm = await gcpFetch(`${parent}/engines/${engineId}`);
      if (confirm.ok) return engineId;
      errors.push(`engine create returned ok but GET failed (${confirm.status})`);
      return engineId;
    }
    if (res.status === 409) return engineId;
    const detail = `${searchTier || 'chat'} ${res.status}: ${JSON.stringify(json).slice(0, 350)}`;
    console.warn('[vertex-search] engine create', detail);
    errors.push(detail);
    return null;
  };

  if (meta.solutionType === 'SOLUTION_TYPE_SEARCH') {
    const created =
      (await tryCreate(process.env.VERTEX_SEARCH_TIER || 'SEARCH_TIER_ENTERPRISE')) ||
      (await tryCreate('SEARCH_TIER_STANDARD'));
    if (created) return { engineId: created };
  } else {
    // Chat engines need Dialogflow; if that fails, fall back to Search app so
    // something still appears under AI Applications.
    const chatId = await tryCreate(null);
    if (chatId) return { engineId: chatId };
    console.warn('[vertex-search] chat engine failed — falling back to SEARCH app');
    const searchMeta = getAiAppType('search_docs');
    const searchBody: Record<string, unknown> = {
      displayName: `${opts.displayName} (문서 검색 fallback)`.slice(0, 128),
      solutionType: searchMeta.solutionType,
      industryVertical: searchMeta.industryVertical,
      dataStoreIds: [opts.dataStoreId],
      searchEngineConfig: {
        searchTier: process.env.VERTEX_SEARCH_TIER || 'SEARCH_TIER_ENTERPRISE',
        searchAddOns: ['SEARCH_ADD_ON_LLM'],
      },
    };
    const res = await gcpFetch(`${parent}/engines?engineId=${encodeURIComponent(engineId)}`, {
      method: 'POST',
      body: JSON.stringify(searchBody),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok || res.status === 409) {
      if (json.name?.includes('/operations/') && !json.done) {
        await waitOperation(json.name, 180_000, json).catch(() => null);
      }
      return { engineId };
    }
    errors.push(`search-fallback ${res.status}: ${JSON.stringify(json).slice(0, 350)}`);
  }

  return {
    error:
      errors.join(' | ') ||
      'AI Applications engine/app create failed — enable discoveryengine.googleapis.com and check IAM (Discovery Engine Admin)',
  };
}

async function registerWebsiteTarget(dataStoreId: string, websiteUri: string): Promise<string> {
  const parent = parentCollection();
  if (!parent) return 'no parent';
  let raw = websiteUri.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return `Invalid website URI: ${websiteUri}`;
  }
  // Always index the whole site: hostname/*
  const providedUriPattern = `${host}/*`;
  const url = `${parent}/dataStores/${dataStoreId}/siteSearchEngine/targetSites`;
  const res = await gcpFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      providedUriPattern,
      type: 'INCLUDE',
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (res.ok || res.status === 409) {
    if (json.name?.includes('/operations/')) {
      await waitOperation(json.name, 180_000, json).catch(() => null);
    }
    // Kick a recrawl so empty stores start indexing (best-effort).
    try {
      const recrawl = await gcpFetch(
        `${parent}/dataStores/${dataStoreId}/siteSearchEngine:recrawlUris`,
        {
          method: 'POST',
          body: JSON.stringify({ uris: [`https://${host}/`] }),
        }
      );
      const rj: any = await recrawl.json().catch(() => ({}));
      if (rj.name?.includes('/operations/')) {
        await waitOperation(rj.name, 60_000, rj).catch(() => null);
      }
    } catch (err: any) {
      console.warn('[vertex-search] recrawl', err?.message || err);
    }
    return `Registered whole-site pattern ${providedUriPattern} (indexing may take minutes–hours)`;
  }
  return `Site register ${res.status}: ${JSON.stringify(json).slice(0, 300)}`;
}

export type AiApplicationCreateResult = {
  dataStoreId: string;
  engineId?: string;
  appType: AiAppType;
  dataSourceType: DataSourceType;
  status: 'created' | 'existing' | 'pending' | 'error';
  message?: string;
  operation?: string;
  sourceNote?: string;
};

/** Create Data Store (+ Engine/app unless skipEngine / autonomous). */
export async function createAiApplicationBundle(opts: {
  displayName: string;
  appType?: string;
  dataSourceType?: string;
  driveFolderId?: string;
  websiteUri?: string;
  gcsUri?: string;
  /** When true (autonomous mode), provision Data Store only — no Answer Engine. */
  skipEngine?: boolean;
  runtimeMode?: 'specialized' | 'autonomous' | string;
}): Promise<AiApplicationCreateResult> {
  // Website URL sources MUST use PUBLIC_WEBSITE — otherwise targetSites never attach
  // and answers fall back to bare Gemini against an empty CONTENT_REQUIRED store.
  const wantsWebsite =
    opts.dataSourceType === 'website_url' ||
    (!!opts.websiteUri && opts.appType === 'website');
  const resolvedAppType = wantsWebsite ? 'website' : opts.appType;
  const appMeta = getAiAppType(resolvedAppType);
  const sourceMeta = getDataSourceType(wantsWebsite ? 'website_url' : opts.dataSourceType);
  const project = projectId();
  const hint =
    opts.driveFolderId || opts.websiteUri || opts.gcsUri || appMeta.id || 'app';
  const skipEngine = opts.skipEngine === true || opts.runtimeMode === 'autonomous';

  if (!project) {
    return {
      dataStoreId: '',
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message: 'GOOGLE_CLOUD_PROJECT not set — cannot create AI Applications resources',
    };
  }

  const sharedLab =
    process.env.VERTEX_SHARED_DATA_STORE === 'true' ||
    process.env.VERTEX_SHARED_DATA_STORE === '1';
  const configured = process.env.VERTEX_DATA_STORE_ID?.trim();
  if (sharedLab && configured) {
    const exists = await getDataStore(configured).catch(() => false);
    if (!exists) {
      return {
        dataStoreId: configured,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: 'error',
        message: `Lab VERTEX_DATA_STORE_ID=${configured} not found`,
      };
    }
    if (skipEngine) {
      return {
        dataStoreId: configured,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: 'existing',
        message: `Lab shared store ${configured} (datastore-only / autonomous)`,
      };
    }
    // Lab still needs an engine/app bound to the shared store when missing.
    const eng = await ensureEngine({
      dataStoreId: configured,
      displayName: opts.displayName,
      appType: appMeta.id,
    });
    return {
      dataStoreId: configured,
      engineId: eng.engineId,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: eng.engineId ? 'existing' : 'error',
      message: eng.engineId
        ? `Lab shared store ${configured} + engine ${eng.engineId}`
        : eng.error || `Lab shared store ${configured} but engine/app create failed`,
    };
  }

  const tokenOk = await getGcpAccessToken();
  if (!tokenOk) {
    return {
      dataStoreId: '',
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message:
        'ADC missing — cannot create AI Applications resources. Set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`, and ensure GOOGLE_CLOUD_PROJECT is set.',
    };
  }

  const dataStoreId = sanitizeId(opts.displayName, hint);
  const parent = parentCollection()!;

  const attachWebsite = async (): Promise<string | undefined> => {
    if (!opts.websiteUri || appMeta.contentConfig !== 'PUBLIC_WEBSITE') return undefined;
    return registerWebsiteTarget(dataStoreId, opts.websiteUri);
  };

  const sourceNotesFor = async (base?: string): Promise<string | undefined> => {
    const site = await attachWebsite();
    if (site) return base ? `${base} · ${site}` : site;
    if (sourceMeta.id === 'cloud_storage' && opts.gcsUri) {
      return `GCS URI saved for connector/console: ${opts.gcsUri}`;
    }
    if (sourceMeta.id === 'local_upload') {
      return 'Local uploads ingest after store create (customer files → corpus → Vertex)';
    }
    if (sourceMeta.emptyThenConfigure) {
      return `${sourceMeta.label}: empty store ready — platform ingest (not customer console)`;
    }
    if (sourceMeta.id === 'google_drive') {
      return 'Google Drive ingest runs after store create (if folder selected)';
    }
    return base;
  };

  if (await getDataStore(dataStoreId).catch(() => false)) {
    const sourceNote = await sourceNotesFor();
    if (skipEngine) {
      return {
        dataStoreId,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: 'existing',
        message: 'Data store already exists (datastore-only / autonomous)',
        sourceNote,
      };
    }
    const eng = await ensureEngine({
      dataStoreId,
      displayName: opts.displayName,
      appType: appMeta.id,
    });
    return {
      dataStoreId,
      engineId: eng.engineId,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: eng.engineId ? 'existing' : 'error',
      message: eng.engineId
        ? 'Data store already exists; ensured engine/app'
        : eng.error ||
          'Data store exists but AI Applications engine/app create failed — check Discovery Engine API + IAM',
      sourceNote,
    };
  }

  const createUrl = `${parent}/dataStores?dataStoreId=${encodeURIComponent(dataStoreId)}`;
  const body = {
    displayName: `${opts.displayName}`.slice(0, 128) || dataStoreId,
    industryVertical: appMeta.industryVertical,
    solutionTypes: [appMeta.solutionType],
    contentConfig: appMeta.contentConfig,
  };

  const res = await gcpFetch(createUrl, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 409 || /already exists/i.test(JSON.stringify(json))) {
      const sourceNote = await sourceNotesFor();
      if (skipEngine) {
        return {
          dataStoreId,
          appType: appMeta.id,
          dataSourceType: sourceMeta.id,
          status: 'existing',
          message: 'Data store already exists (datastore-only / autonomous)',
          sourceNote,
        };
      }
      const eng = await ensureEngine({
        dataStoreId,
        displayName: opts.displayName,
        appType: appMeta.id,
      });
      return {
        dataStoreId,
        engineId: eng.engineId,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: eng.engineId ? 'existing' : 'error',
        message: eng.engineId
          ? 'Data store already exists'
          : eng.error || 'Data store exists but engine/app create failed',
        sourceNote,
      };
    }
    return {
      dataStoreId: '',
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message: `Create data store failed (${res.status}): ${JSON.stringify(json).slice(0, 400)}. Enable discoveryengine.googleapis.com and grant Discovery Engine Admin to the runtime SA.`,
    };
  }

  if (json.name && String(json.name).includes('/operations/')) {
    try {
      // Create often returns done:true; re-GET of that op 404s — waitOperation handles both.
      await waitOperation(json.name, 180_000, json);
    } catch (err: any) {
      // Last resort: if the store already exists, continue; otherwise surface pending.
      const exists = await getDataStore(dataStoreId).catch(() => false);
      if (!exists) {
        return {
          dataStoreId,
          appType: appMeta.id,
          dataSourceType: sourceMeta.id,
          status: 'pending',
          message: `Data store create started but wait failed: ${err.message}`,
          operation: json.name,
        };
      }
      console.warn(
        '[vertex-search] data store op wait failed but GET succeeded — continuing',
        err?.message || err
      );
    }
  }

  // Brief consistency wait before engine create (create LRO can finish before GET is ready).
  if (!(await getDataStore(dataStoreId).catch(() => false))) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  const sourceNote = await sourceNotesFor();

  if (skipEngine) {
    return {
      dataStoreId,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'created',
      message: `Created Data Store ${dataStoreId} (autonomous / no Answer Engine) in ${location()}`,
      operation: json.name,
      sourceNote,
    };
  }

  const eng = await ensureEngine({
    dataStoreId,
    displayName: opts.displayName,
    appType: appMeta.id,
  });

  return {
    dataStoreId,
    engineId: eng.engineId,
    appType: appMeta.id,
    dataSourceType: sourceMeta.id,
    status: eng.engineId ? 'created' : 'error',
    message: eng.engineId
      ? `Created AI Applications data store ${dataStoreId} + app/engine ${eng.engineId} (${appMeta.label}) in ${location()}`
      : eng.error ||
        `Created data store ${dataStoreId} but AI Applications engine/app was NOT created — answers fall back to bare Gemini until engine exists`,
    operation: json.name,
    sourceNote,
  };
}

export type AiApplicationDeleteResult = {
  engineDeleted: boolean;
  dataStoreDeleted: boolean;
  skippedSharedLab: boolean;
  details: string[];
};

/** Delete AI Applications engine (app) then data store. Skips shared lab store. */
export async function deleteAiApplicationBundle(opts: {
  dataStoreId?: string;
  engineId?: string;
}): Promise<AiApplicationDeleteResult> {
  const details: string[] = [];
  const parent = parentCollection();
  if (!parent) {
    return {
      engineDeleted: false,
      dataStoreDeleted: false,
      skippedSharedLab: false,
      details: ['GOOGLE_CLOUD_PROJECT not set — skipped GCP delete'],
    };
  }

  if (isSharedLabStore(opts.dataStoreId)) {
    return {
      engineDeleted: false,
      dataStoreDeleted: false,
      skippedSharedLab: true,
      details: [
        `Shared lab store ${opts.dataStoreId} preserved (VERTEX_SHARED_DATA_STORE)`,
      ],
    };
  }

  const tokenOk = await getGcpAccessToken();
  if (!tokenOk) {
    return {
      engineDeleted: false,
      dataStoreDeleted: false,
      skippedSharedLab: false,
      details: ['ADC missing — skipped GCP delete'],
    };
  }

  let engineDeleted = false;
  let dataStoreDeleted = false;
  const engineId =
    opts.engineId || (opts.dataStoreId ? `${opts.dataStoreId.slice(0, 59)}-eng`.slice(0, 63) : undefined);

  if (engineId) {
    try {
      // Discovery Engine engines.delete has no `force` query param (returns 400).
      const res = await gcpFetch(`${parent}/engines/${engineId}`, {
        method: 'DELETE',
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok || res.status === 404) {
        if (json.name?.includes('/operations/')) {
          await waitOperation(json.name, 120_000, json).catch(() => null);
        }
        engineDeleted = res.status !== 404;
        details.push(
          res.status === 404
            ? `Engine ${engineId} already gone`
            : `Deleted AI Applications engine/app ${engineId}`
        );
      } else {
        details.push(
          `Engine delete ${engineId} failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`
        );
      }
    } catch (err: any) {
      details.push(`Engine delete error: ${err?.message || err}`);
    }
  }

  if (opts.dataStoreId) {
    try {
      // Discovery Engine dataStores.delete has no `force` query param (returns 400).
      const res = await gcpFetch(`${parent}/dataStores/${opts.dataStoreId}`, {
        method: 'DELETE',
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok || res.status === 404) {
        if (json.name?.includes('/operations/')) {
          await waitOperation(json.name, 120_000, json).catch(() => null);
        }
        dataStoreDeleted = res.status !== 404;
        details.push(
          res.status === 404
            ? `Data store ${opts.dataStoreId} already gone`
            : `Deleted data store ${opts.dataStoreId}`
        );
      } else {
        details.push(
          `Data store delete ${opts.dataStoreId} failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`
        );
      }
    } catch (err: any) {
      details.push(`Data store delete error: ${err?.message || err}`);
    }
  }

  return { engineDeleted, dataStoreDeleted, skippedSharedLab: false, details };
}

/** @deprecated use createAiApplicationBundle */
export async function createVertexSearchDataStore(opts: {
  displayName: string;
  driveFolderId: string;
}): Promise<{
  dataStoreId: string;
  status: 'created' | 'existing' | 'pending' | 'error';
  message?: string;
  operation?: string;
  engineId?: string;
}> {
  const r = await createAiApplicationBundle({
    displayName: opts.displayName,
    driveFolderId: opts.driveFolderId,
    appType: 'search_docs',
    dataSourceType: opts.driveFolderId ? 'google_drive' : 'none',
  });
  return {
    dataStoreId: r.dataStoreId,
    status: r.status,
    message: r.message,
    operation: r.operation,
    engineId: r.engineId,
  };
}

export async function importCorpusToVertexDataStore(
  dataStoreId: string,
  corpus: LocalRagCorpus
): Promise<{ imported: number; message: string }> {
  if (!corpus.docs.length) {
    return { imported: 0, message: 'No docs to import' };
  }
  const parent = parentCollection();
  if (!parent) throw new Error('GOOGLE_CLOUD_PROJECT not set');

  // Discovery Engine default branch id is "0". Importing to "default_branch"
  // can report an LRO while leaving the searchable store empty (0 documents).
  const branch = `${parent}/dataStores/${dataStoreId}/branches/0`;

  const toInlineDoc = (doc: LocalRagCorpus['docs'][number]) => {
    const documentId =
      doc.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63) || `doc_${doc.id.slice(0, 8)}`;
    const isPdf =
      doc.mimeType === 'application/pdf' || doc.name.toLowerCase().endsWith('.pdf');
    const lowerName = doc.name.toLowerCase();
    const mimeType =
      isPdf && doc.contentBase64
        ? 'application/pdf'
        : doc.mimeType?.startsWith('text/') ||
            doc.mimeType === 'application/json' ||
            doc.mimeType === 'application/csv' ||
            lowerName.endsWith('.csv') ||
            lowerName.endsWith('.tsv')
          ? doc.mimeType?.startsWith('text/') || doc.mimeType === 'application/json'
            ? doc.mimeType
            : 'text/plain'
          : 'text/plain';
    const rawBytes = doc.contentBase64
      ? doc.contentBase64
      : Buffer.from(doc.text || '', 'utf8').toString('base64');
    return {
      id: documentId,
      structData: {
        title: doc.name,
        link: doc.webViewLink || '',
        source: isPdf ? 'pdf' : lowerName.endsWith('.csv') ? 'csv' : 'text',
        driveFileId: doc.id,
      },
      content: {
        mimeType,
        rawBytes,
      },
    };
  };

  const countDocuments = async (): Promise<number> => {
    const list = await gcpFetch(`${branch}/documents?pageSize=100`);
    if (!list.ok) return -1;
    const json: any = await list.json().catch(() => ({}));
    if (typeof json.totalSize === 'number') return json.totalSize;
    return Array.isArray(json.documents) ? json.documents.length : 0;
  };

  const inlineSource = {
    documents: corpus.docs.slice(0, 40).map(toInlineDoc),
  };

  try {
    const importRes = await gcpFetch(`${branch}/documents:import`, {
      method: 'POST',
      body: JSON.stringify({
        inlineSource,
        reconciliationMode: 'INCREMENTAL',
      }),
    });
    const importJson: any = await importRes.json().catch(() => ({}));
    if (importRes.ok && importJson.name) {
      try {
        await waitOperation(importJson.name, 180_000, importJson);
      } catch (err: any) {
        console.warn('[vertex-search] import op failed', err?.message || err);
      }
      // Give serving index a moment, then verify documents actually exist.
      await new Promise((r) => setTimeout(r, 2000));
      const n = await countDocuments();
      if (n > 0) {
        return {
          imported: Math.max(n, inlineSource.documents.length),
          message: `Batch-imported into ${dataStoreId} (visible docs=${n})`,
        };
      }
      console.warn(
        '[vertex-search] batch import finished but datastore empty — per-doc upsert fallback'
      );
    } else {
      console.warn(
        '[vertex-search] batch import fallback',
        importRes.status,
        JSON.stringify(importJson).slice(0, 200)
      );
    }
  } catch (err: any) {
    console.warn('[vertex-search] batch import error', err?.message || err);
  }

  let imported = 0;
  const errors: string[] = [];
  for (const doc of corpus.docs.slice(0, 40)) {
    const payload = toInlineDoc(doc);
    const documentId = payload.id;
    const res = await gcpFetch(
      `${branch}/documents?documentId=${encodeURIComponent(documentId)}`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    if (res.ok || res.status === 409) {
      imported += 1;
      continue;
    }
    const patch = await gcpFetch(`${branch}/documents/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    if (patch.ok) {
      imported += 1;
      continue;
    }
    const errText = await res.text();
    errors.push(`${doc.name}: ${res.status} ${errText.slice(0, 120)}`);
  }

  const visible = await countDocuments();
  if (imported <= 0 || visible === 0) {
    throw new Error(
      `Vertex import produced no searchable documents in ${dataStoreId}` +
        (errors.length ? ` (${errors.slice(0, 2).join(' | ')})` : '')
    );
  }

  return {
    imported,
    message:
      errors.length === 0
        ? `Imported ${imported} doc(s) into ${dataStoreId} (visible=${visible})`
        : `Imported ${imported}; errors: ${errors.slice(0, 3).join(' | ')}`,
  };
}
