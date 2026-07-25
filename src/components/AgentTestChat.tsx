/**
 * Owner-test chat (formerly Studio sidebar sandbox).
 * Studio session skips paywall; A2A peers still bill the agent vault.
 */
import { FormEvent, RefObject } from 'react';
import {
  Check,
  Copy,
  FlaskConical,
  Globe,
  Image as ImageIcon,
  Lock,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import type { Agent, ChatAttachment, Message } from '../types';
import ChatMessageBody from './ChatMessageBody';

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
  messages: Message[];
  inputText: string;
  setInputText: (v: string) => void;
  onSendMessage: (e: FormEvent) => void;
  pendingPayment: PendingPayment;
  paymentLogs: string[];
  onAcknowledgeAndSign: (useRandomSig?: boolean) => void;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  enableA2A?: boolean;
  setEnableA2A?: (v: boolean) => void;
  chatAttachments?: ChatAttachment[];
  onChatAttachmentsChange?: (files: ChatAttachment[]) => void;
  enableWebSearch?: boolean;
  setEnableWebSearch?: (v: boolean) => void;
  paymentNetwork?: string;
  /** Compact = fill parent; default = tall panel */
  compact?: boolean;
  primaryWalletAddress?: string | null;
  primaryWalletLabel?: string | null;
  copiedId?: string | null;
  onCopy?: (text: string, id: string) => void;
  vaultBalance?: { sol: number | null; usdc: number | null } | null;
};

export default function AgentTestChat({
  agent,
  messages,
  inputText,
  setInputText,
  onSendMessage,
  pendingPayment,
  paymentLogs,
  onAcknowledgeAndSign,
  chatScrollRef,
  enableA2A,
  setEnableA2A,
  chatAttachments = [],
  onChatAttachmentsChange,
  enableWebSearch = false,
  setEnableWebSearch,
  paymentNetwork,
  compact = false,
  primaryWalletAddress,
  primaryWalletLabel,
  copiedId,
  onCopy,
  vaultBalance,
}: Props) {
  const myWalletShort = primaryWalletAddress
    ? `${primaryWalletAddress.slice(0, 4)}...${primaryWalletAddress.slice(-4)}`
    : null;
  const agentVaultShort = agent.publicKey
    ? `${agent.publicKey.slice(0, 4)}...${agent.publicKey.slice(-4)}`
    : null;

  return (
    <div className={`flex flex-col gap-4 ${compact ? 'h-full min-h-0' : ''}`}>
      <section
        className={`glass-panel rounded-xl flex flex-col border border-outline-variant/20 overflow-hidden relative overflow-anchor-none ${
          compact ? 'flex-1 min-h-[420px]' : 'min-h-[480px]'
        }`}
      >
        <div className="p-4 border-b border-outline-variant/20 bg-surface-container-high/50 flex justify-between items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-on-surface text-lg">에이전트 실시간 테스트</h3>
          </div>
          <div className="flex items-center gap-3">
            {setEnableA2A ? (
              <label
                className="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer select-none"
                title="끄면 내 RAG만. 켜면 카탈로그 피어 호출 — 유료 피어는 agent vault USDC 차감"
              >
                <input
                  type="checkbox"
                  checked={!!enableA2A}
                  onChange={(e) => setEnableA2A(e.target.checked)}
                  className="accent-google-blue"
                />
                A2A 피어
                <span className="text-[10px] text-outline">
                  {enableA2A
                    ? `ON · 피어 과금 가능 (${paymentNetwork || 'devnet'})`
                    : 'OFF · 내 에이전트만'}
                </span>
              </label>
            ) : null}
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
            </span>
          </div>
        </div>

        <div
          ref={chatScrollRef}
          className={`flex-1 p-4 flex flex-col gap-3 overflow-y-auto overflow-anchor-none ${
            compact ? 'min-h-[240px]' : 'min-h-[280px] max-h-[360px]'
          }`}
          style={{ overflowAnchor: 'none' }}
        >
          {messages.length === 0 && (
            <div className="text-sm text-on-surface-variant text-center py-8 px-4 space-y-2">
              <p className="font-medium text-on-surface">소유자 테스트 대화</p>
              <p>
                Studio 세션에서는 결제 없이 호출합니다. A2A를 켜면 카탈로그 피어 호출은 vault에서
                과금됩니다.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={m.sender === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={
                  m.sender === 'user'
                    ? 'bg-google-blue text-white px-4 py-2 rounded-2xl rounded-tr-sm max-w-[85%] text-sm shadow-lg shadow-google-blue/20'
                    : m.sender === 'system'
                      ? 'bg-surface-container-highest/60 text-on-surface-variant px-4 py-2 rounded-2xl max-w-[90%] text-sm border border-outline-variant/20'
                      : 'bg-surface-container-high text-on-surface px-4 py-2 rounded-2xl rounded-tl-sm max-w-[90%] text-sm border border-outline-variant/20'
                }
              >
                {m.attachments && m.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {m.attachments.map((a, i) =>
                      a.previewUrl ? (
                        <img
                          key={`${a.name}-${i}`}
                          src={a.previewUrl}
                          alt={a.name}
                          className="h-14 w-14 rounded object-cover border border-white/20"
                        />
                      ) : (
                        <span
                          key={`${a.name}-${i}`}
                          className="text-[10px] opacity-80 inline-flex items-center gap-1"
                        >
                          <Paperclip className="w-3 h-3" />
                          {a.name}
                        </span>
                      )
                    )}
                  </div>
                )}
                <ChatMessageBody text={m.text} sender={m.sender} />
                {m.relatedQuestions && m.relatedQuestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.relatedQuestions.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setInputText(q)}
                        className="text-[10px] px-2 py-1 rounded-md bg-google-blue/10 text-google-blue border border-google-blue/20 hover:bg-google-blue/20"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {pendingPayment && (
          <div className="mx-4 mb-2 p-3 rounded-lg bg-google-blue/10 border border-google-blue/30 text-sm space-y-2">
            <div className="flex items-center gap-2 text-google-blue font-medium">
              <Lock className="w-4 h-4" />
              pay-gateway 결제 필요 · {pendingPayment.amount} {pendingPayment.token}
            </div>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              유료 호출은 Catalog <code className="text-[10px]">invoke_url</code> → pay-gateway →
              HTTP 402 → USDC 결제 경로를 사용합니다.
            </p>
            {pendingPayment.invokeUrl && (
              <div className="flex gap-2 items-start">
                <code className="flex-1 text-[10px] break-all bg-surface-container-lowest rounded px-2 py-1.5 border border-outline-variant/20">
                  {pendingPayment.invokeUrl}
                </code>
                <button
                  type="button"
                  onClick={() => onAcknowledgeAndSign(false)}
                  className="shrink-0 border border-google-blue text-google-blue rounded-lg px-2 py-1.5 text-xs hover:bg-google-blue/10"
                >
                  URL 복사
                </button>
              </div>
            )}
            {paymentLogs.length > 0 && (
              <pre className="text-[10px] text-on-surface-variant overflow-x-auto whitespace-pre-wrap">
                {paymentLogs.join('\n')}
              </pre>
            )}
          </div>
        )}

        <form
          onSubmit={onSendMessage}
          className="p-4 border-t border-outline-variant/20 bg-surface-container/50 space-y-2"
        >
          {chatAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {chatAttachments.map((f, idx) => (
                <div
                  key={`${f.name}-${idx}`}
                  className="flex items-center gap-1.5 text-[11px] bg-surface-container-highest rounded-lg px-2 py-1 border border-outline-variant/20"
                >
                  {f.previewUrl ? (
                    <img src={f.previewUrl} alt="" className="w-6 h-6 rounded object-cover" />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5 text-on-surface-variant" />
                  )}
                  <span className="max-w-[120px] truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      onChatAttachmentsChange?.(chatAttachments.filter((_, i) => i !== idx))
                    }
                    className="text-on-surface-variant hover:text-on-surface"
                    aria-label="remove attachment"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 text-[11px] text-on-surface-variant">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!enableWebSearch}
                onChange={(e) => setEnableWebSearch?.(e.target.checked)}
                className="accent-google-blue"
              />
              <Globe className="w-3.5 h-3.5" />
              웹 검색
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="file"
                accept="image/*,application/pdf,text/*,.md,.json,.csv"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const list = e.target.files;
                  if (!list?.length || !onChatAttachmentsChange) return;
                  const next: ChatAttachment[] = [...chatAttachments];
                  for (const file of Array.from(list).slice(0, 6)) {
                    if (file.size > 8_000_000) continue;
                    const buf = await file.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    const dataBase64 = btoa(binary);
                    next.push({
                      name: file.name,
                      mimeType: file.type || 'application/octet-stream',
                      dataBase64,
                      previewUrl: file.type.startsWith('image/')
                        ? URL.createObjectURL(file)
                        : undefined,
                    });
                  }
                  onChatAttachmentsChange(next.slice(0, 8));
                  e.target.value = '';
                }}
              />
              <span className="inline-flex items-center gap-1 hover:text-google-blue">
                <ImageIcon className="w-3.5 h-3.5" />
                사진/파일
              </span>
            </label>
          </div>
          <div className="relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onFocus={() => {
                const y = window.scrollY;
                const x = window.scrollX;
                requestAnimationFrame(() => window.scrollTo(x, y));
              }}
              placeholder="메시지 입력… (사진·파일·웹검색 가능)"
              className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-full pl-4 pr-12 py-2.5 text-on-surface text-sm focus:outline-none input-glow"
            />
            <button
              type="submit"
              disabled={!inputText.trim() && chatAttachments.length === 0}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-google-blue text-white flex items-center justify-center disabled:bg-surface-container-highest disabled:text-on-surface-variant"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>
      </section>

      {(primaryWalletAddress || agent.publicKey) && (
        <section className="glass-panel rounded-xl p-4 border border-outline-variant/20">
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center gap-2">
              <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                내 지갑
              </span>
              {myWalletShort && primaryWalletAddress && onCopy ? (
                <button
                  type="button"
                  onClick={() => onCopy(primaryWalletAddress, 'my-wallet')}
                  className="flex items-center gap-1 bg-surface-container-highest px-2 py-1 rounded-md text-xs font-mono text-on-surface"
                >
                  <span className="h-2 w-2 rounded-full bg-solana-green" />
                  {primaryWalletLabel ? `${primaryWalletLabel} · ` : ''}
                  {myWalletShort}
                  {copiedId === 'my-wallet' ? (
                    <Check className="w-3 h-3 text-solana-green" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              ) : (
                <span className="text-xs text-outline">미연결</span>
              )}
            </div>
            {agentVaultShort && (
              <>
                <div className="h-px w-full bg-outline-variant/20" />
                <div className="flex justify-between items-center gap-2">
                  <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                    에이전트 vault
                  </span>
                  {onCopy ? (
                    <button
                      type="button"
                      onClick={() => onCopy(agent.publicKey, 'agent-vault')}
                      className="flex items-center gap-1 bg-surface-container-highest px-2 py-1 rounded-md text-xs font-mono text-on-surface-variant"
                    >
                      {agentVaultShort}
                      {copiedId === 'agent-vault' ? (
                        <Check className="w-3 h-3 text-solana-green" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  ) : (
                    <span className="text-xs font-mono text-on-surface-variant">{agentVaultShort}</span>
                  )}
                </div>
                {vaultBalance && (
                  <p className="text-xs text-on-surface-variant">
                    잔고{' '}
                    {vaultBalance.sol != null ? vaultBalance.sol.toFixed(4) : '—'} SOL ·{' '}
                    {vaultBalance.usdc != null ? vaultBalance.usdc.toFixed(4) : '—'} USDC
                  </p>
                )}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
