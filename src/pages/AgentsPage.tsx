/**
 * Stitch: solvamos_studio_my_agent_list
 */
import { useMemo, useState } from 'react';
import {
  Bot,
  BarChart3,
  Pencil,
  Pause,
  Play,
  Briefcase,
  Smile,
  Coins,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import { Agent } from '../types';

type Props = {
  agents: Agent[];
  onSelect: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onToggleStatus?: (agent: Agent) => void;
};

type Filter = 'all' | 'active' | 'inactive';
type SortKey = 'revenue' | 'calls' | 'name';

export default function AgentsPage({ agents, onSelect, onEdit, onToggleStatus }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('calls');
  const [copied, setCopied] = useState<string | null>(null);

  const catalogPageUrl = agents[0]?.catalogPageUrl || '/catalog';
  const catalogApiUrl = agents[0]?.catalogApiUrl || '/api/paysh/catalog';

  const activeCount = agents.filter((a) => {
    const s = a.status || 'ACTIVE';
    return s !== 'inactive' && s !== 'PAUSED';
  }).length;
  const revenue24h = agents.reduce(
    (sum, a) => sum + (a.invokeCount || 0) * (a.fee ?? a.perCallPriceUsdc ?? 0.001),
    0
  );

  const filtered = useMemo(() => {
    let list = [...agents];
    if (filter === 'active')
      list = list.filter((a) => {
        const s = a.status || 'ACTIVE';
        return s !== 'inactive' && s !== 'PAUSED';
      });
    if (filter === 'inactive')
      list = list.filter((a) => a.status === 'inactive' || a.status === 'PAUSED');
    list.sort((a, b) => {
      if (sort === 'name') {
        return (a.customRole || a.role).localeCompare(b.customRole || b.role);
      }
      if (sort === 'revenue') {
        const ra = (a.invokeCount || 0) * (a.fee ?? 0.001);
        const rb = (b.invokeCount || 0) * (b.fee ?? 0.001);
        return rb - ra;
      }
      return (b.invokeCount || 0) - (a.invokeCount || 0);
    });
    return list;
  }, [agents, filter, sort]);

  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex flex-col gap-gutter">
      <div className="flex justify-between items-end gap-4 flex-wrap">
        <div>
          <h2 className="text-3xl font-semibold text-on-surface mb-2">내 에이전트 목록</h2>
          <p className="text-base text-on-surface-variant">
            관리 중인 AI 에이전트들의 가동 상태와 공개 카탈로그 주소를 확인하세요.
          </p>
        </div>
        <a
          href={catalogPageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-solana-green/40 bg-solana-green/10 px-4 py-2 text-sm font-semibold text-solana-green hover:bg-solana-green/20"
        >
          공개 카탈로그 열기 <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      <div className="glass-panel rounded-xl p-4 border border-outline-variant/20">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-outline mb-2">
          pay.sh 카탈로그 주소
        </p>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <code className="font-mono text-xs break-all text-on-surface">{catalogPageUrl}</code>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => copy(catalogPageUrl, 'page')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-google-blue/15 px-3 py-1.5 text-xs text-google-blue"
            >
              {copied === 'page' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              페이지 복사
            </button>
            <button
              type="button"
              onClick={() => copy(catalogApiUrl, 'api')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-3 py-1.5 text-xs text-on-surface-variant"
            >
              {copied === 'api' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              API 복사
            </button>
          </div>
        </div>
        <p className="mt-2 font-mono text-[11px] break-all text-outline">{catalogApiUrl}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
        <div className="glass-panel rounded-xl p-6 flex items-center gap-6 border-l-4 border-l-solana-green">
          <div className="w-12 h-12 rounded-full bg-solana-green/10 flex items-center justify-center">
            <Bot className="w-7 h-7 text-solana-green" />
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface-variant mb-1">Total Active Agents</p>
            <p className="text-2xl font-semibold text-on-surface">{activeCount}</p>
          </div>
        </div>
        <div className="glass-panel rounded-xl p-6 flex items-center gap-6 border-l-4 border-l-google-blue">
          <div className="w-12 h-12 rounded-full bg-google-blue/10 flex items-center justify-center">
            <Coins className="w-7 h-7 text-google-blue" />
          </div>
          <div>
            <p className="text-sm font-medium text-on-surface-variant mb-1">Est. Revenue (lifetime)</p>
            <p className="text-2xl font-semibold text-google-blue flex items-baseline gap-1">
              ${revenue24h.toFixed(2)}{' '}
              <span className="text-xs font-semibold text-on-surface-variant">USDC</span>
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center bg-surface-container p-2 rounded-lg border border-outline-variant/10 flex-wrap gap-2">
        <div className="flex gap-2">
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['inactive', 'Inactive'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={
                filter === id
                  ? 'px-4 py-1.5 rounded-md text-sm font-medium bg-google-blue/20 text-google-blue border border-google-blue/30'
                  : 'px-4 py-1.5 rounded-md text-sm font-medium text-on-surface-variant hover:bg-surface-container-high transition-colors'
              }
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="bg-surface-container-high border border-outline-variant/30 rounded-md py-1.5 px-3 text-sm text-on-surface"
        >
          <option value="revenue">Sort by: Revenue</option>
          <option value="calls">Sort by: API Calls</option>
          <option value="name">Sort by: Name</option>
        </select>
      </div>

      <div className="flex flex-col gap-4">
        {filtered.length === 0 && (
          <div className="glass-panel rounded-xl p-8 text-center text-on-surface-variant">
            등록된 에이전트가 없습니다. 스튜디오에서 새 에이전트를 생성하세요.
          </div>
        )}
        {filtered.map((agent) => {
          const inactive = agent.status === 'inactive' || agent.status === 'PAUSED';
          const title = agent.agentName || agent.customRole || roleLabel(agent.role);
          const fee = agent.fee ?? agent.perCallPriceUsdc ?? 0;
          const rev = (agent.invokeCount || 0) * fee;
          const invokeUrl = agent.invokeUrl || agent.payShCatalog?.publicInvokeUrl || '';
          return (
            <div
              key={agent.id}
              className={
                inactive
                  ? 'glass-panel rounded-xl p-6 opacity-75 grayscale-[30%] transition-all duration-200'
                  : 'glass-panel rounded-xl p-6 transition-all duration-200'
              }
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <button
                  type="button"
                  onClick={() => onSelect(agent)}
                  className="flex items-center gap-4 flex-grow text-left"
                >
                  <div className="w-14 h-14 rounded-lg bg-surface-container-high flex items-center justify-center border border-outline-variant/20 shrink-0">
                    <Bot className="w-7 h-7 text-on-surface" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-xl font-semibold text-on-surface">{title}</h3>
                      <div
                        className={
                          inactive
                            ? 'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-outline/10 border border-outline/20'
                            : 'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-solana-green/10 border border-solana-green/20'
                        }
                      >
                        <div
                          className={
                            inactive
                              ? 'w-2 h-2 rounded-full bg-outline'
                              : 'w-2 h-2 rounded-full bg-solana-green shadow-[0_0_8px_rgba(20,241,149,0.8)]'
                          }
                        />
                        <span
                          className={
                            inactive
                              ? 'text-xs font-semibold text-outline'
                              : 'text-xs font-semibold text-solana-green'
                          }
                        >
                          {inactive ? 'Inactive' : 'Active'}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-4 text-on-surface-variant text-sm flex-wrap">
                      <span className="flex items-center gap-1">
                        <Briefcase className="w-4 h-4" /> {roleLabel(agent.role)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Smile className="w-4 h-4" /> {agent.tone}
                      </span>
                      <span className="font-mono text-xs">{agent.id.slice(0, 12)}…</span>
                    </div>
                  </div>
                </button>

                <div className="flex items-center gap-6 flex-wrap">
                  <div className="text-right">
                    <p className="text-xs text-on-surface-variant">API Calls</p>
                    <p className="text-lg font-semibold text-on-surface">{agent.invokeCount || 0}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-on-surface-variant">Revenue</p>
                    <p className="text-lg font-semibold text-google-blue">${rev.toFixed(3)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(agent)}
                      className="p-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface"
                      title="테스트"
                    >
                      <BarChart3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(agent)}
                      className="p-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface"
                      title="편집"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleStatus?.(agent)}
                      disabled={!onToggleStatus}
                      className="px-3 py-2 rounded-lg border border-outline-variant/30 text-sm text-on-surface-variant hover:text-on-surface flex items-center gap-1 disabled:opacity-50"
                      title={inactive ? 'Activate' : 'Pause'}
                    >
                      {inactive ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                      {inactive ? 'Activate' : 'Pause'}
                    </button>
                  </div>
                </div>
              </div>

              {invokeUrl ? (
                <div className="mt-4 rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-outline mb-1">Invoke API</p>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs text-on-surface-variant">
                      {invokeUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(invokeUrl, `invoke-${agent.id}`)}
                      className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue"
                      title="복사"
                    >
                      {copied === `invoke-${agent.id}` ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function roleLabel(role: string) {
  switch (role) {
    case 'support':
      return '고객지원/CS';
    case 'academic':
      return '기술 지원';
    case 'weather':
      return '날씨/정보';
    case 'custom':
      return 'HR/복지';
    default:
      return role;
  }
}
