/**
 * Turn model output into a human chat message (no raw JSON / RAG scaffolding in UI).
 */

function stripInternalScaffolding(text: string): string {
  let out = text;

  // Drop whole grounded-context blocks (and trailing instruction noise)
  out = out.replace(/\n?\[GROUNDED CONTEXT[\s\S]*?\[\/GROUNDED CONTEXT\]\n?/gi, '\n');

  // Drop extractive / ops prefixes that must never reach chat UI
  out = out.replace(
    /^아래는 Vertex\/Drive에서 검색된 근거입니다\.[^\n]*\n+/i,
    ''
  );
  out = out.replace(/^\(LLM 생성 불가:[^\n]*\)\n*/i, '');
  out = out.replace(/\n*_\(retrieval note:[\s\S]*?\)_\s*$/i, '');
  out = out.replace(/\n*질문:\s*[^\n]+\s*$/i, '');

  // If the model echoed a "질문: …" line after dumping context, keep only a clean reply
  const qIdx = out.search(/\n질문:\s*/);
  if (qIdx >= 0 && /GROUNDED|None retrieved|LLM 생성 불가/i.test(out.slice(0, qIdx))) {
    out = out.slice(qIdx).replace(/^\n?질문:\s*[^\n]+\n*/, '');
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

export function formatAgentChatMessage(raw: string): string {
  let text = stripInternalScaffolding(String(raw || '').trim());
  if (!text) return '응답이 비어 있습니다. 다시 시도해 주세요.';

  // Strip markdown code fences around JSON
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  if (!(candidate.startsWith('{') && candidate.endsWith('}'))) {
    // Still looks like leaked scaffold → friendly fallback
    if (
      /\[GROUNDED CONTEXT\]|None retrieved|LLM 생성 불가|retrieval note:/i.test(text)
    ) {
      return '지금은 답변을 생성하지 못했어요. 잠시 후 다시 시도해 주세요.';
    }
    return text;
  }

  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') return text;

    // Known SolVamos / A2A status payloads → natural language
    const status = String(obj.status || obj.response || '').toLowerCase();
    if (status === 'insufficient_grounded_data' || status.includes('insufficient')) {
      const msg =
        obj.message ||
        obj.detail ||
        '연결된 문서에서 근거를 찾지 못했어요. 일반 지식으로 도와드릴 수 있으니 질문을 이어서 주세요.';
      return String(msg);
    }

    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.trim();
    }
    if (typeof obj.answer === 'string' && obj.answer.trim()) {
      return obj.answer.trim();
    }
    if (typeof obj.response === 'string' && obj.response.trim() && !status) {
      return obj.response.trim();
    }
    if (typeof obj.text === 'string' && obj.text.trim()) {
      return obj.text.trim();
    }

    // Generic: flatten useful string fields
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'confidence' || k === 'status') continue;
      if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
    if (parts.length) return parts.join('\n');
  } catch {
    // not JSON
  }

  return text;
}
