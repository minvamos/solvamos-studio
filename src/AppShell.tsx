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
  FlaskConical,
  ScrollText,
} from 'lucide-react';

export type AppTab = 'studio' | 'list' | 'settlements' | 'account' | 'lab' | 'evidence' | 'logs';

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
};

const NAV: { id: AppTab; label: string; icon: typeof Bot }[] = [
  { id: 'studio', label: '에이전트 스튜디오', icon: Factory },
  { id: 'list', label: '내 에이전트 목록', icon: Bot },
  { id: 'evidence', label: '근거 대시보드', icon: FlaskConical },
  { id: 'logs', label: '개발자 로그', icon: ScrollText },
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
          <div className="mt-3 p-2 rounded-lg bg-surface-container border border-outline-variant/20">
            <p className="text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider mb-1 px-1">
              결제 네트워크
            </p>
            <p className="text-xs font-semibold text-google-blue px-1">
              {paymentNetwork || 'devnet'} · Solana Devnet USDC
            </p>
            <p className="text-[10px] text-outline mt-1 px-1 leading-relaxed">
              Localnet/sandbox는 폐기되었습니다. pay-gateway → Devnet 온체인만 사용합니다.
            </p>
          </div>
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
          <a
            href="https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 px-4 py-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest/50 transition-all rounded-lg text-left"
          >
            <Bot className="w-5 h-5" />
            <span className="text-sm font-medium">SolVamos 공개 카탈로그</span>
          </a>
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
