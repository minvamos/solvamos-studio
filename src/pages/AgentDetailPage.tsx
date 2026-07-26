/**
 * My-agent detail: catalog-style overview + owner-test chat tabs.
 */
import {
  FormEvent,
  RefObject,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Bot,
  Check,
  Copy,
  ExternalLink,
  MessageSquare,
  Pencil,
} from 'lucide-react';
import type { Agent, ChatAttachment, Message } from '../types';
import AgentTestChat from '../components/AgentTestChat';

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
}: Props) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [copied, setCopied] = useState<string | null>(null);
  const [vaultBalance, setVaultBalance] = useState<{
    sol: number | null;
    usdc: number | null;
  } | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [agent.id, initialTab]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/${encodeURIComponent(agent.id)}/balance`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return;
        setVaultBalance({
          sol: typeof json.currentSolBalance === 'number' ? json.currentSolBalance : null,
          usdc: typeof json.currentUsdcBalance === 'number' ? json.currentUsdcBalance : null,
        });
      })
      .catch(() => {
        if (!cancelled) setVaultBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

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
              톤 {agent.tone} · 보안 {agent.securityLevel}
              {agent.runtimeMode !== 'autonomous' && agent.aiAppType
                ? ` · 앱 ${agent.aiAppType}`
                : ''}
              {agent.dataSourceType ? ` · 소스 ${agent.dataSourceType}` : ''}
            </p>
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
