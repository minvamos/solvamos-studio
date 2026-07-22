/**
 * Stitch: agent_studio_sidebar_layout_2 + dashboard builder content
 */
import { FormEvent, RefObject } from 'react';
import {
  Plus,
  Shield,
  Rocket,
  FlaskConical,
  Send,
  Copy,
  Check,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { Agent, DriveItem, DrivePathCrumb, Message, PromptOptions } from '../types';
import DriveBrowser from '../components/DriveBrowser';

const ROLES: { id: PromptOptions['role']; label: string }[] = [
  { id: 'custom', label: '🏢 사내 HR/복지 안내' },
  { id: 'support', label: '🛍️ 고객지원/CS' },
  { id: 'academic', label: '🔧 기술 지원/가이드' },
  { id: 'weather', label: '🌤️ 날씨/정보' },
];

const TONES: { id: PromptOptions['tone']; label: string }[] = [
  { id: 'casual', label: '😊 친절하고 정중하게' },
  { id: 'professional', label: '🎯 명확하고 간결하게' },
  { id: 'academic', label: '📊 전문적이고 정량적으로' },
  { id: 'cyberpunk', label: '⚡ 사이버펑크' },
];

type PendingPayment = {
  agentId: string;
  amount: number;
  token: string;
  recipientWallet: string;
  prompt: string;
  network?: string;
  paymentNetwork?: string;
} | null;

type Props = {
  options: PromptOptions;
  setOptions: (next: PromptOptions | ((prev: PromptOptions) => PromptOptions)) => void;
  agentName: string;
  setAgentName: (v: string) => void;
  livePromptPreview: string;
  isLoading: boolean;
  builderStep: 1 | 2 | 3;
  creationResult: any;
  editingAgentId?: string | null;
  onCreate: () => void;
  onStartNewAgent?: () => void;
  driveEmail: string | null;
  primaryWalletAddress?: string | null;
  primaryWalletLabel?: string | null;
  driveItems: DriveItem[];
  drivePath: DrivePathCrumb[];
  selectedFolderId: string;
  selectedDriveName?: string | null;
  selectedDriveKind?: 'folder' | 'file' | null;
  setSelectedFolderId: (id: string) => void;
  driveBusy: boolean;
  driveError?: string | null;
  onConnectDrive: () => void;
  onRefreshDrive?: () => void;
  onNavigateDrive: (folderId: string, folderName: string) => void;
  onNavigateDriveCrumb: (index: number) => void;
  onSelectDriveItem: (item: DriveItem) => void;
  tenantIdInput: string;
  setTenantIdInput: (v: string) => void;
  activeAgent: Agent | null;
  chatHistory: Record<string, Message[]>;
  inputText: string;
  setInputText: (v: string) => void;
  onSendMessage: (e: FormEvent) => void;
  pendingPayment: PendingPayment;
  paymentLogs: string[];
  isVerifyingPayment: boolean;
  customSignature: string;
  setCustomSignature: (v: string) => void;
  onAcknowledgeAndSign: (useRandomSig?: boolean) => void;
  bottomRef: RefObject<HTMLDivElement | null>;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
  serverStatus: any;
};

export default function StudioPage(props: Props) {
  const {
    options,
    setOptions,
    agentName,
    setAgentName,
    isLoading,
    builderStep,
    creationResult,
    editingAgentId,
    onCreate,
    onStartNewAgent,
    driveEmail,
    primaryWalletAddress,
    primaryWalletLabel,
    driveItems,
    drivePath,
    selectedFolderId,
    selectedDriveName,
    selectedDriveKind,
    driveBusy,
    driveError,
    onConnectDrive,
    onRefreshDrive,
    onNavigateDrive,
    onNavigateDriveCrumb,
    onSelectDriveItem,
    tenantIdInput,
    setTenantIdInput,
    activeAgent,
    chatHistory,
    inputText,
    setInputText,
    onSendMessage,
    pendingPayment,
    paymentLogs,
    isVerifyingPayment,
    customSignature,
    setCustomSignature,
    onAcknowledgeAndSign,
    bottomRef,
    copiedId,
    onCopy,
    serverStatus,
  } = props;

  const messages = activeAgent ? chatHistory[activeAgent.id] || [] : [];
  const fee = options.fee ?? 0.001;
  const myWalletShort = primaryWalletAddress
    ? `${primaryWalletAddress.slice(0, 4)}...${primaryWalletAddress.slice(-4)}`
    : null;
  const agentVaultShort = activeAgent?.publicKey
    ? `${activeAgent.publicKey.slice(0, 4)}...${activeAgent.publicKey.slice(-4)}`
    : null;

  return (
    <div className="flex flex-col lg:flex-row gap-gutter">
      <div className="flex-grow flex flex-col gap-6 lg:w-[65%] xl:w-[70%]">
        <div className="mb-2">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-on-surface">
            에이전트 스튜디오
          </h1>
          <p className="text-lg text-on-surface-variant mt-2">
            새로운 AI 에이전트를 구성하고 배포하세요.
          </p>
        </div>

        {/* Step 1 */}
        <section className="glass-panel rounded-xl p-6 transition-all duration-300">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-8 w-8 rounded-full bg-solana-green/20 text-solana-green flex items-center justify-center font-bold border border-solana-green/30 text-sm">
              1
            </div>
            <h2 className="text-2xl font-semibold text-on-surface">AI 에이전트 지식 기반 선택</h2>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-on-surface-variant">
            <span>
              Tenant:{' '}
              <input
                value={tenantIdInput}
                onChange={(e) => setTenantIdInput(e.target.value)}
                className="ml-1 bg-surface-container-low border border-outline-variant/30 rounded px-2 py-1 text-on-surface input-glow focus:outline-none"
              />
            </span>
            {driveEmail ? (
              <span className="text-solana-green">Drive: {driveEmail}</span>
            ) : (
              <span className="text-outline">Drive 미연결</span>
            )}
            {primaryWalletAddress ? (
              <span className="text-solana-green font-mono text-xs">
                유저 지갑(운영): {primaryWalletLabel || '메인'} · {primaryWalletAddress.slice(0, 4)}…
                {primaryWalletAddress.slice(-4)}
              </span>
            ) : (
              <span className="text-outline text-xs">
                유저 지갑 미연결 — 에이전트 볼트와는 별개 (헤더 Connect Wallet)
              </span>
            )}
          </div>

          <div className="mb-4">
            {driveEmail ? (
              <DriveBrowser
                items={driveItems}
                path={drivePath}
                selectedId={selectedFolderId}
                selectedName={selectedDriveName}
                selectedKind={selectedDriveKind}
                busy={driveBusy}
                error={driveError}
                onNavigate={onNavigateDrive}
                onNavigateCrumb={onNavigateDriveCrumb}
                onSelect={onSelectDriveItem}
                emptyHint="이 위치에 폴더/파일이 없습니다. 상위 폴더로 이동하거나 Drive에서 항목을 추가하세요."
              />
            ) : (
              <p className="text-sm text-on-surface-variant py-2">
                Google Drive를 연결하면 폴더·파일을 탐색하고 지식 기반으로 선택할 수 있습니다.
                없이도 에이전트 생성은 가능합니다.
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={driveBusy}
            onClick={driveEmail && onRefreshDrive ? onRefreshDrive : onConnectDrive}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-lg border border-google-blue text-google-blue hover:bg-google-blue/10 transition-colors text-sm font-medium disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {driveEmail ? '현재 폴더 새로고침' : 'Google Drive 연결하기'}
          </button>
        </section>

        {/* Step 2 */}
        <section className="glass-panel rounded-xl p-6 transition-all duration-300">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-8 w-8 rounded-full bg-solana-green/20 text-solana-green flex items-center justify-center font-bold border border-solana-green/30 text-sm">
              2
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-on-surface">
                에이전트 역할 및 응답 스타일 설정
              </h2>
              <p className="text-sm text-on-surface-variant mt-1">
                프롬프트 작성 없이 버튼 클릭만으로 에이전트의 성격을 지정하세요.
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-2">
                에이전트 이름
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => {
                  setAgentName(e.target.value);
                  setOptions((prev) => ({
                    ...prev,
                    customRole: e.target.value || undefined,
                    role: prev.role === 'support' && e.target.value ? 'custom' : prev.role,
                  }));
                }}
                placeholder="사내 복지 안내 AI 비서"
                className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-2 text-on-surface input-glow focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-on-surface-variant">
                [에이전트 주요 역할]
              </label>
              <div className="flex flex-wrap gap-2">
                {ROLES.map((r) => {
                  const active = options.role === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() =>
                        setOptions((prev) => ({
                          ...prev,
                          role: r.id,
                          customRole:
                            r.id === 'custom'
                              ? agentName || prev.customRole || '사내 HR/복지 안내'
                              : prev.customRole,
                        }))
                      }
                      className={
                        active
                          ? 'px-4 py-2 rounded-lg border border-google-blue bg-google-blue/10 text-google-blue text-sm font-medium'
                          : 'px-4 py-2 rounded-lg border border-outline-variant/30 bg-surface-container-low text-on-surface-variant hover:border-outline-variant/50 transition-colors text-sm font-medium'
                      }
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-on-surface-variant">
                [답변 톤앤매너]
              </label>
              <div className="flex flex-wrap gap-2">
                {TONES.map((t) => {
                  const active = options.tone === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setOptions((prev) => ({ ...prev, tone: t.id }))}
                      className={
                        active
                          ? 'px-4 py-2 rounded-lg border border-google-blue bg-google-blue/10 text-google-blue text-sm font-medium'
                          : 'px-4 py-2 rounded-lg border border-outline-variant/30 bg-surface-container-low text-on-surface-variant hover:border-outline-variant/50 transition-colors text-sm font-medium'
                      }
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="bg-surface-container p-4 rounded-lg border border-outline-variant/10">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium text-on-surface">호출 당 청구 단가</label>
                <span className="text-sm font-bold text-secondary">
                  {fee === 0 ? 'Free' : `$${fee.toFixed(3)} USDC / 회`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={fee}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, fee: Number(e.target.value) }))
                }
                className="w-full mt-2 accent-google-blue"
              />
            </div>

            <div className="flex items-center gap-2 text-on-surface-variant bg-[#1E293B]/50 p-2 rounded-lg border border-outline-variant/10">
              <Shield className="w-4 h-4 shrink-0" />
              <span className="text-xs font-semibold">
                백엔드가 A2A 보안 규격 프롬프트를 자동으로 조립하여 주입합니다. (
                {options.securityLevel})
              </span>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="mt-2">
          {editingAgentId ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-google-blue/30 bg-google-blue/10 px-3 py-2">
              <p className="text-xs text-on-surface">
                편집 중 · ID <span className="font-mono">{editingAgentId}</span>
                <span className="text-on-surface-variant"> (vault/ID 유지, 재게시 아님)</span>
              </p>
              {onStartNewAgent ? (
                <button
                  type="button"
                  onClick={onStartNewAgent}
                  className="shrink-0 text-xs font-medium text-google-blue hover:underline"
                >
                  새 에이전트
                </button>
              ) : null}
            </div>
          ) : null}
          {builderStep === 3 && creationResult?.agent ? (
            <div className="glass-panel rounded-xl p-6 mb-4 border border-solana-green/30">
              <p className="text-solana-green font-semibold mb-2">
                {creationResult._wasEdit || creationResult.message?.includes('updated')
                  ? '에이전트 저장 완료 (기존 ID 유지)'
                  : '에이전트 생성 완료'}
              </p>
              <p className="text-sm text-on-surface-variant font-mono break-all">
                ID: {creationResult.agent.id}
              </p>
              <p className="text-sm text-on-surface-variant font-mono break-all mt-1">
                Vault: {creationResult.agent.publicKey}
              </p>
              {creationResult.driveIngest?.docs != null ? (
                <p className="text-sm text-on-surface-variant mt-2">
                  Drive RAG: {creationResult.driveIngest.docs}개 문서 주입
                </p>
              ) : null}
              {creationResult.payShCatalog?.invokeUrl ? (
                <p className="text-xs text-on-surface-variant font-mono break-all mt-1">
                  pay.sh: {creationResult.payShCatalog.invokeUrl}
                </p>
              ) : null}
              {Array.isArray(creationResult.pipeline) ? (
                <ul className="mt-3 space-y-1 text-xs text-on-surface-variant">
                  {creationResult.pipeline.map((p: any, i: number) => (
                    <li key={`${p.step}-${i}`}>
                      [{p.status}] {p.step}: {p.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            disabled={isLoading}
            onClick={onCreate}
            className="w-full bg-gradient-to-r from-google-blue to-solana-green text-surface-container-lowest font-semibold text-xl md:text-2xl py-5 rounded-xl flex items-center justify-center gap-4 hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {isLoading ? (
              <RefreshCw className="w-7 h-7 animate-spin" />
            ) : (
              <Rocket className="w-7 h-7" />
            )}
            {isLoading
              ? editingAgentId
                ? '저장 중…'
                : '컴파일 중…'
              : editingAgentId
                ? '변경사항 저장 (재게시 아님)'
                : '에이전트 생성 및 pay.sh 카탈로그 게시하기'}
          </button>
          {editingAgentId ? (
            <p className="text-xs text-on-surface-variant mt-2 text-center">
              같은 에이전트 메타/요금만 업데이트합니다. 새 vault·새 ID를 만들지 않습니다.
            </p>
          ) : null}
        </section>
      </div>

      {/* Sandbox */}
      <div className="flex flex-col gap-6 h-full lg:w-[35%] xl:w-[30%]">
        <section className="glass-panel rounded-xl flex flex-col h-full border border-outline-variant/20 overflow-hidden relative min-h-[480px]">
          <div className="p-4 border-b border-outline-variant/20 bg-surface-container-high/50 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-on-surface text-lg">에이전트 실시간 테스트</h3>
            </div>
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
            </span>
          </div>

          <div className="flex-1 p-4 flex flex-col gap-3 overflow-y-auto min-h-[320px] max-h-[420px]">
            {!activeAgent && (
              <p className="text-sm text-on-surface-variant text-center py-8">
                에이전트를 생성하면 여기서 바로 테스트할 수 있습니다.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={m.sender === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div
                  className={
                    m.sender === 'user'
                      ? 'bg-google-blue text-white px-4 py-2 rounded-2xl rounded-tr-sm max-w-[85%] text-sm shadow-lg shadow-google-blue/20 whitespace-pre-wrap'
                      : m.sender === 'system'
                        ? 'bg-surface-container-highest/60 text-on-surface-variant px-4 py-2 rounded-2xl max-w-[90%] text-sm border border-outline-variant/20 whitespace-pre-wrap'
                        : 'bg-surface-container-high text-on-surface px-4 py-2 rounded-2xl rounded-tl-sm max-w-[90%] text-sm border border-outline-variant/20 whitespace-pre-wrap'
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {pendingPayment && (
            <div className="mx-4 mb-2 p-3 rounded-lg bg-google-blue/10 border border-google-blue/30 text-sm space-y-2">
              <div className="flex items-center gap-2 text-google-blue font-medium">
                <Lock className="w-4 h-4" />
                pay.sh 결제 필요 · {pendingPayment.amount} {pendingPayment.token}
              </div>
              <p className="text-[11px] text-on-surface-variant">
                모드:{' '}
                <span className="text-on-surface font-medium">
                  {serverStatus?.paymentNetwork === 'devnet'
                    ? 'Devnet (제품)'
                    : serverStatus?.paymentNetwork === 'sandbox'
                      ? 'Sandbox (테스트)'
                      : serverStatus?.paymentNetwork || '—'}
                </span>
                {' · '}vault{' '}
                <span className="font-mono text-[10px]">
                  {pendingPayment.recipientWallet.slice(0, 8)}…
                </span>
              </p>
              {serverStatus?.paymentNetwork === 'devnet' && (
                <p className="text-[11px] text-amber-300/90 leading-relaxed">
                  Devnet: 에이전트 vault(+ 플랫폼 10% treasury)로 USDC를 보낸 뒤 트랜잭션
                  서명을 붙여넣으세요. Sandbox 버튼은 이 모드에서 거부됩니다.
                </p>
              )}
              <input
                value={customSignature}
                onChange={(e) => setCustomSignature(e.target.value)}
                placeholder={
                  serverStatus?.paymentNetwork === 'devnet'
                    ? 'Devnet USDC tx signature 붙여넣기'
                    : '온체인 서명 붙여넣기 (선택)'
                }
                className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-lg px-3 py-1.5 text-xs font-mono input-glow focus:outline-none"
              />
              <div className="flex gap-2">
                {(serverStatus?.paymentNetwork === 'sandbox' ||
                  serverStatus?.sandboxProofsAllowed) && (
                  <button
                    type="button"
                    disabled={isVerifyingPayment}
                    onClick={() => onAcknowledgeAndSign(true)}
                    className="flex-1 btn-primary rounded-lg py-2 text-xs font-medium disabled:opacity-50"
                  >
                    Sandbox 증명 전송
                  </button>
                )}
                <button
                  type="button"
                  disabled={isVerifyingPayment || !customSignature.trim()}
                  onClick={() => onAcknowledgeAndSign(false)}
                  className={
                    serverStatus?.paymentNetwork === 'devnet'
                      ? 'flex-1 btn-primary rounded-lg py-2 text-xs font-medium disabled:opacity-50'
                      : 'flex-1 border border-google-blue text-google-blue rounded-lg py-2 text-xs font-medium hover:bg-google-blue/10 disabled:opacity-50'
                  }
                >
                  {serverStatus?.paymentNetwork === 'devnet'
                    ? 'Devnet 서명으로 결제'
                    : '서명으로 전송'}
                </button>
              </div>
              {paymentLogs.length > 0 && (
                <pre className="text-[10px] text-on-surface-variant overflow-x-auto whitespace-pre-wrap">
                  {paymentLogs.join('\n')}
                </pre>
              )}
            </div>
          )}

          <form
            onSubmit={onSendMessage}
            className="p-4 border-t border-outline-variant/20 bg-surface-container/50"
          >
            <div className="relative">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={!activeAgent}
                placeholder={activeAgent ? '메시지 입력...' : '에이전트 생성 후 입력'}
                className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-full pl-4 pr-12 py-2.5 text-on-surface text-sm focus:outline-none input-glow disabled:text-on-surface-variant disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={!activeAgent || !inputText.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-google-blue text-white flex items-center justify-center disabled:bg-surface-container-highest disabled:text-on-surface-variant"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>
        </section>

                <section className="glass-panel rounded-xl p-4 border border-outline-variant/20">
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center gap-2">
              <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                내 지갑
              </span>
              {myWalletShort && primaryWalletAddress ? (
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
                <span className="text-xs text-outline">미연결 (헤더 Connect Wallet)</span>
              )}
            </div>
            {activeAgent && agentVaultShort && (
              <>
                <div className="h-px w-full bg-outline-variant/20" />
                <div className="flex justify-between items-center gap-2">
                  <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                    에이전트 A2A vault
                  </span>
                  <button
                    type="button"
                    onClick={() => onCopy(activeAgent.publicKey, 'agent-vault')}
                    className="flex items-center gap-1 bg-surface-container-highest px-2 py-1 rounded-md text-xs font-mono text-on-surface-variant"
                    title="에이전트 간 결제용 주소 (생성 시 기본 vault)"
                  >
                    {agentVaultShort}
                    {copiedId === 'agent-vault' ? (
                      <Check className="w-3 h-3 text-solana-green" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </>
            )}
            <div className="h-px w-full bg-outline-variant/20" />
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                상태
              </span>
              <span className="text-xs text-secondary">
                {serverStatus?.paymentNetwork || '—'} ·{' '}
                {serverStatus?.geminiConfigured ? 'Gemini OK' : 'Gemini unset'}
              </span>
            </div>
            <div className="h-px w-full bg-outline-variant/20" />
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                pay.sh catalog
              </span>
              <span className="text-xs text-primary">
                {serverStatus?.payShCatalogListings ?? '—'} listed · A2A{' '}
                {serverStatus?.a2aEnabled ? 'on' : 'off'}
              </span>
            </div>
            <p className="text-[11px] text-on-surface-variant leading-relaxed mt-1">
              사람→에이전트 대화 중, 필요하면 pay.sh 카탈로그에 등재된 다른 에이전트를 USDC로
              유료 호출해 정보를 가져옵니다.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
