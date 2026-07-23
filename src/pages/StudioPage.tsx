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
import { Agent, DriveItem, DrivePathCrumb, Message, PromptOptions, LocalUploadFile } from '../types';
import DriveBrowser from '../components/DriveBrowser';

const AI_APP_TYPES: {
  id: NonNullable<PromptOptions['aiAppType']>;
  label: string;
  hint: string;
}[] = [
  { id: 'search_docs', label: '문서 검색', hint: 'PDF·Docs·텍스트 RAG' },
  { id: 'chat_rag', label: '대화형 RAG', hint: 'Chat 앱 + 문서 근거' },
  { id: 'website', label: '웹사이트', hint: '공개 URL 인덱싱' },
  { id: 'structured', label: '구조화 데이터', hint: 'JSON/BQ/표형' },
  { id: 'media', label: '미디어', hint: '이미지·미디어 검색' },
];

const DATA_SOURCES: {
  id: NonNullable<PromptOptions['dataSourceType']>;
  label: string;
  hint: string;
  forApps: NonNullable<PromptOptions['aiAppType']>[];
}[] = [
  {
    id: 'local_upload',
    label: '로컬 파일 첨부',
    hint: 'PC에서 업로드 · GCP 불필요',
    forApps: ['search_docs', 'chat_rag', 'website', 'structured', 'media'],
  },
  {
    id: 'google_drive',
    label: 'Google Drive',
    hint: '폴더/파일 수집',
    forApps: ['search_docs', 'chat_rag', 'media'],
  },
  {
    id: 'website_url',
    label: '웹사이트 URL',
    hint: '공개 사이트 인덱싱',
    forApps: ['website', 'search_docs'],
  },
  {
    id: 'none',
    label: '지식 없이 시작',
    hint: '나중에 파일 추가',
    forApps: ['search_docs', 'chat_rag', 'website', 'structured', 'media'],
  },
];

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
  localFiles: LocalUploadFile[];
  onLocalFilesChange: (files: LocalUploadFile[]) => void;
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
  enableA2A?: boolean;
  setEnableA2A?: (v: boolean) => void;
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
    localFiles,
    onLocalFilesChange,
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
    enableA2A,
    setEnableA2A,
  } = props;

  const messages = activeAgent ? chatHistory[activeAgent.id] || [] : [];
  const fee = options.fee ?? 0;
  const appType = options.aiAppType || 'search_docs';
  const sourceType = options.dataSourceType || 'local_upload';
  const sourceChoices = DATA_SOURCES.filter((s) => s.forApps.includes(appType));
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
            <div className="h-8 w-8 rounded-full bg-google-blue/20 text-google-blue flex items-center justify-center font-bold border border-google-blue/30 text-sm">
              1
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-on-surface">
                AI Applications 앱 · 데이터 소스
              </h2>
              <p className="text-sm text-on-surface-variant mt-1">
                GCP AI Applications에 앱+데이터스토어를 만들고, RAG에 맞는 소스를 고릅니다.
                (location: global)
              </p>
            </div>
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
            {primaryWalletAddress ? (
              <span className="text-solana-green font-mono text-xs">
                유저 지갑(운영): {primaryWalletLabel || '메인'} · {primaryWalletAddress.slice(0, 4)}…
                {primaryWalletAddress.slice(-4)}
              </span>
            ) : null}
          </div>

          <div className="mb-5">
            <p className="text-sm font-medium text-on-surface-variant mb-2">앱 유형</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {AI_APP_TYPES.map((t) => {
                const active = appType === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      const nextSources = DATA_SOURCES.filter((s) => s.forApps.includes(t.id));
                      const keep = nextSources.some((s) => s.id === sourceType);
                      setOptions((prev) => ({
                        ...prev,
                        aiAppType: t.id,
                        dataSourceType: keep ? prev.dataSourceType : nextSources[0]?.id || 'none',
                      }));
                    }}
                    className={
                      active
                        ? 'text-left px-4 py-3 rounded-lg border border-google-blue bg-google-blue/10'
                        : 'text-left px-4 py-3 rounded-lg border border-outline-variant/30 bg-surface-container-low hover:border-outline-variant/50'
                    }
                  >
                    <p className="text-sm font-semibold text-on-surface">{t.label}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{t.hint}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-5">
            <p className="text-sm font-medium text-on-surface-variant mb-2">데이터 소스</p>
            <div className="flex flex-wrap gap-2">
              {sourceChoices.map((s) => {
                const active = sourceType === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setOptions((prev) => ({ ...prev, dataSourceType: s.id }))}
                    className={
                      active
                        ? 'px-3 py-2 rounded-lg border border-solana-green bg-solana-green/10 text-sm'
                        : 'px-3 py-2 rounded-lg border border-outline-variant/30 text-sm text-on-surface-variant'
                    }
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {sourceType === 'website_url' ? (
            <div className="mb-4">
              <label className="block text-sm font-medium text-on-surface-variant mb-2">
                웹사이트 URL
              </label>
              <input
                type="url"
                value={options.websiteUri || ''}
                onChange={(e) => setOptions((prev) => ({ ...prev, websiteUri: e.target.value }))}
                placeholder="https://docs.example.com"
                className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-2 text-on-surface"
              />
            </div>
          ) : null}

          {sourceType === 'local_upload' ? (
            <div className="mb-4">
              <label className="block text-sm font-medium text-on-surface-variant mb-2">
                RAG 문서 첨부 (txt / md / json / csv / html / pdf)
              </label>
              <input
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.csv,.tsv,.log,.html,.htm,.xml,.yml,.yaml,.pdf,text/*,application/json,application/pdf"
                onChange={async (e) => {
                  const list = e.target.files;
                  if (!list?.length) return;
                  const next: LocalUploadFile[] = [];
                  const toBase64 = async (file: File): Promise<string> => {
                    const buf = await file.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    let binary = '';
                    const chunk = 0x8000;
                    for (let i = 0; i < bytes.length; i += chunk) {
                      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
                    }
                    return btoa(binary);
                  };
                  for (const file of Array.from(list).slice(0, 25) as File[]) {
                    try {
                      const isPdf =
                        file.type === 'application/pdf' ||
                        file.name.toLowerCase().endsWith('.pdf');
                      if (isPdf) {
                        if (file.size > 8_000_000) continue;
                        next.push({
                          name: file.name,
                          mimeType: 'application/pdf',
                          contentBase64: await toBase64(file),
                        });
                      } else {
                        const text = await file.text();
                        next.push({
                          name: file.name,
                          mimeType: file.type || 'text/plain',
                          text: text.slice(0, 12_000),
                        });
                      }
                    } catch {
                      /* skip unreadable */
                    }
                  }
                  onLocalFilesChange([...localFiles, ...next].slice(0, 25));
                  e.target.value = '';
                }}
                className="block w-full text-sm text-on-surface-variant file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-google-blue/15 file:text-google-blue file:font-medium"
              />
              {localFiles.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {localFiles.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center justify-between gap-2 text-sm bg-surface-container-low rounded-lg px-3 py-2"
                    >
                      <span className="truncate text-on-surface">
                        {f.name}
                        <span className="text-xs text-on-surface-variant ml-2">
                          {f.contentBase64
                            ? 'PDF → AI Applications'
                            : `${(f.text?.length || 0).toLocaleString()}자`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="text-xs text-outline hover:text-on-surface shrink-0"
                        onClick={() =>
                          onLocalFilesChange(localFiles.filter((_, idx) => idx !== i))
                        }
                      >
                        제거
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-on-surface-variant mt-2">
                  파일을 올리면 SolVamos가 AI Applications 데이터스토어에 넣습니다. PDF는 Google이
                  파싱합니다 (최대 8MB/파일). GCP 콘솔 작업은 필요 없습니다.
                </p>
              )}
            </div>
          ) : null}

          {sourceType === 'none' && (
            <p className="text-xs text-on-surface-variant mb-4">
              앱과 빈 데이터스토어만 만듭니다. 나중에 로컬 파일 추가로 지식을 넣을 수 있습니다.
            </p>
          )}

          {sourceType === 'google_drive' ? (
            <>
              <div className="flex flex-wrap gap-3 text-sm mb-4">
                {driveEmail ? (
                  <span className="text-solana-green">Drive: {driveEmail}</span>
                ) : (
                  <span className="text-outline">Drive 미연결</span>
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
                    emptyHint="이 위치에 폴더/파일이 없습니다."
                  />
                ) : (
                  <p className="text-sm text-on-surface-variant py-2">
                    Google Drive를 연결한 뒤 폴더·파일을 선택하세요.
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
            </>
          ) : null}
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
          <div className="p-4 border-b border-outline-variant/20 bg-surface-container-high/50 flex justify-between items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-primary" />
              <h3 className="font-semibold text-on-surface text-lg">에이전트 실시간 테스트</h3>
            </div>
            <div className="flex items-center gap-3">
              {setEnableA2A ? (
                <label className="flex items-center gap-2 text-xs text-on-surface-variant cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!enableA2A}
                    onChange={(e) => setEnableA2A(e.target.checked)}
                    className="accent-google-blue"
                  />
                  A2A 피어 호출
                  <span className="text-[10px] text-outline">
                    ({serverStatus?.paymentNetwork || 'localnet'})
                  </span>
                </label>
              ) : null}
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
              </span>
            </div>
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
                    ? 'Devnet (pay.sh 온체인)'
                    : 'Localnet (pay.sh sandbox)'}
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
                {(serverStatus?.paymentNetwork === 'localnet' ||
                  serverStatus?.paymentNetwork === 'sandbox' ||
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
