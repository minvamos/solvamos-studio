import type { ReactNode } from 'react';
import {
  Factory,
  Bot,
  Wallet,
  Settings,
  LifeBuoy,
  Plus,
  Search,
  Bell,
  HelpCircle,
  LogOut,
} from 'lucide-react';

export type AppTab = 'studio' | 'list' | 'settlements' | 'account';

type Props = {
  activeTab: AppTab;
  onNavigate: (tab: AppTab) => void;
  userEmail?: string | null;
  userName?: string | null;
  userPicture?: string | null;
  walletHint?: string | null;
  onWalletClick?: () => void;
  children: ReactNode;
  onLogout?: () => void;
  paymentNetwork?: string;
  onPaymentNetworkChange?: (network: 'sandbox' | 'devnet') => void;
  paymentSwitchBusy?: boolean;
  catalogPublishMode?: 'internal' | 'main' | 'both';
  onCatalogPublishModeChange?: (mode: 'internal' | 'main' | 'both') => void;
  catalogSwitchBusy?: boolean;
  catalogRemoteConfigured?: boolean;
};

const NAV: { id: AppTab; label: string; icon: typeof Bot }[] = [
  { id: 'studio', label: '에이전트 스튜디오', icon: Factory },
  { id: 'list', label: '내 에이전트 목록', icon: Bot },
  { id: 'settlements', label: '온체인 정산 내역', icon: Wallet },
  { id: 'account', label: '마이페이지', icon: Settings },
];

export default function AppShell({
  activeTab,
  onNavigate,
  userEmail,
  userName,
  userPicture,
  walletHint,
  onWalletClick,
  children,
  onLogout,
  paymentNetwork,
  onPaymentNetworkChange,
  paymentSwitchBusy,
  catalogPublishMode,
  onCatalogPublishModeChange,
  catalogSwitchBusy,
  catalogRemoteConfigured,
}: Props) {
  return (
    <div className="bg-background text-on-surface antialiased min-h-screen flex font-sans overflow-x-hidden">
      <nav className="fixed left-0 top-0 h-full w-[280px] bg-surface-container-low border-r border-outline-variant/10 flex flex-col py-8 z-50">
        <div className="px-6 mb-8 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="SolVamos" className="h-10 w-10 object-contain" />
            <div>
              <h1 className="text-xl font-bold text-on-surface leading-tight">SolVamos Studio</h1>
              <p className="text-xs font-medium text-on-surface-variant">
                Powered by Google Cloud × Solana
              </p>
            </div>
          </div>
          {onPaymentNetworkChange && (
            <div className="mt-3 p-2 rounded-lg bg-surface-container border border-outline-variant/20">
              <p className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-2 px-1">
                개발자 · 결제 테스트
              </p>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={paymentSwitchBusy}
                  onClick={() => onPaymentNetworkChange('sandbox')}
                  className={
                    paymentNetwork === 'sandbox'
                      ? 'flex-1 py-1.5 rounded-md text-xs font-semibold bg-solana-green/20 text-solana-green border border-solana-green/40'
                      : 'flex-1 py-1.5 rounded-md text-xs font-medium text-on-surface-variant hover:bg-surface-container-highest'
                  }
                >
                  Sandbox
                </button>
                <button
                  type="button"
                  disabled={paymentSwitchBusy}
                  onClick={() => onPaymentNetworkChange('devnet')}
                  className={
                    paymentNetwork === 'devnet'
                      ? 'flex-1 py-1.5 rounded-md text-xs font-semibold bg-google-blue/20 text-google-blue border border-google-blue/40'
                      : 'flex-1 py-1.5 rounded-md text-xs font-medium text-on-surface-variant hover:bg-surface-container-highest'
                  }
                >
                  Devnet
                </button>
              </div>
              <p className="text-[10px] text-outline mt-2 px-1 leading-relaxed">
                {paymentNetwork === 'devnet'
                  ? '제품 경로: Devnet USDC 실서명 필요'
                  : '테스트: pay.sh 샌드박스 증명'}
              </p>
            </div>
          )}

          {onCatalogPublishModeChange && (
            <div className="mt-2 p-2 rounded-lg bg-surface-container border border-outline-variant/20">
              <p className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-2 px-1">
                개발자 · pay.sh 카탈로그
              </p>
              <div className="flex gap-1">
                {(
                  [
                    { id: 'internal' as const, label: '내부' },
                    { id: 'main' as const, label: '메인' },
                    { id: 'both' as const, label: '둘다' },
                  ] as const
                ).map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={catalogSwitchBusy}
                    onClick={() => onCatalogPublishModeChange(id)}
                    className={
                      catalogPublishMode === id
                        ? 'flex-1 py-1.5 rounded-md text-xs font-semibold bg-secondary/20 text-secondary border border-secondary/40'
                        : 'flex-1 py-1.5 rounded-md text-xs font-medium text-on-surface-variant hover:bg-surface-container-highest'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-outline mt-2 px-1 leading-relaxed">
                {catalogPublishMode === 'main'
                  ? catalogRemoteConfigured
                    ? '메인: 외부 PAYSH_CATALOG_URL로 게시'
                    : '메인: Lab 미러 파일 (URL 미설정)'
                  : catalogPublishMode === 'both'
                    ? '내부 + 메인에 동시 게시'
                    : '내부: 이 Studio 카탈로그만 (로컬 A2A)'}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 flex-grow">
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate(id)}
                className={
                  active
                    ? 'flex items-center gap-4 px-6 py-4 bg-secondary-container/10 text-secondary border-r-2 border-secondary scale-[0.98] transition-transform text-left'
                    : 'flex items-center gap-4 px-6 py-4 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/50 transition-all duration-200 text-left'
                }
              >
                <Icon className="w-5 h-5 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                <span className="text-sm font-medium">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1 mt-auto pt-6 border-t border-outline-variant/10 px-2">
          <button
            type="button"
            onClick={() => onNavigate('account')}
            className="flex items-center gap-4 px-4 py-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/50 transition-all rounded-lg text-left"
          >
            <Settings className="w-5 h-5" />
            <span className="text-sm font-medium">설정 / 계정</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-4 px-4 py-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/50 transition-all rounded-lg text-left"
          >
            <LifeBuoy className="w-5 h-5" />
            <span className="text-sm font-medium">고객 지원</span>
          </button>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-4 px-4 py-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/50 transition-all rounded-lg text-left"
            >
              <LogOut className="w-5 h-5" />
              <span className="text-sm font-medium">로그아웃</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('studio')}
            className="mt-6 mx-4 py-2.5 rounded-lg btn-primary text-sm font-medium flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            새 에이전트 생성
          </button>
        </div>
      </nav>

      <div className="flex-grow flex flex-col ml-[280px] min-h-screen">
        <header className="flex justify-between items-center h-16 px-6 w-full bg-surface/80 backdrop-blur-xl border-b border-outline-variant/10 sticky top-0 z-40">
          <div className="flex-grow max-w-md">
            <div className="relative flex items-center">
              <Search className="absolute left-3 w-4 h-4 text-on-surface-variant" />
              <input
                className="w-full bg-surface-container-high border border-outline-variant/50 rounded-full py-1.5 pl-10 pr-4 text-sm text-on-surface focus:outline-none focus:border-google-blue focus:ring-1 focus:ring-google-blue transition-colors placeholder:text-on-surface-variant"
                placeholder="Search..."
                type="search"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/30 rounded-full transition-colors"
            >
              <Bell className="w-5 h-5" />
            </button>
            <button
              type="button"
              className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/30 rounded-full transition-colors"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
            <div className="h-6 w-px bg-outline-variant/30 mx-1" />
            <button
              type="button"
              className="text-sm font-medium text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/30 px-3 py-1.5 rounded-lg transition-colors"
            >
              Workspace
            </button>
            {walletHint ? (
              <button
                type="button"
                onClick={onWalletClick}
                className="px-3 py-1.5 rounded-full bg-secondary-container/10 border border-secondary/30 text-secondary text-xs font-mono flex items-center gap-2 hover:bg-secondary-container/20 transition-colors"
                title="지갑 관리"
              >
                <span className="h-2 w-2 rounded-full bg-solana-green" />
                {walletHint}
              </button>
            ) : (
              <button
                type="button"
                onClick={onWalletClick}
                className="btn-primary px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2"
              >
                <Wallet className="w-4 h-4" />
                Connect Wallet
              </button>
            )}
            <div className="flex items-center gap-2 ml-1">
              {(userName || userEmail) && (
                <div className="hidden sm:flex flex-col items-end mr-1">
                  {userName && (
                    <span className="text-xs font-medium text-on-surface leading-tight">
                      {userName}
                    </span>
                  )}
                  {userEmail && (
                    <span className="text-[10px] text-on-surface-variant leading-tight">
                      {userEmail}
                    </span>
                  )}
                </div>
              )}
              <div
                className="w-8 h-8 rounded-full bg-surface-container-high overflow-hidden border border-outline-variant/20"
                title={userEmail || undefined}
              >
                <img
                  src={userPicture || '/avatar.png'}
                  alt=""
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
            </div>
          </div>
        </header>

        <main className="flex-grow p-gutter">{children}</main>
      </div>
    </div>
  );
}
