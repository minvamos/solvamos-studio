/**
 * Stitch: on_chain_settlement_history_updated_ui (KO nav labels elsewhere)
 */
import { useMemo, useState } from 'react';
import { Download, ExternalLink, CheckCircle2, XCircle, Filter } from 'lucide-react';
import { Agent, Settlement } from '../types';

type Props = {
  settlements: Settlement[];
  agents: Agent[];
};

type StatusFilter = 'all' | 'success' | 'failed';

export default function SettlementsPage({ settlements, agents }: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const success = settlements.filter((s) => s.status === 'success');
  const failed = settlements.filter((s) => s.status === 'failed');
  const totalUsdc = success.reduce((sum, s) => sum + s.amount, 0);

  const filtered = useMemo(() => {
    return settlements.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (agentFilter !== 'all' && s.agentId !== agentFilter) return false;
      return true;
    });
  }, [settlements, statusFilter, agentFilter]);

  const exportCsv = () => {
    const header = 'tx,agentId,wallet,amount,status,timestamp,blockHeight\n';
    const rows = filtered
      .map(
        (s) =>
          `${s.id},${s.agentId},${s.recipientWallet},${s.amount},${s.status},${s.timestamp},${s.blockHeight}`
      )
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'solvamos-settlements.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const agentIds = Array.from(new Set(settlements.map((s) => s.agentId)));

  return (
    <div className="flex flex-col gap-gutter">
      <div className="flex justify-between items-end flex-wrap gap-4">
        <div>
          <h2 className="text-3xl font-semibold text-on-surface mb-2">온체인 정산 내역</h2>
          <p className="text-base text-on-surface-variant">
            실제 결제 검증이 성공한 트랜잭션만 표시됩니다. MOCK 시드 데이터는 제거되었습니다.
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="btn-primary px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          CSV Export
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter">
        <Stat label="Total Settled" value={`$${totalUsdc.toFixed(3)}`} accent="solana" />
        <Stat label="Success TX" value={String(success.length)} accent="blue" />
        <Stat label="Failed TX" value={String(failed.length)} accent="error" />
      </div>

      <div className="flex flex-wrap gap-2 items-center bg-surface-container p-3 rounded-lg border border-outline-variant/10">
        <Filter className="w-4 h-4 text-on-surface-variant" />
        {(['all', 'success', 'failed'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setStatusFilter(id)}
            className={
              statusFilter === id
                ? 'px-3 py-1.5 rounded-md text-sm font-medium bg-google-blue/20 text-google-blue border border-google-blue/30'
                : 'px-3 py-1.5 rounded-md text-sm font-medium text-on-surface-variant hover:bg-surface-container-high'
            }
          >
            {id === 'all' ? 'All' : id === 'success' ? 'SUCCESS' : 'FAILED'}
          </button>
        ))}
        <div className="h-5 w-px bg-outline-variant/30 mx-1" />
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="bg-surface-container-high border border-outline-variant/30 rounded-md py-1.5 px-3 text-sm text-on-surface"
        >
          <option value="all">All Agents</option>
          {agentIds.map((id) => {
            const ag = agents.find((a) => a.id === id);
            return (
              <option key={id} value={id}>
                {ag?.customRole || ag?.role || id.slice(0, 16)}
              </option>
            );
          })}
        </select>
      </div>

      <div className="glass-panel rounded-xl overflow-hidden border border-outline-variant/10">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-container-high/80 text-on-surface-variant text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 font-semibold">Timestamp</th>
                <th className="px-4 py-3 font-semibold">Agent</th>
                <th className="px-4 py-3 font-semibold">Amount</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">TX / Proof</th>
                <th className="px-4 py-3 font-semibold">Block</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                    아직 검증된 결제가 없습니다. 유료 에이전트 호출이 온체인/게이트웨이로 성공하면 여기에
                    signature·slot이 기록됩니다.
                  </td>
                </tr>
              )}
              {filtered.map((s) => {
                const ag = agents.find((a) => a.id === s.agentId);
                const explorer =
                  s.explorerUrl ||
                  (s.id.startsWith('PAYSH_') || s.id.startsWith('SANDBOX_') || s.id.startsWith('MOCK_')
                    ? null
                    : `https://explorer.solana.com/tx/${s.id}?cluster=devnet`);
                return (
                  <tr
                    key={s.id + s.timestamp}
                    className="border-t border-outline-variant/10 hover:bg-surface-container-high/40"
                  >
                    <td className="px-4 py-3 text-on-surface-variant whitespace-nowrap">
                      {s.timestamp}
                      {s.proofKind ? (
                        <span className="ml-2 text-[10px] uppercase text-outline">{s.proofKind}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-on-surface">
                      {ag?.agentName || ag?.customRole || ag?.role || s.agentId.slice(0, 12)}
                    </td>
                    <td className="px-4 py-3 font-mono text-google-blue">
                      ${s.amount.toFixed(3)} USDC
                    </td>
                    <td className="px-4 py-3">
                      {s.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-solana-green/10 text-solana-green text-xs font-semibold border border-solana-green/20">
                          <CheckCircle2 className="w-3 h-3" /> SUCCESS
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-error/10 text-error text-xs font-semibold border border-error/20">
                          <XCircle className="w-3 h-3" /> FAILED
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-on-surface-variant">
                      {explorer ? (
                        <a
                          href={explorer}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {s.id.slice(0, 12)}…
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span title={s.id}>{s.id.slice(0, 18)}…</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-on-surface-variant">
                      {s.blockHeight || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: 'solana' | 'blue' | 'error';
}) {
  const border =
    accent === 'solana'
      ? 'border-l-solana-green'
      : accent === 'blue'
        ? 'border-l-google-blue'
        : 'border-l-error';
  const color =
    accent === 'solana'
      ? 'text-solana-green'
      : accent === 'blue'
        ? 'text-google-blue'
        : 'text-error';
  return (
    <div className={`glass-panel rounded-xl p-6 border-l-4 ${border}`}>
      <p className="text-sm font-medium text-on-surface-variant mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}
