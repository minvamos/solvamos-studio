/**
 * Sign in / Sign up — email+password and Google.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Cloud, Wallet, Boxes } from 'lucide-react';

export type AuthMode = 'signin' | 'signup';

type Props = {
  mode?: AuthMode;
  onModeChange?: (m: AuthMode) => void;
  onEmailSubmit: (payload: {
    mode: AuthMode;
    email: string;
    password: string;
    name?: string;
    orgName?: string;
  }) => Promise<void> | void;
  onGoogle: (intent: 'login' | 'signup') => Promise<void> | void;
  onDevSkip?: () => void;
  oauthConfigured?: boolean;
  busy?: boolean;
  error?: string | null;
};

export default function Landing({
  mode: controlledMode,
  onModeChange,
  onEmailSubmit,
  onGoogle,
  onDevSkip,
  oauthConfigured,
  busy,
  error,
}: Props) {
  const [internalMode, setInternalMode] = useState<AuthMode>('signin');
  const mode = controlledMode ?? internalMode;
  const setMode = (m: AuthMode) => {
    onModeChange?.(m);
    setInternalMode(m);
  };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onEmailSubmit({
      mode,
      email,
      password,
      name: name || undefined,
      orgName: orgName || undefined,
    });
  };

  return (
    <div className="bg-[#0F172A] text-on-surface min-h-screen flex items-center justify-center font-sans relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-secondary/5 blur-[120px] pointer-events-none" />

      <div className="w-full min-h-screen flex flex-col md:flex-row relative z-10 max-w-[1920px] mx-auto">
        <div className="flex-1 flex flex-col justify-center p-8 md:p-16 relative max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-4 mb-8">
            <img src="/logo.png" alt="SolVamos" className="h-16 w-16 object-contain" />
            <div className="flex flex-col items-start">
              <span className="text-5xl md:text-6xl font-bold text-primary tracking-tight leading-none">
                SolVamos
              </span>
              <span className="text-sm md:text-base text-on-surface tracking-[0.3em] uppercase mt-1 font-medium">
                Studio
              </span>
            </div>
          </div>

          <h1 className="text-3xl md:text-5xl font-bold text-on-surface mb-4 tracking-tight leading-tight">
            AI 에이전트로
            <br />
            비즈니스를 혁신하세요
          </h1>
          <p className="text-base md:text-lg text-on-surface-variant mb-8 leading-relaxed">
            계정 생성 시 워크스페이스(테넌트)가 준비됩니다. Google Drive는 나중에 연동할 수 있습니다.
          </p>

          <div className="flex flex-col gap-4">
            <FeatureCard
              icon={<Boxes className="w-6 h-6 text-primary" />}
              title="No-Code AI 에이전트 빌더"
              body="복잡한 코딩 없이 직관적인 인터페이스로 맞춤형 AI 에이전트를 설계하고 배포하세요."
            />
            <FeatureCard
              icon={<Cloud className="w-6 h-6 text-google-blue" />}
              title="Google Cloud 기반 (엔터프라이즈 보안)"
              body="최고 수준의 클라우드 인프라를 통해 강력한 성능과 안전한 데이터 보호를 제공합니다."
            />
            <FeatureCard
              icon={<Wallet className="w-6 h-6 text-solana-green" />}
              title="Solana 연동 (온체인 수익화)"
              body="초고속 블록체인 네트워크를 통해 AI 서비스의 사용량 기반 실시간 결제 및 수익 모델을 구축하세요."
            />
          </div>
        </div>

        <div className="w-full md:w-[480px] lg:w-[560px] flex flex-col items-center justify-center p-8 md:p-16 bg-surface-container-lowest/80 backdrop-blur-xl border-t md:border-t-0 md:border-l border-white/10 shadow-2xl">
          <div className="w-full flex flex-col max-w-sm">
            <div className="flex rounded-full bg-surface-container p-1 mb-8 border border-outline-variant/30">
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode('signin')}
                className={
                  mode === 'signin'
                    ? 'flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-on-primary'
                    : 'flex-1 py-2.5 rounded-full text-sm font-medium text-on-surface-variant'
                }
              >
                로그인
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode('signup')}
                className={
                  mode === 'signup'
                    ? 'flex-1 py-2.5 rounded-full text-sm font-semibold bg-primary text-on-primary'
                    : 'flex-1 py-2.5 rounded-full text-sm font-medium text-on-surface-variant'
                }
              >
                회원가입
              </button>
            </div>

            <h2 className="text-2xl font-semibold text-on-surface mb-1 tracking-tight text-center">
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </h2>
            <p className="text-sm text-on-surface-variant mb-6 text-center">
              {mode === 'signin'
                ? '이메일 또는 Google로 로그인하세요.'
                : '가입 시 Lab 고객 테넌트(공유 GCP)가 DB에 생성·연결됩니다.'}
            </p>

            <form onSubmit={submit} className="flex flex-col gap-3">
              {mode === 'signup' && (
                <>
                  <Field
                    label="이름"
                    value={name}
                    onChange={setName}
                    autoComplete="name"
                    placeholder="홍길동"
                  />
                  <Field
                    label="조직 / 워크스페이스 이름 (선택)"
                    value={orgName}
                    onChange={setOrgName}
                    placeholder="Acme Corp"
                  />
                </>
              )}
              <Field
                label="이메일"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
                required
                placeholder="you@company.com"
              />
              <Field
                label="비밀번호"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                placeholder={mode === 'signup' ? '8자 이상' : '••••••••'}
              />

              <button
                type="submit"
                disabled={busy}
                className="mt-2 w-full py-3.5 rounded-full btn-primary text-base font-semibold disabled:opacity-50"
              >
                {busy ? '처리 중…' : mode === 'signin' ? '로그인' : '계정 만들고 시작하기'}
              </button>
            </form>

            <div className="flex items-center gap-3 my-6">
              <div className="h-px flex-1 bg-outline-variant/30" />
              <span className="text-xs text-outline">또는</span>
              <div className="h-px flex-1 bg-outline-variant/30" />
            </div>

            <button
              type="button"
              disabled={busy || oauthConfigured === false}
              onClick={() => onGoogle(mode === 'signup' ? 'signup' : 'login')}
              className="w-full flex items-center justify-center gap-3 py-3.5 px-6 rounded-full border border-outline-variant/40 bg-surface-container text-on-surface transition-all hover:border-google-blue/50 disabled:opacity-50"
            >
              <GoogleG />
              <span className="font-medium text-sm">
                {mode === 'signup' ? 'Google로 회원가입' : 'Google로 로그인'}
              </span>
            </button>

            {error && (
              <p className="mt-4 text-xs text-red-400 leading-relaxed whitespace-pre-wrap text-center">
                {error}
              </p>
            )}

            {oauthConfigured === false && (
              <p className="mt-4 text-xs text-outline leading-relaxed text-center">
                Google OAuth Client가 없으면 이메일 가입/로그인만 가능합니다.
              </p>
            )}

            {oauthConfigured === false && onDevSkip && (
              <button
                type="button"
                disabled={busy}
                onClick={onDevSkip}
                className="mt-4 text-xs text-on-surface-variant underline hover:text-on-surface disabled:opacity-50"
              >
                개발 모드로 입장 (로그인 없이)
              </button>
            )}

            <p className="mt-8 text-[11px] text-outline leading-relaxed text-center">
              계속 진행하면 서비스 이용약관 및 개인정보 처리방침에 동의하는 것으로 간주됩니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-left">
      <span className="text-xs font-medium text-on-surface-variant">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        className="w-full rounded-xl bg-surface-container border border-outline-variant/40 px-4 py-3 text-sm text-on-surface focus:outline-none focus:border-google-blue focus:ring-1 focus:ring-google-blue"
      />
    </label>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-lg bg-surface-container-low/50 border border-outline-variant/20 backdrop-blur-sm">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div>
        <h3 className="text-on-surface mb-1 text-lg font-semibold">{title}</h3>
        <p className="text-on-surface-variant text-sm leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
