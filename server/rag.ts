/**
 * Vertex AI Search retrieve + Vertex Gemini (ADC) grounded answer.
 * Falls back to local Drive corpus when Search is empty / indexing.
 */

import { retrieveFromLocalCorpus, loadLocalRagCorpus } from './drive-ingest.js';
import {
  createVertexSearchDataStore,
  importCorpusToVertexDataStore,
} from './vertex-search.js';
import { generateAnswer } from './vertex-generate.js';
import { config } from './config.js';

export type RagCitation = { title?: string; uri?: string; snippet?: string };

export type RagResult = {
  answer: string;
  confidence: number;
  citations: RagCitation[];
  mode: 'vertex_search' | 'drive_local' | 'gemini_only' | 'demo';
  generationBackend?: string;
  retrievalError?: string;
};

function projectId(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function dataStorePath(dataStoreId?: string): string | null {
  const project = projectId();
  const location = process.env.VERTEX_SEARCH_LOCATION || 'global';
  const collection = process.env.VERTEX_SEARCH_COLLECTION || 'default_collection';
  const store = dataStoreId;
  if (!project || !store) return null;
  return `projects/${project}/locations/${location}/collections/${collection}/dataStores/${store}`;
}

async function accessToken(): Promise<string | null> {
  const { getGcpAccessToken } = await import('./vertex-search.js');
  return getGcpAccessToken();
}

/** Search / retrieve snippets from Vertex AI Search */
export async function retrieveFromVertexSearch(
  query: string,
  dataStoreId?: string
): Promise<{ snippets: string[]; citations: RagCitation[]; ok: boolean; error?: string }> {
  const storePath = dataStorePath(dataStoreId);
  if (!storePath) {
    return {
      snippets: [],
      citations: [],
      ok: false,
      error: 'dataStoreId / GOOGLE_CLOUD_PROJECT not configured',
    };
  }

  const token = await accessToken();
  if (!token) {
    return { snippets: [], citations: [], ok: false, error: 'ADC / access token unavailable' };
  }

  const location = process.env.VERTEX_SEARCH_LOCATION || 'global';
  const host =
    location === 'global'
      ? 'https://discoveryengine.googleapis.com'
      : `https://${location}-discoveryengine.googleapis.com`;

  const servingConfig = `${storePath}/servingConfigs/default_search`;
  const url = `${host}/v1/${servingConfig}:search`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        pageSize: 8,
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true },
          extractiveContentSpec: {
            maxExtractiveAnswerCount: 3,
            maxExtractiveSegmentCount: 3,
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        snippets: [],
        citations: [],
        ok: false,
        error: `Discovery Engine ${res.status}: ${text.slice(0, 400)}`,
      };
    }

    const json: any = await res.json();
    const citations: RagCitation[] = [];
    const snippets: string[] = [];

    for (const r of json.results || []) {
      const doc = r.document || {};
      const derived = doc.derivedStructData || doc.structData || {};
      const title = derived.title || doc.name;
      const link = derived.link || derived.uri;
      const snips = (derived.snippets || []).map((s: any) => s.snippet).filter(Boolean);
      const extractive = (derived.extractive_answers || derived.extractiveAnswers || [])
        .map((e: any) => e.content)
        .filter(Boolean);
      const segments = (derived.extractive_segments || derived.extractiveSegments || [])
        .map((e: any) => e.content)
        .filter(Boolean);
      const piece = [...snips, ...extractive, ...segments].join('\n');
      if (piece) snippets.push(`[${title}]\n${piece}`);
      else if (derived.title && typeof derived === 'object') {
        // content may be in document.content
        const contentText =
          doc.content?.rawBytes
            ? Buffer.from(doc.content.rawBytes, 'base64').toString('utf8').slice(0, 2000)
            : '';
        if (contentText) snippets.push(`[${title}]\n${contentText}`);
      }
      citations.push({ title, uri: link, snippet: (piece || title || '').slice(0, 240) });
    }

    return { snippets, citations, ok: true };
  } catch (err: any) {
    return { snippets: [], citations: [], ok: false, error: err.message };
  }
}

export async function ensureDriveDataStore(opts: {
  displayName: string;
  driveFolderId: string;
}): Promise<{
  dataStoreId: string;
  status: 'created' | 'existing' | 'pending' | 'error';
  message?: string;
  engineId?: string;
}> {
  return createVertexSearchDataStore(opts);
}

export async function syncLocalCorpusToVertex(
  agentId: string,
  dataStoreId: string
): Promise<{ imported: number; message: string }> {
  const { loadLocalRagCorpusAsync } = await import('./drive-ingest.js');
  const corpus = (await loadLocalRagCorpusAsync(agentId)) || loadLocalRagCorpus(agentId);
  if (!corpus) return { imported: 0, message: 'No local corpus' };
  return importCorpusToVertexDataStore(dataStoreId, corpus);
}

export async function generateGroundedAnswer(opts: {
  systemPrompt: string;
  userPrompt: string;
  dataStoreId?: string;
  agentId?: string;
  geminiApiKey?: string;
  /** Skip Search/Drive retrieval (faster for greetings / general chat) */
  skipRetrieval?: boolean;
}): Promise<RagResult> {
  let snippets: string[] = [];
  let citations: RagCitation[] = [];
  let mode: RagResult['mode'] = 'gemini_only';
  let retrievalError: string | undefined;

  if (!opts.skipRetrieval) {
    const retrieval = await retrieveFromVertexSearch(opts.userPrompt, opts.dataStoreId);
    snippets = retrieval.snippets;
    citations = retrieval.citations;
    mode = retrieval.ok && snippets.length ? 'vertex_search' : 'gemini_only';
    retrievalError = retrieval.error;

    if (!snippets.length && opts.agentId) {
      const local = retrieveFromLocalCorpus(opts.agentId, opts.userPrompt);
      if (local.ok && local.snippets.length) {
        snippets = local.snippets;
        citations = local.citations;
        mode = 'drive_local';
        retrievalError = retrieval.error
          ? `${retrieval.error} (fell back to local Drive corpus)`
          : undefined;
      }
    }

    // If still empty, dump top of local / DB corpus so LLM has something
    if (!snippets.length && opts.agentId) {
      const { loadLocalRagCorpusAsync } = await import('./drive-ingest.js');
      const corpus =
        (await loadLocalRagCorpusAsync(opts.agentId)) || loadLocalRagCorpus(opts.agentId);
      if (corpus?.docs?.length) {
        snippets = corpus.docs.slice(0, 5).map((d) => `[${d.name}]\n${d.text.slice(0, 3000)}`);
        citations = corpus.docs.slice(0, 5).map((d) => ({
          title: d.name,
          uri: d.webViewLink,
          snippet: d.text.slice(0, 200),
        }));
        mode = 'drive_local';
      }
    }
  }

  const contextBlock =
    snippets.length > 0
      ? `\n\n[GROUNDED CONTEXT FROM ${
          mode === 'drive_local' ? 'GOOGLE DRIVE (local ingest)' : 'VERTEX AI SEARCH'
        }]\n${snippets.join('\n---\n')}\n[/GROUNDED CONTEXT]\n`
      : `\n\n[GROUNDED CONTEXT] None retrieved.
You MUST still answer as a helpful conversational agent (greetings, weather, general Q&A, product help).
Do not return JSON status objects. Write a natural chat reply in the user's language.
[/GROUNDED CONTEXT]\n`;

  const gen = await generateAnswer({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    contextBlock,
    geminiApiKey: opts.geminiApiKey || config.geminiApiKey,
  });

  const { formatAgentChatMessage } = await import('./format-reply.js');
  const answer = formatAgentChatMessage(gen.text);

  return {
    answer,
    confidence: snippets.length ? (gen.backend === 'extractive' ? 0.75 : 0.92) : 0.7,
    citations,
    mode: gen.backend === 'extractive' && !snippets.length ? 'demo' : mode,
    generationBackend: gen.backend,
    retrievalError,
  };
}
