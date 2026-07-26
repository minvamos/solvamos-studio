/**
 * Stitch: solvamos_studio_my_agent_list
 */
import { useMemo, useState, type ReactNode } from 'react';
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
  Activity,
  Trash2,
} from 'lucide-react';
import { Agent } from '../types';

type Props = {
  agents: Agent[];
  marketplaceUrl?: string | null;
  onSelect: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onToggleStatus?: (agent: Agent) => void;
  onDelete?: (agent: Agent) => void | Promise<void>;
  deletingAgentId?: string | null;
};

type Filter = 'all' | 'active' | 'inactive';
type SortKey = 'revenue' | 'calls' | 'name' | 'fee';

export default function AgentsPage({
  agents,
  marketplaceUrl,
  onSelect,
  onEdit,
  onToggleStatus,
  onDelete,
  deletingAgentId,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('calls');
  const [copied, setCopied] = useState<string | null>(null);

  const catalogHome =
    marketplaceUrl ||
    'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace';

  const activeCount = agents.filter((a) => {
    const s = a.status || 'ACTIVE';
    return s !== 'inactive' && s !== 'PAUSED';
  }).length;
  const totalCalls = agents.reduce((sum, a) => sum + (a.invokeCount || 0), 0);
  const paidCount = agents.filter((a) => (a.fee ?? a.perCallPriceUsdc ?? 0) > 0).length;
  const estRevenue = agents.reduce((sum, a) => sum + (a.estSellerRevenueUsdc || 0), 0);

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
      if (sort === 'fee') {
        return (b.fee ?? b.perCallPriceUsdc ?? 0) - (a.fee ?? a.perCallPriceUsdc ?? 0);
      }
      if (sort === 'revenue') {
        return (b.estSellerRevenueUsdc || 0) - (a.estSellerRevenueUsdc || 0);
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
            Paid Calls·seller 수익(정산×플랫폼 수수료 제외)·Vault 잔액을 확인하고 카탈로그로
            이동하세요. Studio 테스트는 집계에서 제외됩니다.
          </p>
        </div>
        <a
          href={catalogHome}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-solana-green/40 bg-solana-green/10 px-4 py-2 text-sm font-semibold text-solana-green hover:bg-solana-green/20"
        >
          마켓플레이스 열기 <ExternalLink className="h-4 w-4" />
        </a>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-gutter">
        <MetricCard
          icon={<Bot className="w-6 h-6 text-solana-green" />}
          label="Active"
          value={String(activeCount)}
          accent="border-l-solana-green"
        />
        <MetricCard
          icon={<Activity className="w-6 h-6 text-google-blue" />}
          label="Total Paid/API Calls"
          value={totalCalls.toLocaleString()}
          accent="border-l-google-blue"
        />
        <MetricCard
          icon={<Coins className="w-6 h-6 text-secondary" />}
          label="Paid Agents"
          value={String(paidCount)}
          accent="border-l-secondary"
        />
        <MetricCard
          icon={<BarChart3 className="w-6 h-6 text-google-blue" />}
          label="Est. Revenue (seller)"
          value={`$${estRevenue.toFixed(3)}`}
          accent="border-l-google-blue"
        />
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
          <option value="calls">Sort by: API Calls</option>
          <option value="revenue">Sort by: Revenue</option>
          <option value="fee">Sort by: Fee</option>
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
          const rev = agent.estSellerRevenueUsdc || 0;
          const vaultUsdc = agent.vaultUsdc;
          const invokeUrl = agent.invokeUrl || agent.payShCatalog?.publicInvokeUrl || '';
          const pageUrl =
            agent.catalogPageUrl ||
            agent.payShCatalog?.catalogPageUrl ||
            '';
          const cardUrl = agent.agentCardUrl || agent.payShCatalog?.agentCardUrl || '';
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
                      <span className="text-xs font-medium text-secondary">
                        {fee <= 0 ? 'Free' : `$${fee.toFixed(3)} USDC`}
                      </span>
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
                    <p className="text-xs text-on-surface-variant">
                      {(agent.fee ?? agent.perCallPriceUsdc ?? 0) > 0 ? 'Paid Calls' : 'API Calls'}
                    </p>
                    <p className="text-lg font-semibold text-on-surface">{agent.invokeCount || 0}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-on-surface-variant">Est. Revenue</p>
                    <p className="text-lg font-semibold text-google-blue">${rev.toFixed(3)}</p>
                    <p className="text-[10px] text-outline">seller share</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-on-surface-variant">Vault USDC</p>
                    <p className="text-lg font-semibold text-solana-green">
                      {typeof vaultUsdc === 'number' ? vaultUsdc.toFixed(3) : '—'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(agent)}
                      className="p-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface"
                      title="상세 / 테스트"
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
                    <button
                      type="button"
                      onClick={() => onDelete?.(agent)}
                      disabled={!onDelete || deletingAgentId === agent.id}
                      className="px-3 py-2 rounded-lg border border-red-500/30 text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-1 disabled:opacity-50"
                      title="에이전트 삭제 (AI App·데이터스토어 포함)"
                    >
                      <Trash2 className="w-4 h-4" />
                      {deletingAgentId === agent.id ? '삭제 중…' : '삭제'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {pageUrl ? (
                  <div className="rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-1">
                      Catalog page
                    </p>
                    <div className="flex items-start gap-2">
                      <a
                        href={pageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1 break-all font-mono text-xs text-google-blue hover:underline"
                      >
                        {pageUrl}
                      </a>
                      <button
                        type="button"
                        onClick={() => copy(pageUrl, `page-${agent.id}`)}
                        className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue"
                        title="복사"
                      >
                        {copied === `page-${agent.id}` ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ) : null}
                {invokeUrl ? (
                  <div className="rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-1">
                      Invoke API
                    </p>
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
                {cardUrl ? (
                  <div className="rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60 p-3 sm:col-span-2">
                    <p className="text-[10px] uppercase tracking-wider text-outline mb-1">
                      Agent Card
                    </p>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-on-surface-variant">
                        {cardUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => copy(cardUrl, `card-${agent.id}`)}
                        className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue"
                        title="복사"
                      >
                        {copied === `card-${agent.id}` ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className={`glass-panel rounded-xl p-5 flex items-center gap-4 border-l-4 ${accent}`}>
      <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-on-surface-variant mb-0.5">{label}</p>
        <p className="text-xl font-semibold text-on-surface truncate">{value}</p>
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
