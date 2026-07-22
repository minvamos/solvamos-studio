/**
 * Turn model output into a human chat message (no raw JSON blobs in UI).
 */

export function formatAgentChatMessage(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '응답이 비어 있습니다. 다시 시도해 주세요.';

  // Strip markdown code fences around JSON
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  if (!(candidate.startsWith('{') && candidate.endsWith('}'))) {
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
