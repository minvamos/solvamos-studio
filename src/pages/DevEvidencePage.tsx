/**
 * Developer evidence dashboard — chat + persisted citations / referenced sites.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ExternalLink,
  FlaskConical,
  Loader2,
  RefreshCw,
  Send,
  Shield,
  Trash2,
} from 'lucide-react';
import { Agent, Message } from '../types';
import { formatAgentChatMessage } from '../lib/formatAgentMessage';
import ChatMessageBody from '../components/ChatMessageBody';

type Evidence = {
  id: string;
  ts: string;
  agentId: string;
  agentName?: string;
  prompt: string;
  answer: string;
  confidence?: number;
  citations: { title?: string; uri?: string; snippet?: string; sourceType?: string }[];
  toolsUsed: string[];
  ragMode?: string;
  generation?: string;
  engineId?: string | null;
  dataStoreId?: string | null;
  websiteUri?: string;
  dataSourceType?: string;
  aiAppType?: string;
  referencedHosts: string[];
  referencedUrls: string[];
  relatedQuestions?: string[];
  retrievalError?: string;
  a2a?: unknown;
};

type Props = {
  agents: Agent[];
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
};

export default function DevEvidencePage({ agents, authFetch }: Props) {
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((a) => a.id === agentId) || null;
  const selected = useMemo(
    () => evidence.find((e) => e.id === selectedId) || evidence[0] || null,
    [evidence, selectedId]
  );

  const loadEvidence = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '80' });
      if (agentId) params.set('agentId', agentId);
      if (q.trim()) params.set('q', q.trim());
      const res = await authFetch(`/api/dev/evidence?${params}`);
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      setEvidence(data.evidence || []);
      if (!selectedId && data.evidence?.[0]?.id) setSelectedId(data.evidence[0].id);
    } catch (err: any) {
      setError(err?.message || '근거 로드 실패');
    }
  }, [authFetch, agentId, q, selectedId]);

  useEffect(() => {
    if (!agentId && agents[0]?.id) setAgentId(agents[0].id);
  }, [agents, agentId]);

  useEffect(() => {
    void loadEvidence();
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

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
        toolsUsed: data.toolsUsed,
      };
      setMessages((prev) => [...prev, agentMsg]);
      await loadEvidence();
      if (data.evidenceId) setSelectedId(data.evidenceId);
    } catch (err: any) {
      setError(err?.message || 'invoke 실패');
    } finally {
      setBusy(false);
    }
  };

  const clearEvidence = async () => {
    if (!window.confirm('이 에이전트의 근거 기록을 삭제할까요?')) return;
    await authFetch(`/api/dev/evidence?agentId=${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    });
    setSelectedId(null);
    await loadEvidence();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl font-semibold text-on-surface mb-1 flex items-center gap-2">
            <FlaskConical className="w-7 h-7 text-solana-green" />
            근거 대시보드
          </h2>
          <p className="text-sm text-on-surface-variant">
            에이전트가 참고한 citation·URL·호스트·툴을 남깁니다. 블랙박스 응답의 증거를 확인하세요.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setMessages([]);
              setSelectedId(null);
            }}
            className="bg-surface-container-high border border-outline-variant/30 rounded-md py-2 px-3 text-sm min-w-[220px]"
          >
            {agents.length === 0 && <option value="">에이전트 없음</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.agentName || a.customRole || a.role} · {a.id.slice(0, 16)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void loadEvidence()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-container-high text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            근거 새로고침
          </button>
          <button
            type="button"
            onClick={() => void clearEvidence()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/30 text-red-400 text-sm"
          >
            <Trash2 className="w-4 h-4" />
            근거 삭제
          </button>
        </div>
      </div>

      {agent && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <MetaChip label="dataSource" value={agent.dataSourceType || '—'} />
          <MetaChip label="website" value={agent.websiteUri || '—'} />
          <MetaChip label="engine" value={agent.vertexEngineId || '—'} />
          <MetaChip label="datastore" value={agent.vertexDataStoreId || '—'} />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 min-h-[60vh]">
        {/* Chat */}
        <section className="glass-panel rounded-xl flex flex-col overflow-hidden border border-outline-variant/15 min-h-[520px]">
          <div className="px-4 py-3 border-b border-outline-variant/15 flex items-center gap-2">
            <Bot className="w-4 h-4 text-google-blue" />
            <span className="text-sm font-semibold">개발자 테스트 채팅</span>
            <span className="text-[10px] text-on-surface-variant ml-auto">studioTest · paywall skip</span>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <p className="text-sm text-on-surface-variant text-center py-12">
                질문을 보내면 응답과 함께 근거(evidence)가 오른쪽에 쌓입니다.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.sender === 'user'
                    ? 'ml-8 rounded-xl bg-google-blue/15 px-3 py-2 text-sm'
                    : 'mr-8 rounded-xl bg-surface-container-high px-3 py-2 text-sm'
                }
              >
                <ChatMessageBody text={m.text} sender={m.sender} />
                {m.toolsUsed?.length ? (
                  <p className="mt-1 text-[10px] text-on-surface-variant font-mono">
                    tools: {m.toolsUsed.join(', ')}
                  </p>
                ) : null}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 className="w-4 h-4 animate-spin" /> 생성 중…
              </div>
            )}
          </div>
          <form
            className="p-3 border-t border-outline-variant/15 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="에이전트에게 물어보기…"
              className="flex-1 bg-surface-container-lowest border border-outline-variant/30 rounded-lg px-3 py-2 text-sm"
              disabled={!agent || busy}
            />
            <button
              type="submit"
              disabled={!agent || busy || !input.trim()}
              className="px-3 py-2 rounded-lg bg-google-blue text-white disabled:opacity-40"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </section>

        {/* Evidence */}
        <section className="glass-panel rounded-xl flex flex-col overflow-hidden border border-outline-variant/15 min-h-[520px]">
          <div className="px-4 py-3 border-b border-outline-variant/15 flex items-center gap-2">
            <Shield className="w-4 h-4 text-solana-green" />
            <span className="text-sm font-semibold">근거 / 참고 사이트</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadEvidence();
              }}
              placeholder="근거 검색"
              className="ml-auto bg-surface-container-high border border-outline-variant/30 rounded-md px-2 py-1 text-xs w-36"
            />
          </div>
          <div className="grid grid-cols-5 flex-1 min-h-0">
            <div className="col-span-2 border-r border-outline-variant/15 overflow-y-auto max-h-[560px]">
              {evidence.length === 0 && (
                <p className="p-4 text-xs text-on-surface-variant">아직 기록된 근거가 없습니다.</p>
              )}
              {evidence.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setSelectedId(ev.id)}
                  className={
                    selected?.id === ev.id
                      ? 'w-full text-left px-3 py-3 bg-secondary-container/15 border-l-2 border-secondary'
                      : 'w-full text-left px-3 py-3 hover:bg-surface-container/50 border-l-2 border-transparent'
                  }
                >
                  <p className="text-[10px] text-outline font-mono">
                    {new Date(ev.ts).toLocaleString()}
                  </p>
                  <p className="text-xs text-on-surface line-clamp-2 mt-0.5">{ev.prompt}</p>
                  <p className="text-[10px] text-on-surface-variant mt-1">
                    cites {ev.citations?.length || 0} · hosts {ev.referencedHosts?.length || 0}
                  </p>
                </button>
              ))}
            </div>
            <div className="col-span-3 overflow-y-auto max-h-[560px] p-4 space-y-4 text-sm">
              {!selected && (
                <p className="text-on-surface-variant text-xs">왼쪽에서 근거 항목을 선택하세요.</p>
              )}
              {selected && (
                <>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-1">Prompt</p>
                    <p className="text-on-surface">{selected.prompt}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-1">Answer</p>
                    <p className="text-on-surface-variant whitespace-pre-wrap text-xs leading-relaxed">
                      {selected.answer.slice(0, 1200)}
                      {selected.answer.length > 1200 ? '…' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                    <span className="px-2 py-1 rounded bg-surface-container">mode:{selected.ragMode}</span>
                    <span className="px-2 py-1 rounded bg-surface-container">
                      conf:{selected.confidence ?? '—'}
                    </span>
                    {(selected.toolsUsed || []).map((t) => (
                      <span key={t} className="px-2 py-1 rounded bg-google-blue/15 text-google-blue">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-2">
                      Referenced hosts
                    </p>
                    {selected.referencedHosts?.length ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {selected.referencedHosts.map((h) => (
                          <li
                            key={h}
                            className="px-2 py-1 rounded-md bg-solana-green/10 text-solana-green text-xs font-mono"
                          >
                            {h}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-on-surface-variant">호스트 없음</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-2">Citations</p>
                    <ul className="space-y-2">
                      {(selected.citations || []).length === 0 && (
                        <li className="text-xs text-on-surface-variant">citation 없음</li>
                      )}
                      {(selected.citations || []).map((c, i) => (
                        <li
                          key={`${c.uri || c.title || i}`}
                          className="rounded-lg border border-outline-variant/20 p-3 bg-surface-container-lowest/50"
                        >
                          <p className="text-xs font-semibold text-on-surface">
                            {c.title || c.uri || `citation ${i + 1}`}
                          </p>
                          {c.uri && (
                            <a
                              href={c.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-google-blue break-all mt-1"
                            >
                              {c.uri} <ExternalLink className="w-3 h-3 shrink-0" />
                            </a>
                          )}
                          {c.snippet && (
                            <p className="mt-1 text-[11px] text-on-surface-variant line-clamp-4">
                              {c.snippet}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {selected.referencedUrls?.length ? (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-outline mb-2">URLs</p>
                      <ul className="space-y-1">
                        {selected.referencedUrls.map((u) => (
                          <li key={u}>
                            <a
                              href={u}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-google-blue break-all"
                            >
                              {u}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {selected.retrievalError && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                      retrievalError: {selected.retrievalError}
                    </div>
                  )}
                  <details className="text-[10px] text-on-surface-variant">
                    <summary className="cursor-pointer">raw JSON</summary>
                    <pre className="mt-2 overflow-x-auto max-h-48">
                      {JSON.stringify(selected, null, 2)}
                    </pre>
                  </details>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-outline-variant/15 bg-surface-container px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-outline">{label}</p>
      <p className="font-mono text-[11px] text-on-surface truncate" title={value}>
        {value}
      </p>
    </div>
  );
}
