import 'dotenv/config';
import { generateAnswer } from '../server/vertex-generate.js';
import { getGcpAccessToken } from '../server/vertex-search.js';

async function main() {
  const token = await getGcpAccessToken();
  console.log('[smoke] ADC token', token ? 'ok' : 'MISSING');
  const r = await generateAnswer({
    systemPrompt: 'You are a concise assistant. Reply in Korean.',
    userPrompt: '한 문장으로 자기소개해줘.',
    contextBlock: '\n\n[GROUNDED CONTEXT]\nSolVamos Studio는 GCP + Solana 기반 AI 에이전트 플랫폼입니다.\n',
  });
  console.log('[smoke] backend=', r.backend);
  console.log('[smoke] error=', r.error || null);
  console.log('[smoke] text=', r.text.slice(0, 400));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
