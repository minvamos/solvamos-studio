/** Display model/API payloads as human chat text. */
function stripInternalScaffolding(text: string): string {
  let out = text;
  out = out.replace(/\n?\[GROUNDED CONTEXT[\s\S]*?\[\/GROUNDED CONTEXT\]\n?/gi, '\n');
  out = out.replace(/^아래는 Vertex\/Drive에서 검색된 근거입니다\.[^\n]*\n+/i, '');
  out = out.replace(/\n*_\(retrieval note:[\s\S]*?\)_\s*$/i, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

export function formatAgentChatMessage(raw: string): string {
  let text = stripInternalScaffolding(String(raw || '').trim());
  if (!text) return '응답이 비어 있습니다. 다시 시도해 주세요.';

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (!(candidate.startsWith('{') && candidate.endsWith('}'))) {
    if (/\[GROUNDED CONTEXT\]|None retrieved|LLM 생성 불가|retrieval note:/i.test(text)) {
      return '지금은 답변을 생성하지 못했어요. 잠시 후 다시 시도해 주세요.';
    }
    return text;
  }

  try {
    const obj = JSON.parse(candidate);
    if (!obj || typeof obj !== 'object') return text;

    const status = String(obj.status || obj.response || '').toLowerCase();
    if (status === 'insufficient_grounded_data' || status.includes('insufficient')) {
      return String(
        obj.message ||
          '문서에서 근거를 찾지 못했어요. 일반 질문도 도와드릴 수 있으니 이어서 말씀해 주세요.'
      );
    }
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
    if (typeof obj.answer === 'string' && obj.answer.trim()) return obj.answer.trim();
    if (typeof obj.response === 'string' && obj.response.trim() && status !== obj.response.toLowerCase()) {
      return obj.response.trim();
    }
    if (typeof obj.text === 'string' && obj.text.trim()) return obj.text.trim();
  } catch {
    /* ignore */
  }
  return text;
}
