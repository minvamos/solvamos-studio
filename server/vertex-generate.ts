/**
 * Gemini generation via Vertex AI (ADC) with optional Gemini API key fallback.
 * Supports multimodal parts (images/files) and Google Search grounding tool.
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
  toolsUsed?: string[];
};

export type ChatTurn = { role: 'user' | 'model'; text: string };

export type ChatAttachmentPart = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function attachmentParts(attachments: ChatAttachmentPart[] = []): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const a of attachments.slice(0, 8)) {
    const mime = (a.mimeType || '').toLowerCase();
    const data = String(a.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!data) continue;
    // Gemini inline: images + pdf + plain text as files
    if (
      mime.startsWith('image/') ||
      mime === 'application/pdf' ||
      mime.startsWith('text/') ||
      mime === 'application/json'
    ) {
      parts.push({
        inlineData: {
          mimeType: a.mimeType || 'application/octet-stream',
          data,
        },
      });
      parts.push({ text: `[첨부 파일: ${a.name || 'file'} (${a.mimeType})]` });
    }
  }
  return parts;
}

/** REST generateContent on Vertex AI (most reliable with ADC). */
async function generateViaVertexRest(
  systemPrompt: string,
  userPrompt: string,
  history: ChatTurn[] = [],
  opts: { attachments?: ChatAttachmentPart[]; webSearch?: boolean } = {}
): Promise<GenerateResult | null> {
  const project = projectId();
  const token = await getGcpAccessToken();
  if (!project || !token) return null;

  const location = vertexLocation();
  let lastError = '';
  const toolsUsed: string[] = [];
  if (opts.webSearch) toolsUsed.push('google_search');
  if (opts.attachments?.length) toolsUsed.push('multimodal_attachments');

  const userParts: ContentPart[] = [
    ...attachmentParts(opts.attachments),
    { text: userPrompt },
  ];

  const contents = [
    ...history
      .filter((t) => t.text?.trim())
      .slice(-12)
      .map((t) => ({
        role: t.role === 'model' ? 'model' : 'user',
        parts: [{ text: t.text }] as ContentPart[],
      })),
    { role: 'user', parts: userParts },
  ];

  for (const model of modelCandidates()) {
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    // gemini-2.5* thinking tokens count against maxOutputTokens — 2048 often
    // cuts the visible answer mid-sentence (finishReason=MAX_TOKENS).
    const maxOut = Math.max(
      1024,
      Number(process.env.VERTEX_GEMINI_MAX_OUTPUT_TOKENS || 8192) || 8192
    );
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: maxOut,
      },
    };
    if (/gemini-2\.5/i.test(model)) {
      // Keep thinking budget modest so the visible answer gets the token room.
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: Number(process.env.VERTEX_GEMINI_THINKING_BUDGET || 1024) || 1024,
      };
    }
    if (opts.webSearch) {
      // Vertex Gemini Google Search grounding tool
      body.tools = [{ googleSearch: {} }];
    }

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
      lastError = `Vertex ${model} ${res.status}: ${JSON.stringify(json).slice(0, 220)}`;
      console.warn('[vertex-generate]', lastError);
      // thinkingConfig unsupported on some models/locations — retry bare config once
      if (/thinkingConfig|thinking_budget|Unknown name/i.test(lastError) && /gemini-2\.5/i.test(model)) {
        const retryBody = {
          ...body,
          generationConfig: { temperature: 0.5, maxOutputTokens: maxOut },
        };
        const retry = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(retryBody),
        });
        const retryJson: any = await retry.json().catch(() => ({}));
        if (retry.ok) {
          const parts = retryJson?.candidates?.[0]?.content?.parts || [];
          const text = parts
            .filter((p: any) => !p.thought && p.text)
            .map((p: any) => p.text)
            .join('');
          if (text) {
            const fr = retryJson?.candidates?.[0]?.finishReason;
            if (fr && fr !== 'STOP') {
              console.warn('[vertex-generate] finishReason=', fr, 'model=', model);
            }
            return { text, backend: 'vertex_ai', toolsUsed };
          }
        }
      }
      // If googleSearch tool rejected, retry once without tool
      if (opts.webSearch && /tool|googleSearch|INVALID/i.test(lastError)) {
        continue;
      }
      continue;
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    // Exclude model "thought" parts — only surface the user-facing answer.
    const text = parts
      .filter((p: any) => !p.thought && p.text)
      .map((p: any) => p.text)
      .join('');
    if (!text) {
      lastError = `Empty Vertex response for ${model}`;
      continue;
    }
    const finishReason = json?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(
        '[vertex-generate] finishReason=',
        finishReason,
        'model=',
        model,
        'len=',
        text.length
      );
    }
    console.log(
      '[vertex-generate] ok model=',
      model,
      'turns=',
      contents.length,
      'tools=',
      toolsUsed.join(',') || 'none',
      'finish=',
      finishReason || 'STOP'
    );
    return { text, backend: 'vertex_ai', toolsUsed };
  }

  // Retry without web search if tool blocked all models
  if (opts.webSearch) {
    const fallback = await generateViaVertexRest(systemPrompt, userPrompt, history, {
      attachments: opts.attachments,
      webSearch: false,
    });
    if (fallback?.text) {
      return {
        ...fallback,
        toolsUsed: [...(fallback.toolsUsed || []), 'google_search_unavailable'],
      };
    }
  }

  return {
    text: '',
    backend: 'vertex_ai',
    error: lastError || 'No Vertex model succeeded',
    toolsUsed,
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
          maxOutputTokens: Number(process.env.VERTEX_GEMINI_MAX_OUTPUT_TOKENS || 8192) || 8192,
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
  history?: ChatTurn[];
  attachments?: ChatAttachmentPart[];
  webSearch?: boolean;
}): Promise<GenerateResult> {
  const fullUser = `${opts.contextBlock || ''}\n\nUser query: ${opts.userPrompt}`.trim();
  const history = opts.history || [];

  // 1) Vertex REST (ADC) — multimodal + optional Google Search
  const rest = await generateViaVertexRest(opts.systemPrompt, fullUser, history, {
    attachments: opts.attachments,
    webSearch: opts.webSearch === true,
  });
  if (rest?.text) return rest;

  // 2) GenAI SDK enterprise (text-only fallback)
  const sdk = await generateViaSdkEnterprise(opts.systemPrompt, fullUser);
  if (sdk?.text) return sdk;

  // 3) Developer API key
  const key = opts.geminiApiKey || config.geminiApiKey;
  if (key) {
    const keyed = await generateViaApiKey(opts.systemPrompt, fullUser, key);
    if (keyed?.text) return keyed;
  }

  // 4) Never dump internal RAG prompts / context blocks to the user.
  const prompt = String(opts.userPrompt || '').trim();
  const chitchat =
    prompt.length <= 40 &&
    /^(hi|hello|hey|yo|안녕|안녕하세요|하이|헬로|테스트|날씨|weather|고마워|감사)[\s!~.?]*$/i.test(
      prompt
    );
  if (chitchat) {
    const greeting = /안녕|hello|hi|hey|하이|헬로/i.test(prompt)
      ? '안녕하세요! 무엇을 도와드릴까요?'
      : '네, 듣고 있어요. 구체적으로 질문해 주세요.';
    return { text: greeting, backend: 'extractive' };
  }

  return {
    text:
      rest?.error ||
      '모델 응답을 생성하지 못했습니다. Vertex AI / ADC 설정을 확인해 주세요.',
    backend: 'extractive',
    error: rest?.error,
  };
}
