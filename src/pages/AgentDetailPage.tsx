/**
 * My-agent detail: catalog-style overview + owner-test chat tabs.
 */
import {
  FormEvent,
  RefObject,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Bot,
  Check,
  Copy,
  ExternalLink,
  MessageSquare,
  Pencil,
  QrCode,
  Wallet,
} from 'lucide-react';
import type { Agent, ChatAttachment, Message } from '../types';
import AgentTestChat from '../components/AgentTestChat';
import {
  fundAgentVaultFromPhantom,
  qrDataUrlForPay,
  waitForSolanaPayConfirmations,
  type SolanaPayIntentClient,
} from '../lib/solanaFund';

export type DetailTab = 'overview' | 'test';

type PendingPayment = {
  agentId: string;
  amount: number;
  token: string;
  recipientWallet: string;
  prompt: string;
  network?: string;
  paymentNetwork?: string;
  invokeUrl?: string;
  gatewayUrl?: string;
  message?: string;
} | null;

type Props = {
  agent: Agent;
  initialTab?: DetailTab;
  marketplaceUrl?: string | null;
  onBack: () => void;
  onEdit: (agent: Agent) => void;
  chatHistory: Record<string, Message[]>;
  inputText: string;
  setInputText: (v: string) => void;
  onSendMessage: (e: FormEvent) => void;
  pendingPayment: PendingPayment;
  paymentLogs: string[];
  onAcknowledgeAndSign: (useRandomSig?: boolean) => void;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  /** Persist A2A peer setting on the agent (edit + test chat). */
  onToggleA2APeers?: (enabled: boolean) => void | Promise<void>;
  chatAttachments?: ChatAttachment[];
  onChatAttachmentsChange?: (files: ChatAttachment[]) => void;
  enableWebSearch?: boolean;
  setEnableWebSearch?: (v: boolean) => void;
  paymentNetwork?: string;
  primaryWalletAddress?: string | null;
  primaryWalletLabel?: string | null;
  copiedId?: string | null;
  onCopy: (text: string, id: string) => void;
  authFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  solanaRpcUrl?: string | null;
  usdcMint?: string | null;
};

function roleLabel(role: string) {
  if (role === 'custom') return '커스텀';
  if (role === 'support') return '고객지원';
  if (role === 'academic') return '기술 지원';
  if (role === 'weather') return '날씨/정보';
  return role;
}

export default function AgentDetailPage({
  agent,
  initialTab = 'overview',
  marketplaceUrl,
  onBack,
  onEdit,
  chatHistory,
  inputText,
  setInputText,
  onSendMessage,
  pendingPayment,
  paymentLogs,
  onAcknowledgeAndSign,
  chatScrollRef,
  onToggleA2APeers,
  chatAttachments,
  onChatAttachmentsChange,
  enableWebSearch,
  setEnableWebSearch,
  paymentNetwork,
  primaryWalletAddress,
  primaryWalletLabel,
  copiedId,
  onCopy,
  authFetch,
  solanaRpcUrl,
  usdcMint,
}: Props) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [copied, setCopied] = useState<string | null>(null);
  const [vaultBalance, setVaultBalance] = useState<{
    sol: number | null;
    usdc: number | null;
  } | null>(null);
  const [rpcUrl, setRpcUrl] = useState(solanaRpcUrl || '');
  const [mint, setMint] = useState(usdcMint || '');
  const [fundUsdc, setFundUsdc] = useState('1');
  const [fundSol, setFundSol] = useState('0.05');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultMsg, setVaultMsg] = useState<string | null>(null);
  const [vaultErr, setVaultErr] = useState<string | null>(null);
  const [payIntents, setPayIntents] = useState<SolanaPayIntentClient[]>([]);
  const [payWaiting, setPayWaiting] = useState(false);

  useEffect(() => {
    setTab(initialTab);
  }, [agent.id, initialTab]);

  const refreshBalance = useCallback(async () => {
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/balance`);
      const json = r.ok ? await r.json() : null;
      if (!json) return;
      setVaultBalance({
        sol: typeof json.currentSolBalance === 'number' ? json.currentSolBalance : null,
        usdc: typeof json.currentUsdcBalance === 'number' ? json.currentUsdcBalance : null,
      });
      if (json.solanaRpcUrl) setRpcUrl(String(json.solanaRpcUrl));
      if (json.usdcMint) setMint(String(json.usdcMint));
    } catch {
      /* ignore */
    }
  }, [agent.id]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const title = agent.agentName || agent.customRole || roleLabel(agent.role);
  const fee = agent.fee ?? agent.perCallPriceUsdc ?? 0;
  const paid = fee > 0;
  const inactive = agent.status === 'inactive' || agent.status === 'PAUSED';
  const pageUrl =
    agent.catalogPageUrl || agent.payShCatalog?.catalogPageUrl || '';
  const apiUrl = agent.catalogApiUrl || agent.payShCatalog?.catalogApiUrl || '';
  const invokeUrl = agent.invokeUrl || agent.payShCatalog?.publicInvokeUrl || '';
  const cardUrl = agent.agentCardUrl || agent.payShCatalog?.agentCardUrl || '';
  const callExample = paid
    ? `pay fetch "${invokeUrl}?prompt=${encodeURIComponent('안녕하세요')}"`
    : `curl -X POST "${invokeUrl}" -H "Content-Type: application/json" -d "{\\"prompt\\":\\"안녕하세요\\"}"`;

  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    onCopy(value, key);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const messages = chatHistory[agent.id] || [];

  return (
    <div className="flex flex-col gap-gutter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
        >
          <ArrowLeft className="h-4 w-4" /> 목록으로
        </button>
        <button
          type="button"
          onClick={() => onEdit(agent)}
          className="inline-flex items-center gap-2 rounded-lg border border-google-blue/40 bg-google-blue/10 px-4 py-2 text-sm font-semibold text-google-blue hover:bg-google-blue/20"
        >
          <Pencil className="h-4 w-4" /> 편집
        </button>
      </div>

      <header className="flex items-start gap-4">
        <div className="rounded-xl border border-google-blue/30 bg-google-blue/10 p-3 shrink-0">
          <Bot className="h-8 w-8 text-google-blue" />
        </div>
        <div className="min-w-0">
          <p className="font-mono text-xs text-outline">{agent.id}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface md:text-4xl">
            {title}
          </h1>
          <p className="mt-2 text-on-surface-variant">
            {roleLabel(agent.role)} · {fee <= 0 ? 'Free' : `${fee} USDC`} / call ·{' '}
            {paymentNetwork || 'devnet'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span
              className={
                inactive
                  ? 'rounded-md border border-outline/30 bg-outline/10 px-2 py-1 text-[10px] font-semibold uppercase text-outline'
                  : 'rounded-md border border-solana-green/30 bg-solana-green/15 px-2 py-1 text-[10px] font-semibold uppercase text-solana-green'
              }
            >
              {inactive ? 'Paused' : 'Active'}
            </span>
            <span
              className={
                paid
                  ? 'rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold uppercase text-emerald-300'
                  : 'rounded-md border border-outline-variant/30 bg-surface-container-high px-2 py-1 text-[10px] font-semibold uppercase text-on-surface-variant'
              }
            >
              {paid ? 'x402 / MPP' : 'free'}
            </span>
            <span
              className={
                agent.a2aPeersEnabled !== false
                  ? 'rounded-md border border-google-blue/30 bg-google-blue/15 px-2 py-1 text-[10px] font-semibold uppercase text-google-blue'
                  : 'rounded-md border border-outline-variant/30 bg-surface-container-high px-2 py-1 text-[10px] font-semibold uppercase text-on-surface-variant'
              }
            >
              {agent.a2aPeersEnabled !== false ? 'A2A peers ON' : 'A2A peers OFF'}
            </span>
          </div>
        </div>
      </header>

      <div className="flex gap-2 border-b border-outline-variant/20">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
          상세 정보
        </TabButton>
        <TabButton active={tab === 'test'} onClick={() => setTab('test')}>
          <MessageSquare className="h-4 w-4" />
          테스트 대화
        </TabButton>
      </div>

      {tab === 'overview' ? (
        <div className="space-y-4">
          <section className="glass-panel rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold tracking-wider text-outline uppercase">
              개요
            </h2>
            <p className="text-sm text-on-surface-variant leading-relaxed">
              모드{' '}
              {agent.runtimeMode === 'autonomous' ? '자율(Gemini+RAG)' : '특화(AI Applications)'} ·
              역할 {agent.customRole || agent.role} · 톤 {agent.tone} · 보안 {agent.securityLevel}
              {agent.runtimeMode !== 'autonomous' && agent.aiAppType
                ? ` · 앱 ${agent.aiAppType}`
                : ''}
              {agent.dataSourceType ? ` · 소스 ${agent.dataSourceType}` : ''}
            </p>
            {agent.description ? (
              <p className="text-sm text-on-surface leading-relaxed border-t border-outline-variant/20 pt-3">
                {agent.description}
              </p>
            ) : null}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Stat
                label={fee > 0 ? 'Paid Calls' : 'API Calls'}
                value={String(agent.invokeCount || 0)}
              />
              <Stat
                label="예상 수익 (seller 90%)"
                value={`$${(agent.estSellerRevenueUsdc || 0).toFixed(3)}`}
              />
              <Stat
                label="Vault SOL"
                value={
                  vaultBalance?.sol != null
                    ? vaultBalance.sol.toFixed(4)
                    : agent.vaultSol != null
                      ? agent.vaultSol.toFixed(4)
                      : '—'
                }
              />
              <Stat
                label="Vault USDC"
                value={
                  vaultBalance?.usdc != null
                    ? vaultBalance.usdc.toFixed(4)
                    : agent.vaultUsdc != null
                      ? agent.vaultUsdc.toFixed(4)
                      : '—'
                }
              />
            </div>
            <p className="text-[11px] text-outline">
              Studio 테스트 호출은 API Calls·수익에 포함되지 않습니다. 수익은 정산된 결제액의
              seller 지분(기본 90%)만 합산합니다.
            </p>
            {agent.publicKey && (
              <Row
                label="Agent vault"
                value={agent.publicKey}
                copied={copied === 'vault'}
                onCopy={() => copy(agent.publicKey, 'vault')}
              />
            )}
          </section>

          <section className="glass-panel rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold tracking-wider text-outline uppercase">
              Vault 자금 (출금 · 충전)
            </h2>
            <p className="text-sm text-on-surface-variant leading-relaxed">
              A2A peer 결제는 <strong className="text-on-surface">에이전트 vault 잔액</strong>으로만
              합니다. 유저 충전은 Phantom 서명 또는 Solana Pay(QR/딥링크)로 직접 보내고, 출금은
              서버가 주 지갑으로 반환합니다.
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat
                label="Vault SOL"
                value={
                  vaultBalance?.sol != null
                    ? vaultBalance.sol.toFixed(4)
                    : agent.vaultSol != null
                      ? agent.vaultSol.toFixed(4)
                      : '—'
                }
              />
              <Stat
                label="Vault USDC"
                value={
                  vaultBalance?.usdc != null
                    ? vaultBalance.usdc.toFixed(4)
                    : agent.vaultUsdc != null
                      ? agent.vaultUsdc.toFixed(4)
                      : '—'
                }
              />
            </div>
            {primaryWalletAddress ? (
              <p className="text-[11px] text-outline">
                출금 대상(주 지갑): {primaryWalletLabel || 'Wallet'} ·{' '}
                <span className="font-mono">{primaryWalletAddress}</span>
              </p>
            ) : (
              <p className="text-[11px] text-amber-300">
                출금하려면 헤더 Connect Wallet에서 주 지갑을 등록하세요.
              </p>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-outline-variant/25 bg-surface-container-low/50 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                  <ArrowUpFromLine className="h-4 w-4 text-solana-green" />
                  vault → 내 지갑 (출금)
                </div>
                <label className="block text-xs text-on-surface-variant">
                  USDC 금액 (비우면 전액)
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="전액"
                    className="mt-1 w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
                  />
                </label>
                <button
                  type="button"
                  disabled={vaultBusy || !authFetch || !primaryWalletAddress}
                  onClick={async () => {
                    if (!authFetch) return;
                    setVaultBusy(true);
                    setVaultErr(null);
                    setVaultMsg(null);
                    try {
                      const body: Record<string, unknown> = {};
                      if (withdrawAmount.trim()) body.amountUsdc = Number(withdrawAmount);
                      const res = await authFetch(
                        `/api/agents/${encodeURIComponent(agent.id)}/withdraw`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                        }
                      );
                      const json = await res.json().catch(() => ({}));
                      if (!res.ok || json.status !== 'success') {
                        throw new Error(json.message || '출금 실패');
                      }
                      setVaultMsg(json.message || '출금 완료');
                      if (json.explorerUrl) setVaultMsg(`${json.message} · ${json.explorerUrl}`);
                      await refreshBalance();
                    } catch (err: any) {
                      setVaultErr(err?.message || '출금 실패');
                    } finally {
                      setVaultBusy(false);
                    }
                  }}
                  className="w-full rounded-lg border border-solana-green/40 bg-solana-green/15 px-3 py-2 text-sm font-semibold text-solana-green disabled:opacity-40"
                >
                  {vaultBusy ? '처리 중…' : 'USDC 출금'}
                </button>
              </div>

              <div className="rounded-xl border border-outline-variant/25 bg-surface-container-low/50 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                  <ArrowDownToLine className="h-4 w-4 text-google-blue" />
                  내 지갑 → vault (충전)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-on-surface-variant">
                    USDC
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={fundUsdc}
                      onChange={(e) => setFundUsdc(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
                    />
                  </label>
                  <label className="block text-xs text-on-surface-variant">
                    SOL
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={fundSol}
                      onChange={(e) => setFundSol(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    disabled={
                      vaultBusy ||
                      !agent.publicKey ||
                      !rpcUrl ||
                      !mint ||
                      (!(Number(fundUsdc) > 0) && !(Number(fundSol) > 0))
                    }
                    onClick={async () => {
                      setVaultBusy(true);
                      setVaultErr(null);
                      setVaultMsg(null);
                      setPayIntents([]);
                      try {
                        const result = await fundAgentVaultFromPhantom({
                          rpcUrl,
                          usdcMint: mint,
                          vaultAddress: agent.publicKey,
                          usdcAmount: Number(fundUsdc) || 0,
                          solAmount: Number(fundSol) || 0,
                        });
                        if (!result.ok) throw new Error(result.error || '충전 실패');
                        setVaultMsg(
                          result.explorerUrl
                            ? `Phantom 충전 완료 · ${result.explorerUrl}`
                            : `Phantom 충전 완료 · ${result.signature}`
                        );
                        await refreshBalance();
                      } catch (err: any) {
                        setVaultErr(err?.message || '충전 실패');
                      } finally {
                        setVaultBusy(false);
                      }
                    }}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-google-blue/40 bg-google-blue/15 px-3 py-2 text-sm font-semibold text-google-blue disabled:opacity-40"
                  >
                    <Wallet className="h-4 w-4" />
                    {vaultBusy ? '처리 중…' : 'Phantom으로 전송'}
                  </button>
                  <button
                    type="button"
                    disabled={
                      vaultBusy ||
                      payWaiting ||
                      !authFetch ||
                      !agent.publicKey ||
                      (!(Number(fundUsdc) > 0) && !(Number(fundSol) > 0))
                    }
                    onClick={async () => {
                      if (!authFetch) return;
                      setVaultBusy(true);
                      setPayWaiting(true);
                      setVaultErr(null);
                      setVaultMsg(null);
                      setPayIntents([]);
                      try {
                        const res = await authFetch(
                          `/api/agents/${encodeURIComponent(agent.id)}/solana-pay`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              amountUsdc: Number(fundUsdc) || 0,
                              amountSol: Number(fundSol) || 0,
                            }),
                          }
                        );
                        const json = await res.json().catch(() => ({}));
                        if (!res.ok || json.status !== 'success') {
                          throw new Error(json.message || 'Solana Pay 생성 실패');
                        }
                        if (json.rpcUrl) setRpcUrl(String(json.rpcUrl));
                        if (json.usdcMint) setMint(String(json.usdcMint));

                        const intents: SolanaPayIntentClient[] = [];
                        for (const raw of json.intents || []) {
                          const qrDataUrl = await qrDataUrlForPay(String(raw.url));
                          intents.push({
                            kind: raw.kind,
                            amount: Number(raw.amount),
                            url: String(raw.url),
                            reference: String(raw.reference),
                            phantomUrl: raw.phantomUrl ? String(raw.phantomUrl) : undefined,
                            qrDataUrl,
                          });
                        }
                        setPayIntents(intents);
                        setVaultMsg(
                          'Solana Pay 요청 생성됨. QR을 스캔하거나 Phantom 링크를 연 뒤 승인하세요.'
                        );

                        const wait = await waitForSolanaPayConfirmations({
                          authFetch,
                          agentId: agent.id,
                          references: intents.map((i) => i.reference),
                          onProgress: (done) => {
                            setVaultMsg(`온체인 확인 ${done.length}/${intents.length}…`);
                          },
                        });
                        if (!wait.confirmed.length) {
                          throw new Error(wait.error || '결제 미확인');
                        }
                        setVaultMsg(
                          wait.explorerUrls.length
                            ? `Solana Pay 충전 확인 · ${wait.explorerUrls.join(' · ')}`
                            : `Solana Pay 충전 확인 (${wait.confirmed.length}건)`
                        );
                        await refreshBalance();
                      } catch (err: any) {
                        setVaultErr(err?.message || 'Solana Pay 실패');
                      } finally {
                        setVaultBusy(false);
                        setPayWaiting(false);
                      }
                    }}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-sm font-semibold text-on-surface disabled:opacity-40"
                  >
                    <QrCode className="h-4 w-4 text-google-blue" />
                    {payWaiting ? '결제 대기 중…' : 'Solana Pay (QR)'}
                  </button>
                  <button
                    type="button"
                    disabled={
                      vaultBusy ||
                      !authFetch ||
                      !agent.publicKey ||
                      (!(Number(fundUsdc) > 0) && !(Number(fundSol) > 0))
                    }
                    onClick={async () => {
                      if (!authFetch) return;
                      setVaultBusy(true);
                      setVaultErr(null);
                      setVaultMsg(null);
                      try {
                        const res = await authFetch(
                          `/api/agents/${encodeURIComponent(agent.id)}/fund`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              amountUsdc: Number(fundUsdc) || 0,
                              amountSol: Number(fundSol) || 0,
                            }),
                          }
                        );
                        const json = await res.json().catch(() => ({}));
                        if (!res.ok || json.status !== 'success') {
                          throw new Error(json.message || '테스트 충전 실패');
                        }
                        setVaultMsg(
                          json.explorerUrl
                            ? `스튜디오 테스트 충전 · ${json.explorerUrl}`
                            : json.message || '테스트 충전 완료'
                        );
                        await refreshBalance();
                      } catch (err: any) {
                        setVaultErr(err?.message || '테스트 충전 실패');
                      } finally {
                        setVaultBusy(false);
                      }
                    }}
                    className="w-full rounded-lg border border-outline-variant/20 px-3 py-1.5 text-[11px] text-outline hover:text-on-surface disabled:opacity-40"
                  >
                    스튜디오 테스트 충전 (settlement)
                  </button>
                </div>
                <p className="text-[11px] text-outline leading-relaxed">
                  Phantom은 Devnet으로 맞추세요. USDC는{' '}
                  <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-google-blue underline"
                  >
                    Circle faucet
                  </a>
                  , SOL은{' '}
                  <a
                    href="https://faucet.solana.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-google-blue underline"
                  >
                    Solana faucet
                  </a>
                  .
                </p>
                {payIntents.length > 0 && (
                  <div className="space-y-3 pt-1">
                    {payIntents.map((intent) => (
                      <div
                        key={intent.reference}
                        className="rounded-lg border border-outline-variant/20 bg-surface-container-lowest/80 p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-on-surface uppercase">
                            {intent.kind} · {intent.amount}
                          </span>
                          {intent.phantomUrl && (
                            <a
                              href={intent.phantomUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-google-blue underline"
                            >
                              Phantom에서 열기 <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        {intent.qrDataUrl && (
                          <img
                            src={intent.qrDataUrl}
                            alt={`Solana Pay ${intent.kind}`}
                            className="mx-auto h-[180px] w-[180px] rounded-md bg-white p-2"
                          />
                        )}
                        <p className="break-all font-mono text-[10px] text-outline">{intent.url}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {vaultMsg && (
              <p className="text-xs text-solana-green break-all whitespace-pre-wrap">{vaultMsg}</p>
            )}
            {vaultErr && (
              <p className="text-xs text-red-400 break-all whitespace-pre-wrap">{vaultErr}</p>
            )}
          </section>

          <section className="glass-panel rounded-xl p-5">
            <h2 className="mb-4 text-sm font-semibold tracking-wider text-outline uppercase">
              Discovery URLs
            </h2>
            <div className="space-y-3">
              {pageUrl ? (
                <Row
                  label="HTML page"
                  value={pageUrl}
                  copied={copied === 'page'}
                  onCopy={() => copy(pageUrl, 'page')}
                  href={pageUrl}
                />
              ) : null}
              {apiUrl ? (
                <Row
                  label="JSON API"
                  value={apiUrl}
                  copied={copied === 'api'}
                  onCopy={() => copy(apiUrl, 'api')}
                  href={apiUrl}
                />
              ) : null}
              {cardUrl ? (
                <Row
                  label="A2A Agent Card"
                  value={cardUrl}
                  copied={copied === 'card'}
                  onCopy={() => copy(cardUrl, 'card')}
                  href={cardUrl}
                />
              ) : null}
              {invokeUrl ? (
                <Row
                  label="Invoke URL"
                  value={invokeUrl}
                  copied={copied === 'invoke'}
                  onCopy={() => copy(invokeUrl, 'invoke')}
                />
              ) : (
                <p className="text-sm text-on-surface-variant">
                  카탈로그 invoke URL이 아직 없습니다. 편집에서 저장·재게시해 보세요.
                </p>
              )}
            </div>
            {marketplaceUrl ? (
              <a
                href={pageUrl || marketplaceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-solana-green hover:underline"
              >
                마켓플레이스에서 보기 <ExternalLink className="h-4 w-4" />
              </a>
            ) : null}
          </section>

          {invokeUrl ? (
            <section className="glass-panel rounded-xl p-5">
              <h2 className="mb-3 text-sm font-semibold tracking-wider text-outline uppercase">
                Call example
              </h2>
              <div className="flex items-start gap-2">
                <code className="flex-1 break-all rounded-lg border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface">
                  {callExample}
                </code>
                <button
                  type="button"
                  onClick={() => copy(callExample, 'example')}
                  className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue"
                >
                  {copied === 'example' ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <AgentTestChat
          agent={agent}
          messages={messages}
          inputText={inputText}
          setInputText={setInputText}
          onSendMessage={onSendMessage}
          pendingPayment={pendingPayment}
          paymentLogs={paymentLogs}
          onAcknowledgeAndSign={onAcknowledgeAndSign}
          chatScrollRef={chatScrollRef}
          onToggleA2APeers={onToggleA2APeers}
          chatAttachments={chatAttachments}
          onChatAttachmentsChange={onChatAttachmentsChange}
          enableWebSearch={enableWebSearch}
          setEnableWebSearch={setEnableWebSearch}
          paymentNetwork={paymentNetwork}
          compact
          primaryWalletAddress={primaryWalletAddress}
          primaryWalletLabel={primaryWalletLabel}
          copiedId={copiedId}
          onCopy={onCopy}
          vaultBalance={vaultBalance}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'inline-flex items-center gap-2 border-b-2 border-google-blue px-4 py-2.5 text-sm font-semibold text-google-blue'
          : 'inline-flex items-center gap-2 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-on-surface-variant hover:text-on-surface'
      }
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-outline-variant/15 bg-surface-container-lowest/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-outline">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-on-surface">{value}</p>
    </div>
  );
}

function Row({
  label,
  value,
  copied,
  onCopy,
  href,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  href?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-outline">{label}</p>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block break-all font-mono text-xs text-google-blue hover:underline"
          >
            {value}
          </a>
        ) : (
          <code className="mt-0.5 block break-all font-mono text-xs text-on-surface">{value}</code>
        )}
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue"
        title="복사"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md bg-surface-container-high p-2 text-on-surface-variant hover:text-on-surface"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </div>
  );
}
