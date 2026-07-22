/**
 * Vertex AI Search (Discovery Engine) — create data store + optional search engine + import docs.
 */
import { GoogleAuth } from 'google-auth-library';
import type { LocalRagCorpus } from './drive-ingest.js';

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

function sanitizeDataStoreId(displayName: string, driveFolderId: string): string {
  const safe = displayName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  const suffix = driveFolderId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'drv';
  const id = `sv-${safe || 'agent'}-${suffix}-${Date.now().toString(36)}`;
  return id.slice(0, 63);
}

export async function getDataStore(dataStoreId: string): Promise<boolean> {
  const parent = parentCollection();
  if (!parent) return false;
  const res = await gcpFetch(`${parent}/dataStores/${dataStoreId}`);
  return res.ok;
}

/** Create Search App (engine) bound to data store — improves servingConfigs. */
async function ensureSearchEngine(dataStoreId: string, displayName: string): Promise<string | null> {
  const parent = parentCollection();
  if (!parent) return null;
  const engineId = `${dataStoreId}-eng`.slice(0, 63);

  const get = await gcpFetch(`${parent}/engines/${engineId}`);
  if (get.ok) return engineId;

  const body = {
    displayName: `${displayName} Search`.slice(0, 128),
    solutionType: 'SOLUTION_TYPE_SEARCH',
    dataStoreIds: [dataStoreId],
    searchEngineConfig: {
      searchTier: 'SEARCH_TIER_STANDARD',
    },
  };

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
  console.warn('[vertex-search] engine create', res.status, JSON.stringify(json).slice(0, 300));
  return null;
}

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
  const project = projectId();
  if (!project) {
    return {
      dataStoreId: sanitizeDataStoreId(opts.displayName, opts.driveFolderId),
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
      status: exists ? 'existing' : 'pending',
      message: exists
        ? `Lab shared VERTEX_DATA_STORE_ID=${configured}`
        : `Lab VERTEX_DATA_STORE_ID=${configured} not found yet`,
    };
  }

  const tokenOk = await getGcpAccessToken();
  if (!tokenOk) {
    const id = sanitizeDataStoreId(opts.displayName, opts.driveFolderId);
    return {
      dataStoreId: id,
      status: 'error',
      message:
        'ADC missing — cannot create Discovery Engine data store. `gcloud auth application-default login`',
    };
  }

  const dataStoreId = sanitizeDataStoreId(opts.displayName, opts.driveFolderId);
  const parent = parentCollection()!;

  if (await getDataStore(dataStoreId).catch(() => false)) {
    const engineId = (await ensureSearchEngine(dataStoreId, opts.displayName)) || undefined;
    return {
      dataStoreId,
      status: 'existing',
      message: 'Data store already exists',
      engineId,
    };
  }

  const createUrl = `${parent}/dataStores?dataStoreId=${encodeURIComponent(dataStoreId)}`;
  const body = {
    displayName: opts.displayName.slice(0, 128) || dataStoreId,
    industryVertical: 'GENERIC',
    solutionTypes: ['SOLUTION_TYPE_SEARCH'],
    contentConfig: 'CONTENT_REQUIRED',
  };

  const res = await gcpFetch(createUrl, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 409 || /already exists/i.test(JSON.stringify(json))) {
      const engineId = (await ensureSearchEngine(dataStoreId, opts.displayName)) || undefined;
      return { dataStoreId, status: 'existing', message: 'Data store already exists', engineId };
    }
    return {
      dataStoreId,
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
        status: 'pending',
        message: `Create started but wait failed: ${err.message}`,
        operation: json.name,
      };
    }
  }

  const engineId = (await ensureSearchEngine(dataStoreId, opts.displayName)) || undefined;
  return {
    dataStoreId,
    status: 'created',
    message: `Created Vertex AI Search data store ${dataStoreId} in ${project}`,
    operation: json.name,
    engineId,
  };
}

/**
 * Import local Drive-ingest corpus into Discovery Engine as inline documents.
 * Uses importDocuments batch when possible, else per-doc create.
 */
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

  // Batch import
  const inlineSource = {
    documents: corpus.docs.slice(0, 40).map((doc) => {
      const documentId = doc.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63) || `doc_${doc.id.slice(0, 8)}`;
      const rawBytes = Buffer.from(doc.text, 'utf8').toString('base64');
      return {
        id: documentId,
        structData: {
          title: doc.name,
          link: doc.webViewLink || '',
          source: 'google_drive',
          driveFileId: doc.id,
        },
        content: {
          mimeType: 'text/plain',
          rawBytes,
        },
      };
    }),
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
    const documentId = doc.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63) || `doc_${imported}`;
    const rawBytes = Buffer.from(doc.text, 'utf8').toString('base64');
    const payload = {
      id: documentId,
      structData: {
        title: doc.name,
        link: doc.webViewLink || '',
        source: 'google_drive',
        driveFileId: doc.id,
      },
      content: {
        mimeType: 'text/plain',
        rawBytes,
      },
    };

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
