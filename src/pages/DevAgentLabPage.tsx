/**
 * Developer-only agent lab — large chat + RAG/debug traces.
 */
import { useEffect, useRef, useState } from 'react';
import { Bot, FlaskConical, Loader2, Send, Sparkles } from 'lucide-react';
import { Agent, Message } from '../types';
import { formatAgentChatMessage } from '../lib/formatAgentMessage';
import ChatMessageBody from '../components/ChatMessageBody';

type Props = {
  agents: Agent[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onBack: () => void;
};

type DebugTrace = {
  confidence?: number;
  ragMode?: string;
  citations?: any[];
  paymentLogs?: string[];
  generation?: string;
  a2a?: any;
  websiteUri?: string;
  dataSourceType?: string;
  aiAppType?: string;
  raw?: any;
};

export default function DevAgentLabPage({ agents, authFetch, onBack }: Props) {
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((a) => a.id === agentId) || null;

  useEffect(() => {
    if (!agentId && agents[0]?.id) setAgentId(agents[0].id);
  }, [agents, agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || !agent || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: prompt,
      timestamp: new Date().toLocaleTimeString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const res = await authFetch(`/api/agents/${encodeURIComponent(agent.id)}/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Solvamos-Studio': '1',
        },
        body: JSON.stringify({
          prompt,
          studioTest: true,
          enableA2A: false,
          history: messages
            .filter((m) => m.sender === 'user' || m.sender === 'agent')
            .slice(-12)
            .map((m) => ({
              role: m.sender === 'agent' ? 'model' : 'user',
              text: m.text,
            })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      const agentMsg: Message = {
        id: `a-${Date.now()}`,
        sender: 'agent',
        text: formatAgentChatMessage(String(data.data ?? data.answer ?? '')),
        timestamp: new Date().toLocaleTimeString(),
        confidence: data.confidence,
      };
      setMessages((prev) => [...prev, agentMsg]);
      setTrace({
        confidence: data.confidence,
        ragMode: data.ragMode,
        citations: data.citations,
        paymentLogs: data.paymentLogs,
        generation: data.generation,
        a2a: data.a2a,
        websiteUri: agent.websiteUri,
        dataSourceType: agent.dataSourceType,
        aiAppType: agent.aiAppType,
        raw: {
          ...data,
          toolsUsed: data.toolsUsed,
          session: data.session,
          relatedQuestions: data.relatedQuestions,
          engineId: data.engineId,
        },
      });
    } catch (err: any) {
      setError(err?.message || '호출 실패');
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          sender: 'system',
          text: err?.message || '호출 실패',
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-2rem)] flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-solana-green mb-1">
            <FlaskConical className="w-5 h-5" />
            <span className="text-xs font-semibold uppercase tracking-wider">Developer Lab</span>
          </div>
          <h2 className="text-3xl font-semibold text-on-surface">AI 에이전트 테스트</h2>
          <p className="text-sm text-on-surface-variant mt-1">
            큰 대화창 + RAG/소스 트레이스. 소유자 세션으로 페이월을 건너뛰고 Vertex/RAG 동작을 확인합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-outline-variant/30 px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container-high"
        >
          스튜디오로 돌아가기
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-outline-variant/20 bg-surface-container p-3">
        <label className="text-xs font-semibold uppercase tracking-wider text-outline">에이전트</label>
        <select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setMessages([]);
            setTrace(null);
          }}
          className="min-w-[240px] flex-1 bg-surface-container-lowest border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface"
        >
          {agents.length === 0 ? <option value="">에이전트 없음</option> : null}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {(a.agentName || a.id) + ` · ${a.dataSourceType || 'none'}`}
            </option>
          ))}
        </select>
        {agent?.websiteUri ? (
          <a
            href={agent.websiteUri.startsWith('http') ? agent.websiteUri : `https://${agent.websiteUri}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-google-blue hover:underline break-all"
          >
            웹소스: {agent.websiteUri}
          </a>
        ) : (
          <span className="text-xs text-outline">웹사이트 소스 없음</span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-4 flex-1 min-h-[70vh]">
        <section className="glass-panel rounded-xl border border-outline-variant/20 flex flex-col min-h-[70vh]">
          <div className="px-4 py-3 border-b border-outline-variant/20 flex items-center gap-2">
            <Bot className="w-4 h-4 text-google-blue" />
            <span className="text-sm font-semibold">{agent?.agentName || agentId || 'Agent'}</span>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <p className="text-sm text-on-surface-variant text-center py-16">
                질문을 보내 웹/문서 RAG가 실제로 붙는지 확인하세요.
              </p>
            ) : null}
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.sender === 'user'
                    ? 'ml-auto max-w-[90%] rounded-2xl bg-google-blue/15 border border-google-blue/30 px-4 py-3'
                    : m.sender === 'system'
                      ? 'max-w-[90%] rounded-2xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm'
                      : 'mr-auto max-w-[90%] rounded-2xl bg-surface-container-lowest border border-outline-variant/25 px-4 py-3'
                }
              >
                {m.sender === 'agent' ? (
                  <ChatMessageBody text={m.text} sender="agent" />
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                )}
              </div>
            ))}
            {busy ? (
              <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 className="w-4 h-4 animate-spin" /> 생성 중…
              </div>
            ) : null}
          </div>
          <div className="p-3 border-t border-outline-variant/20 flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              placeholder="예: 이 사이트 홈페이지에 적힌 제품 소개를 요약해줘"
              className="flex-1 resize-none rounded-xl bg-surface-container-lowest border border-outline-variant/30 px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-google-blue/50"
            />
            <button
              type="button"
              disabled={busy || !input.trim() || !agent}
              onClick={() => void send()}
              className="self-end rounded-xl btn-primary px-4 py-3 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          {error ? <p className="px-4 pb-3 text-sm text-red-400">{error}</p> : null}
        </section>

        <section className="glass-panel rounded-xl border border-outline-variant/20 p-4 overflow-y-auto min-h-[70vh]">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-solana-green" />
            <h3 className="text-sm font-semibold">동작 트레이스</h3>
          </div>
          {!trace ? (
            <p className="text-sm text-on-surface-variant">응답 후 RAG 모드·citation·로그가 여기에 표시됩니다.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <Row label="aiAppType" value={String(trace.aiAppType || '—')} />
              <Row label="dataSourceType" value={String(trace.dataSourceType || '—')} />
              <Row label="websiteUri" value={String(trace.websiteUri || '—')} />
              <Row label="ragMode" value={String(trace.ragMode || '—')} />
              <Row label="generation" value={String(trace.generation || '—')} />
              <Row label="confidence" value={trace.confidence != null ? String(trace.confidence) : '—'} />
              <div>
                <p className="text-[10px] uppercase tracking-wider text-outline mb-1">citations</p>
                <pre className="text-xs whitespace-pre-wrap break-all rounded-lg bg-surface-container-lowest border border-outline-variant/20 p-3 max-h-48 overflow-auto">
                  {JSON.stringify(trace.citations || [], null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-outline mb-1">paymentLogs</p>
                <pre className="text-xs whitespace-pre-wrap break-all rounded-lg bg-surface-container-lowest border border-outline-variant/20 p-3 max-h-40 overflow-auto">
                  {(trace.paymentLogs || []).join('\n') || '—'}
                </pre>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-outline mb-1">raw response</p>
                <pre className="text-xs whitespace-pre-wrap break-all rounded-lg bg-surface-container-lowest border border-outline-variant/20 p-3 max-h-64 overflow-auto">
                  {JSON.stringify(trace.raw, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-outline">{label}</p>
      <p className="font-mono text-xs text-on-surface break-all mt-0.5">{value}</p>
    </div>
  );
}
