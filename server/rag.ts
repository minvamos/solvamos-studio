/**
 * Vertex AI Search retrieve + Vertex Gemini (ADC) grounded answer.
 * Falls back to local Drive corpus when Search is empty / indexing.
 */

import { retrieveFromLocalCorpus, loadLocalRagCorpus } from './drive-ingest.js';
import {
  createVertexSearchDataStore,
  createAiApplicationBundle,
  deleteAiApplicationBundle,
  importCorpusToVertexDataStore,
} from './vertex-search.js';
import { generateAnswer } from './vertex-generate.js';
import { config } from './config.js';

export type RagCitation = { title?: string; uri?: string; snippet?: string };

export type RagResult = {
  answer: string;
  confidence: number;
  citations: RagCitation[];
  mode: 'ai_application' | 'vertex_search' | 'drive_local' | 'gemini_only' | 'demo';
  generationBackend?: string;
  retrievalError?: string;
  engineId?: string;
  session?: string;
  relatedQuestions?: string[];
  toolsUsed?: string[];
};

export type ChatAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

function projectId(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function collectionPath(): string | null {
  const project = projectId();
  if (!project) return null;
  const location = process.env.VERTEX_SEARCH_LOCATION || 'global';
  const collection = process.env.VERTEX_SEARCH_COLLECTION || 'default_collection';
  return `projects/${project}/locations/${location}/collections/${collection}`;
}

function dataStorePath(dataStoreId?: string): string | null {
  const parent = collectionPath();
  const store = dataStoreId;
  if (!parent || !store) return null;
  return `${parent}/dataStores/${store}`;
}

function engineServingConfig(engineId: string, configId = 'default_search'): string | null {
  const parent = collectionPath();
  if (!parent || !engineId) return null;
  return `${parent}/engines/${engineId}/servingConfigs/${configId}`;
}

function discoveryHost(): string {
  const location = process.env.VERTEX_SEARCH_LOCATION || 'global';
  return location === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${location}-discoveryengine.googleapis.com`;
}

async function accessToken(): Promise<string | null> {
  const { getGcpAccessToken } = await import('./vertex-search.js');
  return getGcpAccessToken();
}

/**
 * AI Applications Engine Answer API — the app itself generates the grounded answer.
 * POST .../engines/{engineId}/servingConfigs/default_search:answer
 */
export async function answerFromAiApplication(opts: {
  engineId: string;
  query: string;
  preamble?: string;
  session?: string;
  languageCode?: string;
  /** Prior turns — folded into query when no session resource yet */
  history?: { role: 'user' | 'model'; text: string }[];
}): Promise<{
  ok: boolean;
  answer?: string;
  citations: RagCitation[];
  session?: string;
  relatedQuestions?: string[];
  error?: string;
  raw?: any;
}> {
  const serving =
    engineServingConfig(opts.engineId, 'default_search') ||
    engineServingConfig(opts.engineId, 'default_serving_config');
  if (!serving) {
    return { ok: false, citations: [], error: 'engineId / GOOGLE_CLOUD_PROJECT missing' };
  }
  const token = await accessToken();
  if (!token) {
    return { ok: false, citations: [], error: 'ADC / access token unavailable' };
  }

  const parent = collectionPath();
  const autoSession =
    opts.session ||
    (parent ? `${parent}/engines/${opts.engineId}/sessions/-` : undefined);

  let queryText = opts.query;
  if (!opts.session && opts.history?.length) {
    const hist = opts.history
      .slice(-8)
      .map((h) => `${h.role === 'model' ? 'Assistant' : 'User'}: ${h.text}`)
      .join('\n');
    queryText = `[Conversation so far]\n${hist}\n\n[Current question]\n${opts.query}`;
  }

  const url = `${discoveryHost()}/v1/${serving}:answer`;
  const body: Record<string, unknown> = {
    query: { text: queryText },
    relatedQuestionsSpec: { enable: true },
    answerGenerationSpec: {
      includeCitations: true,
      ignoreAdversarialQuery: true,
      ignoreNonAnswerSeekingQuery: false,
      ignoreLowRelevantContent: false,
      ignoreJailBreakingQuery: true,
      answerLanguageCode: opts.languageCode || 'ko',
      promptSpec: opts.preamble
        ? { preamble: opts.preamble.slice(0, 4000) }
        : undefined,
      // Return corpus images/figures in answers when available (Engine multimodal)
      multimodalSpec: { imageSource: 'ALL_AVAILABLE_SOURCES' },
    },
    searchSpec: {
      searchParams: {
        maxReturnResults: 10,
      },
    },
  };
  if (autoSession) body.session = autoSession;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Some engines use default_serving_config instead of default_search
      if (res.status === 404 && serving.endsWith('/default_search')) {
        const alt = engineServingConfig(opts.engineId, 'default_serving_config');
        if (alt) {
          const res2 = await fetch(`${discoveryHost()}/v1/${alt}:answer`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          const json2: any = await res2.json().catch(() => ({}));
          if (!res2.ok) {
            return {
              ok: false,
              citations: [],
              error: `Answer API ${res2.status}: ${JSON.stringify(json2).slice(0, 400)}`,
              raw: json2,
            };
          }
          return parseAnswerResponse(json2);
        }
      }
      return {
        ok: false,
        citations: [],
        error: `Answer API ${res.status}: ${JSON.stringify(json).slice(0, 400)}`,
        raw: json,
      };
    }
    return parseAnswerResponse(json);
  } catch (err: any) {
    return { ok: false, citations: [], error: err.message };
  }
}

function parseAnswerResponse(json: any): {
  ok: boolean;
  answer?: string;
  citations: RagCitation[];
  session?: string;
  relatedQuestions?: string[];
  error?: string;
  raw?: any;
} {
  const answerObj = json.answer || {};
  const text =
    answerObj.answerText ||
    answerObj.answer ||
    (typeof answerObj === 'string' ? answerObj : '') ||
    '';
  const citations: RagCitation[] = [];
  for (const c of answerObj.citations || []) {
    const sources = c.sources || c.citationSources || [];
    for (const s of sources) {
      citations.push({
        title: s.title || s.referenceId || 'source',
        uri: s.uri || s.link,
        snippet: (s.snippet || s.text || '').slice(0, 240),
      });
    }
  }
  // references / searchResults fallback
  for (const ref of json.searchResults || answerObj.references || []) {
    const chunk = ref.chunkInfo || ref.document || ref;
    citations.push({
      title: chunk.title || chunk.documentName || 'ref',
      uri: chunk.uri || chunk.link,
      snippet: (chunk.content || chunk.snippet || '').slice(0, 240),
    });
  }
  const relatedQuestions = (
    answerObj.relatedQuestions ||
    json.relatedQuestions ||
    []
  )
    .map((q: any) => (typeof q === 'string' ? q : q?.question || q?.text || ''))
    .filter(Boolean)
    .slice(0, 5);
  if (!text) {
    return {
      ok: false,
      citations,
      relatedQuestions,
      session:
        typeof json.session === 'string' ? json.session : json.session?.name || undefined,
      error: 'Answer API returned empty answerText (index may still be empty/crawling)',
      raw: json,
    };
  }
  return {
    ok: true,
    answer: text,
    citations,
    relatedQuestions,
    session: typeof json.session === 'string' ? json.session : json.session?.name,
    raw: json,
  };
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

  const servingConfig = `${storePath}/servingConfigs/default_search`;
  const url = `${discoveryHost()}/v1/${servingConfig}:search`;

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

/** Create AI Applications app + data store for any source type (Drive optional). */
export async function ensureAiApplication(opts: {
  displayName: string;
  appType?: string;
  dataSourceType?: string;
  driveFolderId?: string;
  websiteUri?: string;
  gcsUri?: string;
}) {
  return createAiApplicationBundle(opts);
}

/** Delete AI Applications engine/app + data store for an agent. */
export async function destroyAiApplication(opts: {
  dataStoreId?: string;
  engineId?: string;
}) {
  return deleteAiApplicationBundle(opts);
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
  engineId?: string;
  agentId?: string;
  geminiApiKey?: string;
  /** Skip Search/Drive retrieval (faster for greetings / general chat) */
  skipRetrieval?: boolean;
  history?: { role: 'user' | 'model'; text: string }[];
  /** Discovery Engine session resource name for multi-turn Answer API */
  answerSession?: string;
  attachments?: ChatAttachment[];
  /** Ground with Google Search via Vertex Gemini tool */
  webSearch?: boolean;
}): Promise<RagResult> {
  const hasAttachments = (opts.attachments?.length || 0) > 0;
  const wantWeb = opts.webSearch === true;

  // Attachments / live web search → Vertex Gemini multimodal (+ optional Google Search tool)
  // still grounded with DataStore snippets when available.
  if (hasAttachments || wantWeb) {
    const toolsUsed: string[] = [];
    if (hasAttachments) toolsUsed.push('multimodal_attachments');
    if (wantWeb) toolsUsed.push('google_search');

    let snippets: string[] = [];
    let citations: RagCitation[] = [];
    let mode: RagResult['mode'] = 'gemini_only';
    let retrievalError: string | undefined;

    if (!opts.skipRetrieval && opts.dataStoreId) {
      const retrieval = await retrieveFromVertexSearch(opts.userPrompt, opts.dataStoreId);
      snippets = retrieval.snippets;
      citations = retrieval.citations;
      if (retrieval.ok && snippets.length) mode = 'vertex_search';
      retrievalError = retrieval.error;
      if (snippets.length) toolsUsed.push('datastore_search');
    }

    const contextBlock =
      snippets.length > 0
        ? `\n\n[GROUNDED CONTEXT FROM VERTEX AI SEARCH / DATASTORE]\n${snippets.join(
            '\n---\n'
          )}\n[/GROUNDED CONTEXT]\n`
        : '';

    const gen = await generateAnswer({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      contextBlock,
      geminiApiKey: opts.geminiApiKey || config.geminiApiKey,
      history: opts.history,
      attachments: opts.attachments,
      webSearch: wantWeb,
    });
    const { formatAgentChatMessage } = await import('./format-reply.js');
    return {
      answer: formatAgentChatMessage(gen.text),
      confidence: snippets.length ? 0.88 : wantWeb ? 0.75 : 0.7,
      citations,
      mode: snippets.length ? 'vertex_search' : 'gemini_only',
      generationBackend: gen.backend,
      retrievalError,
      engineId: opts.engineId,
      toolsUsed: [...toolsUsed, ...(gen.toolsUsed || [])],
    };
  }

  // 1) Preferred: AI Applications Engine Answer API (the app answers with RAG)
  if (!opts.skipRetrieval && opts.engineId) {
    const appAnswer = await answerFromAiApplication({
      engineId: opts.engineId,
      query: opts.userPrompt,
      preamble: opts.systemPrompt,
      session: opts.answerSession,
      languageCode: 'ko',
      history: opts.history,
    });
    if (appAnswer.ok && appAnswer.answer) {
      const { formatAgentChatMessage } = await import('./format-reply.js');
      return {
        answer: formatAgentChatMessage(appAnswer.answer),
        confidence: 0.95,
        citations: appAnswer.citations,
        mode: 'ai_application',
        generationBackend: 'discovery_engine_answer',
        engineId: opts.engineId,
        session: appAnswer.session,
        relatedQuestions: appAnswer.relatedQuestions,
        toolsUsed: ['engine_answer', 'multimodal_corpus'],
      };
    }
    // Engine exists but answer failed (empty index / LLM addon) — surface clearly; do NOT
    // silently pretend a bare Gemini reply is the RAG app.
    const indexingHint = appAnswer.error || 'Answer API failed';
    console.warn('[rag] AI Application answer failed:', indexingHint.slice(0, 400));

    // Soft fallback only while website/docs are still indexing: try search snippets + gemini
    // but label mode so UI/debug can show it was not the App answer path.
    const retrieval = await retrieveFromVertexSearch(opts.userPrompt, opts.dataStoreId);
    if (retrieval.ok && retrieval.snippets.length) {
      const gen = await generateAnswer({
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        contextBlock: `\n\n[GROUNDED CONTEXT FROM VERTEX AI SEARCH]\n${retrieval.snippets.join(
          '\n---\n'
        )}\n[/GROUNDED CONTEXT]\n`,
        geminiApiKey: opts.geminiApiKey || config.geminiApiKey,
        history: opts.history,
      });
      const { formatAgentChatMessage } = await import('./format-reply.js');
      return {
        answer: formatAgentChatMessage(gen.text),
        confidence: 0.8,
        citations: retrieval.citations,
        mode: 'vertex_search',
        generationBackend: gen.backend,
        retrievalError: `Answer API unavailable (${indexingHint.slice(0, 180)}); used search+Gemini fallback`,
        engineId: opts.engineId,
        session: appAnswer.session,
        toolsUsed: ['datastore_search', 'gemini_fallback'],
      };
    }

    return {
      answer:
        'AI Applications 앱이 아직 지식베이스에서 답을 만들지 못했습니다. 웹사이트/문서 인덱싱이 끝나기 전이거나 Engine LLM 애드온이 비활성일 수 있습니다. GCP 콘솔에서 Data Store 문서 수·Engine(앱) 상태를 확인한 뒤 다시 시도해 주세요.',
      confidence: 0.2,
      citations: [],
      mode: 'ai_application',
      generationBackend: 'discovery_engine_answer',
      retrievalError: indexingHint,
      engineId: opts.engineId,
      session: appAnswer.session,
      toolsUsed: ['engine_answer'],
    };
  }

  // 2) No engine → for RAG agents this is a misconfiguration
  if (!opts.skipRetrieval && opts.dataStoreId && !opts.engineId) {
    return {
      answer:
        '이 에이전트에 AI Applications Engine(앱)이 연결되어 있지 않습니다. 에이전트를 다시 저장/생성해 Engine을 프로비저닝하세요. (Data Store만 있고 App이 없으면 RAG 앱이 대답할 수 없습니다.)',
      confidence: 0.1,
      citations: [],
      mode: 'demo',
      generationBackend: 'none',
      retrievalError: 'vertexEngineId missing',
    };
  }

  // 3) Chitchat / no-RAG path — Vertex Gemini only
  let snippets: string[] = [];
  let citations: RagCitation[] = [];
  let mode: RagResult['mode'] = 'gemini_only';
  let retrievalError: string | undefined;

  if (!opts.skipRetrieval && opts.dataStoreId) {
    const retrieval = await retrieveFromVertexSearch(opts.userPrompt, opts.dataStoreId);
    snippets = retrieval.snippets;
    citations = retrieval.citations;
    mode = retrieval.ok && snippets.length ? 'vertex_search' : 'gemini_only';
    retrievalError = retrieval.error;
  }

  if (!snippets.length && opts.agentId && !opts.skipRetrieval) {
    const local = retrieveFromLocalCorpus(opts.agentId, opts.userPrompt);
    if (local.ok && local.snippets.length) {
      snippets = local.snippets;
      citations = local.citations;
      mode = 'drive_local';
    }
  }

  const contextBlock =
    snippets.length > 0
      ? `\n\n[GROUNDED CONTEXT FROM ${
          mode === 'drive_local' ? 'GOOGLE DRIVE (local ingest)' : 'VERTEX AI SEARCH'
        }]\n${snippets.join('\n---\n')}\n[/GROUNDED CONTEXT]\n`
      : '';

  const gen = await generateAnswer({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    contextBlock,
    geminiApiKey: opts.geminiApiKey || config.geminiApiKey,
    history: opts.history,
  });

  const { formatAgentChatMessage } = await import('./format-reply.js');
  return {
    answer: formatAgentChatMessage(gen.text),
    confidence: snippets.length ? 0.85 : 0.65,
    citations,
    mode: gen.backend === 'extractive' && !snippets.length ? 'demo' : mode,
    generationBackend: gen.backend,
    retrievalError,
  };
}
