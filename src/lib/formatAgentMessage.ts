/** Display model/API payloads as human chat text. */
export function formatAgentChatMessage(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) return '응답이 비어 있습니다. 다시 시도해 주세요.';

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (!(candidate.startsWith('{') && candidate.endsWith('}'))) return text;

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
