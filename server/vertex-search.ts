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
  const url = path.startsWith('http') ? path : `${apiHost()}/v1/${path.replace(/^\//, '')}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

async function waitOperation(opName: string, timeoutMs = 180_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await gcpFetch(opName);
    const json: any = await res.json();
    if (!res.ok) {
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

async function ensureEngine(opts: {
  dataStoreId: string;
  displayName: string;
  appType: AiAppType;
}): Promise<string | null> {
  const parent = parentCollection();
  if (!parent) return null;
  const meta = getAiAppType(opts.appType);
  const engineId = `${opts.dataStoreId}-eng`.slice(0, 63);

  const get = await gcpFetch(`${parent}/engines/${engineId}`);
  if (get.ok) return engineId;

  const tryCreate = async (searchTier: string): Promise<string | null> => {
    const body: Record<string, unknown> = {
      displayName: `${opts.displayName} (${meta.label})`.slice(0, 128),
      solutionType: meta.solutionType,
      industryVertical: meta.industryVertical,
      dataStoreIds: [opts.dataStoreId],
    };

    if (meta.solutionType === 'SOLUTION_TYPE_SEARCH') {
      // LLM add-on required for engines/.../servingConfigs/*:answer grounded generation
      body.searchEngineConfig = {
        searchTier,
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
        await waitOperation(json.name).catch((err) =>
          console.warn('[vertex-search] engine op wait', err?.message || err)
        );
      }
      return engineId;
    }
    if (res.status === 409) return engineId;
    console.warn(
      '[vertex-search] engine create',
      searchTier,
      res.status,
      JSON.stringify(json).slice(0, 400)
    );
    return null;
  };

  // Prefer Enterprise + LLM (Answer API); fall back to Standard + LLM.
  return (
    (await tryCreate(process.env.VERTEX_SEARCH_TIER || 'SEARCH_TIER_ENTERPRISE')) ||
    (await tryCreate('SEARCH_TIER_STANDARD'))
  );
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
      await waitOperation(json.name).catch(() => null);
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
        await waitOperation(rj.name, 60_000).catch(() => null);
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

/** Always create AI Applications data store + app(engine) for the chosen types. */
export async function createAiApplicationBundle(opts: {
  displayName: string;
  appType?: string;
  dataSourceType?: string;
  driveFolderId?: string;
  websiteUri?: string;
  gcsUri?: string;
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

  if (!project) {
    return {
      dataStoreId: sanitizeId(opts.displayName, hint),
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message: 'GOOGLE_CLOUD_PROJECT not set',
    };
  }

  const sharedLab =
    process.env.VERTEX_SHARED_DATA_STORE === 'true' ||
    process.env.VERTEX_SHARED_DATA_STORE === '1';
  const configured = process.env.VERTEX_DATA_STORE_ID?.trim();
  if (sharedLab && configured) {
    const exists = await getDataStore(configured).catch(() => false);
    return {
      dataStoreId: configured,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: exists ? 'existing' : 'pending',
      message: exists
        ? `Lab shared VERTEX_DATA_STORE_ID=${configured}`
        : `Lab VERTEX_DATA_STORE_ID=${configured} not found yet`,
    };
  }

  const tokenOk = await getGcpAccessToken();
  if (!tokenOk) {
    return {
      dataStoreId: sanitizeId(opts.displayName, hint),
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message:
        'ADC missing — cannot create AI Applications resources. `gcloud auth application-default login`',
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
    const engineId =
      (await ensureEngine({
        dataStoreId,
        displayName: opts.displayName,
        appType: appMeta.id,
      })) || undefined;
    const sourceNote = await sourceNotesFor();
    return {
      dataStoreId,
      engineId,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: engineId ? 'existing' : 'error',
      message: engineId
        ? 'Data store already exists; ensured engine/app'
        : 'Data store exists but AI Applications engine/app create failed — check Discovery Engine API + IAM',
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
      const engineId =
        (await ensureEngine({
          dataStoreId,
          displayName: opts.displayName,
          appType: appMeta.id,
        })) || undefined;
      const sourceNote = await sourceNotesFor();
      return {
        dataStoreId,
        engineId,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: engineId ? 'existing' : 'error',
        message: engineId
          ? 'Data store already exists'
          : 'Data store exists but engine/app create failed',
        sourceNote,
      };
    }
    return {
      dataStoreId,
      appType: appMeta.id,
      dataSourceType: sourceMeta.id,
      status: 'error',
      message: `Create data store failed (${res.status}): ${JSON.stringify(json).slice(0, 400)}. Enable discoveryengine.googleapis.com.`,
    };
  }

  if (json.name && String(json.name).includes('/operations/')) {
    try {
      await waitOperation(json.name);
    } catch (err: any) {
      return {
        dataStoreId,
        appType: appMeta.id,
        dataSourceType: sourceMeta.id,
        status: 'pending',
        message: `Create started but wait failed: ${err.message}`,
        operation: json.name,
      };
    }
  }

  const engineId =
    (await ensureEngine({
      dataStoreId,
      displayName: opts.displayName,
      appType: appMeta.id,
    })) || undefined;

  const sourceNote = await sourceNotesFor();

  return {
    dataStoreId,
    engineId,
    appType: appMeta.id,
    dataSourceType: sourceMeta.id,
    status: engineId ? 'created' : 'error',
    message: engineId
      ? `Created AI Applications data store ${dataStoreId} + app/engine ${engineId} (${appMeta.label}) in ${location()}`
      : `Created data store ${dataStoreId} but AI Applications engine/app was NOT created — answers fall back to bare Gemini until engine exists`,
    operation: json.name,
    sourceNote,
  };
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

  const branch = `${parent}/dataStores/${dataStoreId}/branches/default_branch`;

  const toInlineDoc = (doc: LocalRagCorpus['docs'][number]) => {
    const documentId =
      doc.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63) || `doc_${doc.id.slice(0, 8)}`;
    const isPdf =
      doc.mimeType === 'application/pdf' || doc.name.toLowerCase().endsWith('.pdf');
    const mimeType =
      isPdf && doc.contentBase64
        ? 'application/pdf'
        : doc.mimeType?.startsWith('text/') || doc.mimeType === 'application/json'
          ? doc.mimeType || 'text/plain'
          : 'text/plain';
    const rawBytes = doc.contentBase64
      ? doc.contentBase64
      : Buffer.from(doc.text || '', 'utf8').toString('base64');
    return {
      id: documentId,
      structData: {
        title: doc.name,
        link: doc.webViewLink || '',
        source: isPdf ? 'pdf' : 'text',
        driveFileId: doc.id,
      },
      content: {
        mimeType,
        rawBytes,
      },
    };
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
      await waitOperation(importJson.name, 180_000).catch((err) =>
        console.warn('[vertex-search] import op', err?.message || err)
      );
      return {
        imported: inlineSource.documents.length,
        message: `Batch-imported ${inlineSource.documents.length} doc(s) into ${dataStoreId}`,
      };
    }
    console.warn(
      '[vertex-search] batch import fallback',
      importRes.status,
      JSON.stringify(importJson).slice(0, 200)
    );
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

  return {
    imported,
    message:
      errors.length === 0
        ? `Imported ${imported} doc(s) into ${dataStoreId}`
        : `Imported ${imported}; errors: ${errors.slice(0, 3).join(' | ')}`,
  };
}
