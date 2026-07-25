/**
 * Developer server logs — ring buffer from /api/dev/logs
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, ScrollText, Filter } from 'lucide-react';

type DevLogEntry = {
  id: string;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  meta?: unknown;
};

type Props = {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
};

const LEVEL_STYLE: Record<string, string> = {
  error: 'text-red-400 border-red-500/30 bg-red-500/10',
  warn: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  info: 'text-sky-300 border-sky-500/20 bg-sky-500/5',
  debug: 'text-on-surface-variant border-outline-variant/20 bg-surface-container',
};

export default function DevLogsPage({ authFetch }: Props) {
  const [logs, setLogs] = useState<DevLogEntry[]>([]);
  const [stats, setStats] = useState<{ total: number; max: number; byLevel: Record<string, number> } | null>(
    null
  );
  const [level, setLevel] = useState<string>('all');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '400' });
      if (level !== 'all') params.set('level', level);
      if (tag.trim()) params.set('tag', tag.trim());
      if (q.trim()) params.set('q', q.trim());
      const res = await authFetch(`/api/dev/logs?${params}`);
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      setLogs(data.logs || []);
      setStats(data.stats || null);
    } catch (err: any) {
      setError(err?.message || '로그 로드 실패');
    } finally {
      setBusy(false);
    }
  }, [authFetch, level, tag, q]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  const clear = async () => {
    if (!window.confirm('개발자 로그 버퍼를 비울까요?')) return;
    await authFetch('/api/dev/logs', { method: 'DELETE' });
    await load();
  };

  return (
    <div className="flex flex-col gap-4 min-h-[70vh]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl font-semibold text-on-surface mb-1 flex items-center gap-2">
            <ScrollText className="w-7 h-7 text-google-blue" />
            개발자 서버 로그
          </h2>
          <p className="text-sm text-on-surface-variant">
            에이전트 생성/수정/invoke·GCP 오류를 실시간으로 확인합니다.
            {stats ? ` · 버퍼 ${stats.total}/${stats.max}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-xs text-on-surface-variant px-2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            자동 새로고침
          </label>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-container-high text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
            새로고침
          </button>
          <button
            type="button"
            onClick={() => void clear()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/30 text-red-400 text-sm"
          >
            <Trash2 className="w-4 h-4" />
            비우기
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center bg-surface-container p-3 rounded-xl border border-outline-variant/15">
        <Filter className="w-4 h-4 text-on-surface-variant" />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="bg-surface-container-high border border-outline-variant/30 rounded-md py-1.5 px-3 text-sm"
        >
          <option value="all">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="tag (create, invoke…)"
          className="bg-surface-container-high border border-outline-variant/30 rounded-md py-1.5 px-3 text-sm w-40"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="검색어"
          className="bg-surface-container-high border border-outline-variant/30 rounded-md py-1.5 px-3 text-sm flex-1 min-w-[160px]"
        />
        {stats?.byLevel && (
          <span className="text-[11px] text-on-surface-variant font-mono">
            e:{stats.byLevel.error || 0} w:{stats.byLevel.warn || 0} i:{stats.byLevel.info || 0}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40 overflow-hidden">
        <div className="max-h-[65vh] overflow-y-auto divide-y divide-outline-variant/10 font-mono text-xs">
          {logs.length === 0 && (
            <p className="p-8 text-center text-on-surface-variant">표시할 로그가 없습니다.</p>
          )}
          {logs.map((log) => (
            <div key={log.id} className="px-4 py-3 hover:bg-surface-container/40">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-outline">{new Date(log.ts).toLocaleTimeString()}</span>
                <span
                  className={`px-1.5 py-0.5 rounded border text-[10px] uppercase font-semibold ${
                    LEVEL_STYLE[log.level] || LEVEL_STYLE.info
                  }`}
                >
                  {log.level}
                </span>
                <span className="text-solana-green">[{log.tag}]</span>
              </div>
              <p className="text-on-surface whitespace-pre-wrap break-words">{log.message}</p>
              {log.meta != null && (
                <pre className="mt-2 text-[10px] text-on-surface-variant overflow-x-auto max-h-40">
                  {typeof log.meta === 'string' ? log.meta : JSON.stringify(log.meta, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
