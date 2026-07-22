/**
 * Gemini generation via Vertex AI (ADC) with optional Gemini API key fallback.
 * Lab: no GEMINI_API_KEY required if ADC + aiplatform is enabled.
 */
import { GoogleGenAI } from '@google/genai';
import { getGcpAccessToken } from './vertex-search.js';
import { config } from './config.js';

function projectId(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

function vertexLocation(): string {
  return process.env.VERTEX_AI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
}

function modelCandidates(): string[] {
  const preferred = (
    process.env.VERTEX_GEMINI_MODEL ||
    process.env.GEMINI_MODEL ||
    ''
  ).replace(/^models\//, '');
  const list = [
    preferred,
    'gemini-2.5-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001',
    'gemini-1.5-flash-002',
  ].filter(Boolean);
  return [...new Set(list)];
}

export type GenerateResult = {
  text: string;
  backend: 'vertex_ai' | 'gemini_api' | 'extractive';
  error?: string;
};

/** REST generateContent on Vertex AI (most reliable with ADC). */
async function generateViaVertexRest(
  systemPrompt: string,
  userPrompt: string
): Promise<GenerateResult | null> {
  const project = projectId();
  const token = await getGcpAccessToken();
  if (!project || !token) return null;

  const location = vertexLocation();
  let lastError = '';

  for (const model of modelCandidates()) {
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
      }),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastError = `Vertex ${model} ${res.status}: ${JSON.stringify(json).slice(0, 220)}`;
      console.warn('[vertex-generate]', lastError);
      continue;
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p: any) => p.text || '').join('') || '';
    if (!text) {
      lastError = `Empty Vertex response for ${model}`;
      continue;
    }
    console.log('[vertex-generate] ok model=', model);
    return { text, backend: 'vertex_ai' };
  }

  return {
    text: '',
    backend: 'vertex_ai',
    error: lastError || 'No Vertex model succeeded',
  };
}

async function generateViaSdkEnterprise(
  systemPrompt: string,
  userPrompt: string
): Promise<GenerateResult | null> {
  const project = projectId();
  if (!project) return null;
  for (const model of modelCandidates()) {
    try {
      const ai = new GoogleGenAI({
        enterprise: true,
        project,
        location: vertexLocation(),
      } as any);
      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.4,
        },
      });
      const text = response.text || '';
      if (!text) continue;
      return { text, backend: 'vertex_ai' };
    } catch (err: any) {
      console.warn('[vertex-generate] SDK', model, err?.message || err);
    }
  }
  return null;
}

async function generateViaApiKey(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string
): Promise<GenerateResult | null> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.4,
      },
    });
    const text = response.text || '';
    if (!text) return null;
    return { text, backend: 'gemini_api' };
  } catch (err: any) {
    console.warn('[vertex-generate] API key failed', err?.message || err);
    return {
      text: '',
      backend: 'gemini_api',
      error: err?.message || 'Gemini API key generate failed',
    };
  }
}

/**
 * Prefer Vertex AI (customer GCP / ADC) → Gemini API key → extractive fallback.
 */
export async function generateAnswer(opts: {
  systemPrompt: string;
  userPrompt: string;
  contextBlock?: string;
  geminiApiKey?: string;
}): Promise<GenerateResult> {
  const fullUser = `${opts.contextBlock || ''}\n\nUser query: ${opts.userPrompt}`.trim();

  // 1) Vertex REST (ADC)
  const rest = await generateViaVertexRest(opts.systemPrompt, fullUser);
  if (rest?.text) return rest;

  // 2) GenAI SDK enterprise
  const sdk = await generateViaSdkEnterprise(opts.systemPrompt, fullUser);
  if (sdk?.text) return sdk;

  // 3) Developer API key
  const key = opts.geminiApiKey || config.geminiApiKey;
  if (key) {
    const keyed = await generateViaApiKey(opts.systemPrompt, fullUser, key);
    if (keyed?.text) return keyed;
  }

  // 4) Extractive fallback — still useful if indexing worked
  if (opts.contextBlock && opts.contextBlock.includes('[GROUNDED CONTEXT')) {
    return {
      text:
        `아래는 Vertex/Drive에서 검색된 근거입니다. (LLM 생성 불가: Vertex ADC 또는 GEMINI_API_KEY 필요)\n\n` +
        `${opts.contextBlock}\n\n질문: ${opts.userPrompt}`,
      backend: 'extractive',
      error: rest?.error || 'No LLM backend available',
    };
  }

  return {
    text:
      '답변을 생성하지 못했습니다. Cloud ADC(`gcloud auth application-default login`)와 ' +
      'aiplatform.googleapis.com / discoveryengine.googleapis.com 활성화, 또는 GEMINI_API_KEY를 설정하세요.',
    backend: 'extractive',
    error: rest?.error || 'No generation backend',
  };
}
