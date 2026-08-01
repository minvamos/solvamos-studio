/**
 * Stitch: agent_studio_sidebar_layout_2 + dashboard builder content
 */
import { useEffect, useState } from 'react';
import {
  Plus,
  Shield,
  Rocket,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Bot,
  List,
  ArrowLeft,
} from 'lucide-react';
import { Agent, DriveItem, DrivePathCrumb, PromptOptions, LocalUploadFile } from '../types';
import DriveBrowser from '../components/DriveBrowser';

const AI_APP_TYPES: {
  id: NonNullable<PromptOptions['aiAppType']>;
  label: string;
  hint: string;
}[] = [
  { id: 'search_docs', label: '문서 검색', hint: 'PDF·Docs·텍스트 RAG' },
  { id: 'chat_rag', label: '대화형 RAG', hint: 'Search+Answer 자연어 Q&A' },
  { id: 'website', label: '웹사이트', hint: '공개 URL 인덱싱' },
  { id: 'structured', label: '구조화 데이터', hint: 'JSON/BQ/표형' },
  { id: 'media', label: '미디어', hint: '이미지·미디어 검색' },
];

const ROLE_PRESETS: {
  id: PromptOptions['role'];
  label: string;
  fill: string;
}[] = [
  { id: 'custom', label: '사내 HR/복지 안내', fill: '사내 HR/복지 안내' },
  { id: 'support', label: '고객지원/CS', fill: '고객지원 및 CS 응대' },
  { id: 'academic', label: '기술 지원/가이드', fill: '기술 지원 및 사용 가이드' },
  { id: 'weather', label: '날씨/정보', fill: '날씨 및 환경 정보 안내' },
];

const TONE_PRESETS: { id: string; label: string }[] = [
  { id: 'casual', label: '친절하고 정중하게' },
  { id: 'professional', label: '명확하고 간결하게' },
  { id: 'academic', label: '전문적이고 정량적으로' },
  { id: 'cyberpunk', label: '사이버펑크' },
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

type Props = {
  /** landing = hub; builder = create/edit form */
  studioView: 'landing' | 'builder';
  agentCount?: number;
  options: PromptOptions;
  setOptions: (next: PromptOptions | ((prev: PromptOptions) => PromptOptions)) => void;
  agentName: string;
  setAgentName: (v: string) => void;
  isLoading: boolean;
  builderStep: 1 | 2 | 3;
  creationResult: any;
  editingAgentId?: string | null;
  onCreate: () => void;
  onStartNewAgent: () => void;
  onOpenAgentsList?: () => void;
  onBackToLanding?: () => void;
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
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
  serverStatus: any;
};

export default function StudioPage(props: Props) {
  const {
    studioView,
    agentCount = 0,
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
    onOpenAgentsList,
    onBackToLanding,
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
    copiedId,
    onCopy,
    serverStatus,
  } = props;

  const fee = options.fee ?? 0;
  const runtimeMode = options.runtimeMode === 'autonomous' ? 'autonomous' : 'specialized';
  const appType = options.aiAppType || 'search_docs';
  const sourceType = options.dataSourceType || 'local_upload';
  const sourceChoices =
    runtimeMode === 'autonomous'
      ? DATA_SOURCES
      : DATA_SOURCES.filter((s) => s.forApps.includes(appType));

  if (studioView === 'landing') {
    return (
      <div className="flex flex-col gap-8 max-w-3xl">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-on-surface">
            에이전트 스튜디오
          </h1>
          <p className="text-lg text-on-surface-variant mt-2">
            RAG 에이전트를 만들고 SolVamos 카탈로그에 게시하세요. 테스트 대화는 내 에이전트 상세에서
            진행합니다.
          </p>
        </div>

        <section className="glass-panel rounded-xl p-8 border border-outline-variant/20 space-y-6">
          <div className="flex items-start gap-4">
            <div className="rounded-xl border border-google-blue/30 bg-google-blue/10 p-3">
              <Bot className="h-8 w-8 text-google-blue" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-on-surface">새 에이전트 만들기</h2>
              <p className="mt-1 text-sm text-on-surface-variant leading-relaxed">
                앱 유형·지식 소스·요금을 설정하고 vault와 카탈로그 리스팅까지 한 번에 생성합니다.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onStartNewAgent}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-google-blue to-solana-green px-8 py-4 text-lg font-semibold text-surface-container-lowest hover:opacity-90"
          >
            <Plus className="h-6 w-6" />
            에이전트 생성
          </button>
        </section>

        <section className="glass-panel rounded-xl p-6 border border-outline-variant/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-on-surface">내 에이전트</p>
            <p className="text-sm text-on-surface-variant mt-1">
              {agentCount > 0
                ? `${agentCount}개 보유 · 상세 정보와 테스트 대화는 목록에서 확인`
                : '아직 만든 에이전트가 없습니다'}
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenAgentsList}
            className="inline-flex items-center gap-2 rounded-lg border border-outline-variant/40 px-4 py-2.5 text-sm font-semibold text-on-surface hover:bg-surface-container-high"
          >
            <List className="h-4 w-4" />
            내 에이전트 목록
          </button>
        </section>

        <p className="text-xs text-outline">
          네트워크 {serverStatus?.paymentNetwork || '—'} · 카탈로그 리스팅{' '}
          {serverStatus?.payShCatalogListings ?? '—'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-gutter max-w-4xl">
      <div className="flex-grow flex flex-col gap-6">
        <div className="mb-2">
          {onBackToLanding ? (
            <button
              type="button"
              onClick={onBackToLanding}
              className="mb-3 inline-flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
            >
              <ArrowLeft className="h-4 w-4" /> 스튜디오 홈
            </button>
          ) : null}
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-on-surface">
            {editingAgentId ? '에이전트 편집' : '에이전트 생성'}
          </h1>
          <p className="text-lg text-on-surface-variant mt-2">
            {editingAgentId
              ? '설정만 변경합니다. 테스트 대화는 내 에이전트 상세에서 하세요.'
              : '새로운 AI 에이전트를 구성하고 배포하세요.'}
          </p>
        </div>

        {/* Step 1 */}
        <section className="glass-panel rounded-xl p-6 transition-all duration-300">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-8 w-8 rounded-full bg-google-blue/20 text-google-blue flex items-center justify-center font-bold border border-google-blue/30 text-sm">
              1
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-on-surface">에이전트 모드 · 지식 소스</h2>
              <p className="text-sm text-on-surface-variant mt-1">
                특화모드는 AI Applications Answer, 자율모드는 Vertex Gemini + Data Store RAG입니다.
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
            <p className="text-sm font-medium text-on-surface-variant mb-2">에이전트 모드</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() =>
                  setOptions((prev) => ({ ...prev, runtimeMode: 'specialized' }))
                }
                className={
                  runtimeMode === 'specialized'
                    ? 'text-left px-4 py-3 rounded-lg border border-google-blue bg-google-blue/10'
                    : 'text-left px-4 py-3 rounded-lg border border-outline-variant/30 bg-surface-container-low hover:border-outline-variant/50'
                }
              >
                <p className="text-sm font-semibold text-on-surface">특화모드</p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  문서 QA · AI Applications Engine + Data Store
                </p>
              </button>
              <button
                type="button"
                onClick={() =>
                  setOptions((prev) => ({
                    ...prev,
                    runtimeMode: 'autonomous',
                    dataSourceType: prev.dataSourceType || 'local_upload',
                  }))
                }
                className={
                  runtimeMode === 'autonomous'
                    ? 'text-left px-4 py-3 rounded-lg border border-solana-green bg-solana-green/10'
                    : 'text-left px-4 py-3 rounded-lg border border-outline-variant/30 bg-surface-container-low hover:border-outline-variant/50'
                }
              >
                <p className="text-sm font-semibold text-on-surface">자율모드</p>
                <p className="text-xs text-on-surface-variant mt-0.5">
                  Gemini 대화 + 필요 시 Data Store 검색 (Engine 없음)
                </p>
              </button>
            </div>
          </div>

          {runtimeMode === 'specialized' ? (
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
          ) : null}

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
                  // Keep in sync with server/local-ingest.ts (500k chars / file, 25 files).
                  const MAX_TEXT_CHARS = 500_000;
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
                        const truncated = text.length > MAX_TEXT_CHARS;
                        next.push({
                          name: file.name,
                          mimeType: file.type || 'text/plain',
                          text: text.slice(0, MAX_TEXT_CHARS),
                          truncated: truncated || undefined,
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
                            : `${(f.text?.length || 0).toLocaleString()}자${
                                f.truncated ? ' (잘림)' : ''
                              }`}
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
                  파일을 올리면 SolVamos가 AI Applications 데이터스토어에 넣습니다. 텍스트/CSV는
                  파일당 최대 50만 자(큰 CSV는 자동 분할), PDF는 최대 8MB/파일 · 최대 25개.
                  GCP 콘솔 작업은 필요 없습니다.
                </p>
              )}
            </div>
          ) : null}

          {sourceType === 'none' && (
            <p className="text-xs text-on-surface-variant mb-4">
              {runtimeMode === 'autonomous'
                ? '빈 Data Store만 만듭니다. 나중에 로컬 파일 추가로 지식을 넣을 수 있습니다.'
                : '앱과 빈 데이터스토어만 만듭니다. 나중에 로컬 파일 추가로 지식을 넣을 수 있습니다.'}
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
                템플릿을 고른 뒤 필요하면 문구를 직접 다듬으세요. 설명은 카탈로그·A2A 디스커버리에
                쓰입니다.
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
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="예: 유튜브 추천 도우미"
                className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-2 text-on-surface input-glow focus:outline-none"
              />
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-2">
                  [에이전트 주요 역할]
                </label>
                <div className="flex flex-wrap gap-2">
                  {ROLE_PRESETS.map((r) => {
                    const active = options.role === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() =>
                          setOptions((prev) => ({
                            ...prev,
                            role: r.id,
                            customRole: r.fill,
                          }))
                        }
                        className={
                          active
                            ? 'px-3.5 py-2 rounded-lg border border-google-blue bg-google-blue/10 text-google-blue text-sm font-medium'
                            : 'px-3.5 py-2 rounded-lg border border-outline-variant/30 bg-surface-container-low text-on-surface-variant hover:border-outline-variant/50 transition-colors text-sm font-medium'
                        }
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                  역할 상세 (직접 수정 가능)
                </label>
                <input
                  type="text"
                  value={options.customRole || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    const matched = ROLE_PRESETS.find((r) => r.fill === value);
                    setOptions((prev) => ({
                      ...prev,
                      role: matched?.id || 'custom',
                      customRole: value,
                    }));
                  }}
                  placeholder="예: 유튜브 채널·영상 추천 및 시청 가이드"
                  maxLength={500}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-2 text-on-surface input-glow focus:outline-none"
                />
                <p className="text-xs text-on-surface-variant mt-1">
                  템플릿을 누르면 채워집니다. 문구를 바꾸면 커스텀 역할로 저장됩니다.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-2">
                  [답변 톤앤매너]
                </label>
                <div className="flex flex-wrap gap-2">
                  {TONE_PRESETS.map((t) => {
                    const active = options.tone === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setOptions((prev) => ({ ...prev, tone: t.id }))}
                        className={
                          active
                            ? 'px-3.5 py-2 rounded-lg border border-google-blue bg-google-blue/10 text-google-blue text-sm font-medium'
                            : 'px-3.5 py-2 rounded-lg border border-outline-variant/30 bg-surface-container-low text-on-surface-variant hover:border-outline-variant/50 transition-colors text-sm font-medium'
                        }
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                  톤 직접 입력 (선택)
                </label>
                <input
                  type="text"
                  value={
                    TONE_PRESETS.some((t) => t.id === options.tone)
                      ? ''
                      : options.tone || ''
                  }
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      tone: e.target.value,
                    }))
                  }
                  placeholder="예: 친절하고 짧게, 존댓말, 과장 없이"
                  maxLength={500}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-2 text-on-surface input-glow focus:outline-none"
                />
                <p className="text-xs text-on-surface-variant mt-1">
                  비워 두면 위에서 고른 템플릿 톤을 씁니다. 직접 입력하면 템플릿 선택을 대체합니다.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-2">
                Description (카탈로그 소개)
              </label>
              <textarea
                value={options.description || ''}
                onChange={(e) =>
                  setOptions((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                rows={3}
                maxLength={2000}
                placeholder="예: 유튜브 영상·채널을 취향에 맞게 추천하고, 시청 포인트와 관련 키워드를 정리해 줍니다."
                className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-3 text-sm text-on-surface input-glow focus:outline-none resize-y min-h-[5rem]"
              />
              <p className="text-xs text-on-surface-variant mt-1">
                마켓플레이스에 보이는 설명이며, A2A가 peer를 고를 때도 이 텍스트를 사용합니다.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-2">
                추가 지시문 (선택)
              </label>
              <textarea
                value={options.customInstructions || ''}
                onChange={(e) =>
                  setOptions((prev) => ({
                    ...prev,
                    customInstructions: e.target.value,
                  }))
                }
                rows={4}
                maxLength={8000}
                placeholder="예: 항상 한국어로 답하고, 사내 규정에 없는 내용은 추측하지 마세요."
                className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-4 py-3 text-sm text-on-surface input-glow focus:outline-none resize-y min-h-[6rem]"
              />
              <p className="text-xs text-on-surface-variant mt-1">
                역할·톤 설정 위에 붙는 자유 지시문입니다. 특화·자율 모두 동일하게 적용됩니다.
              </p>
            </div>

            <div className="bg-surface-container p-4 rounded-lg border border-outline-variant/10 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <label className="text-sm font-medium text-on-surface">A2A 피어 호출</label>
                  <p className="text-[11px] text-outline mt-1 leading-relaxed">
                    켜면 카탈로그 피어(무료→유료)로 에스컬레이션합니다. 유료 피어는 이 에이전트
                    vault USDC에서 차감됩니다.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm text-on-surface shrink-0 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={options.a2aPeersEnabled !== false}
                    onChange={(e) =>
                      setOptions((prev) => ({ ...prev, a2aPeersEnabled: e.target.checked }))
                    }
                    className="accent-google-blue"
                  />
                  {options.a2aPeersEnabled !== false ? 'ON' : 'OFF'}
                </label>
              </div>
            </div>

            <div className="bg-surface-container p-4 rounded-lg border border-outline-variant/10">
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-medium text-on-surface">호출 당 청구 단가</label>
                <span className="text-sm font-bold text-secondary">
                  {fee === 0 ? 'Free' : `$${fee.toFixed(3)} USDC / 회`}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { value: 0, label: '무료' },
                  { value: 0.001, label: '0.001' },
                  { value: 0.01, label: '0.01' },
                  { value: 0.1, label: '0.1' },
                ].map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    onClick={() => setOptions((prev) => ({ ...prev, fee: choice.value }))}
                    className={
                      fee === choice.value
                        ? 'rounded-lg border border-google-blue bg-google-blue/15 px-3 py-2 text-sm font-semibold text-google-blue'
                        : 'rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant hover:border-outline'
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <label className="text-xs text-on-surface-variant shrink-0">직접 입력</label>
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  value={Number.isFinite(fee) ? fee : 0}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setOptions((prev) => ({
                      ...prev,
                      fee: Number.isFinite(next) && next >= 0 ? next : 0,
                    }));
                  }}
                  className="w-full bg-surface-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-sm text-on-surface input-glow focus:outline-none"
                />
                <span className="text-xs text-outline shrink-0">USDC</span>
              </div>
              <p className="mt-2 text-[11px] text-outline">
                유료 호출은 pay.sh 호환 게이트웨이/원본 invoke에서 x402/MPP로 정산합니다. 에이전트별 단가가
                카탈로그·페이월에 반영됩니다.
              </p>
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
                  : '에이전트 생성 완료 · SolVamos 카탈로그 등록'}
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

              <div className="mt-4 space-y-2 rounded-lg border border-outline-variant/20 bg-surface-container-lowest/70 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-solana-green">
                  SolVamos 카탈로그 · 공개 주소
                </p>
                {[
                  {
                    id: 'catalog-page',
                    label: '카탈로그 페이지 (UI)',
                    value:
                      creationResult.catalogPageUrl ||
                      creationResult.payShCatalog?.catalogPageUrl ||
                      (serverStatus?.catalogSiteUrl
                        ? `${serverStatus.catalogSiteUrl}/marketplace`
                        : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace'),
                    open: true,
                  },
                  {
                    id: 'catalog-api',
                    label: '카탈로그 API (JSON)',
                    value:
                      creationResult.catalogApiUrl ||
                      creationResult.payShCatalog?.catalogApiUrl ||
                      (serverStatus?.catalogSiteUrl
                        ? `${serverStatus.catalogSiteUrl}/api/catalog`
                        : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/api/catalog'),
                    open: true,
                  },
                  {
                    id: 'invoke',
                    label: 'Invoke API (x402/MPP when paid)',
                    value:
                      creationResult.payShCatalog?.publicInvokeUrl ||
                      creationResult.payShCatalog?.invokeUrl ||
                      '',
                    open: false,
                  },
                  {
                    id: 'agent-card',
                    label: 'Agent Card',
                    value: creationResult.payShCatalog?.agentCardUrl || '',
                    open: true,
                  },
                ]
                  .filter((row) => row.value)
                  .map((row) => (
                    <div key={row.id} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] uppercase tracking-wider text-outline">{row.label}</p>
                        <code className="mt-0.5 block break-all font-mono text-xs text-on-surface">
                          {row.value}
                        </code>
                      </div>
                      <button
                        type="button"
                        onClick={() => onCopy(String(row.value), `create-${row.id}`)}
                        className="shrink-0 rounded-md bg-google-blue/15 p-2 text-google-blue hover:bg-google-blue/25"
                        title="복사"
                      >
                        {copiedId === `create-${row.id}` ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {row.open ? (
                        <a
                          href={String(row.value)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 rounded-md bg-surface-container-high p-2 text-on-surface-variant hover:text-on-surface"
                          title="열기"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                    </div>
                  ))}
                <a
                  href={
                    creationResult.catalogPageUrl ||
                    creationResult.payShCatalog?.catalogPageUrl ||
                    (serverStatus?.catalogSiteUrl
                      ? `${serverStatus.catalogSiteUrl}/marketplace`
                      : 'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace')
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-2 rounded-lg bg-solana-green/15 px-3 py-2 text-sm font-semibold text-solana-green hover:bg-solana-green/25"
                >
                  공개 카탈로그에서 보기 <ExternalLink className="h-4 w-4" />
                </a>
              </div>

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
                : '에이전트 생성 및 SolVamos 카탈로그 게시하기'}
          </button>
          {editingAgentId ? (
            <p className="text-xs text-on-surface-variant mt-2 text-center">
              같은 에이전트 메타/요금만 업데이트합니다. 새 vault·새 ID를 만들지 않습니다.
            </p>
          ) : null}
        </section>
      </div>

    </div>
  );
}
