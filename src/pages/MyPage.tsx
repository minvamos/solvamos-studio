/**
 * My Page — account, tenant (shared GCP), Google link.
 */
import { useEffect, useState } from 'react';
import { Link2, Building2, Shield, RefreshCw } from 'lucide-react';

type AccountPayload = {
  user: {
    id: string;
    email: string;
    name: string | null;
    picture: string | null;
    tenantId: string | null;
    googleLinked: boolean;
    hasPassword: boolean;
    driveConnected: boolean;
  };
  tenant: {
    tenantId: string;
    displayName: string;
    projectId: string;
    tenancyMode?: string | null;
    sharedProject?: boolean;
    role?: string | null;
    provisionNotes?: string[];
  };
  google: {
    linked: boolean;
    driveConnected: boolean;
    linkUrl: string | null;
  };
};

type Props = {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onLinked?: () => void;
};

export default function MyPage({ authFetch, onLinked }: Props) {
  const [data, setData] = useState<AccountPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const res = await authFetch('/api/account/me');
      const json = await res.json();
      if (!res.ok || json.status !== 'success') {
        setError(json.message || '계정 정보를 불러오지 못했습니다');
        return;
      }
      setData(json);
    } catch (err: any) {
      setError(err.message || '요청 실패');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const linkGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('/api/auth/google?intent=link');
      const json = await res.json();
      if (json.status !== 'success') {
        setError(json.message || 'Google 연동을 시작할 수 없습니다');
        return;
      }
      if (json.authUrl) {
        window.location.href = json.authUrl;
        return;
      }
      await load();
      onLinked?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reprovision = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('/api/tenants/provision-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || '프로비저닝 실패');
        return;
      }
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) {
    return <p className="text-on-surface-variant text-sm">계정 불러오는 중…</p>;
  }

  const u = data?.user;
  const t = data?.tenant;

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-bold text-on-surface tracking-tight">마이페이지</h2>
        <p className="text-sm text-on-surface-variant mt-1">
          계정 · 테넌트(공유 GCP) · Google Drive 연동
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-400 whitespace-pre-wrap border border-red-400/30 rounded-lg p-3">
          {error}
        </p>
      )}

      {u && (
        <section className="rounded-2xl border border-outline-variant/20 bg-surface-container-low/60 p-6 flex gap-4 items-start">
          <img
            src={u.picture || '/avatar.png'}
            alt=""
            className="w-14 h-14 rounded-full object-cover border border-outline-variant/30"
            referrerPolicy="no-referrer"
          />
          <div className="flex-1 min-w-0">
            <p className="text-lg font-semibold text-on-surface">{u.name || '사용자'}</p>
            <p className="text-sm text-on-surface-variant truncate">{u.email}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Badge ok={u.hasPassword}>비밀번호 계정</Badge>
              <Badge ok={u.googleLinked}>Google 연동</Badge>
              <Badge ok={u.driveConnected}>Drive 연결</Badge>
            </div>
          </div>
        </section>
      )}

      {t && (
        <section className="rounded-2xl border border-outline-variant/20 bg-surface-container-low/60 p-6">
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="w-5 h-5 text-google-blue" />
            <h3 className="font-semibold text-on-surface">고객 테넌트 (Lab)</h3>
          </div>
          <p className="text-sm text-on-surface-variant mb-4 leading-relaxed">
            실제 Org 프로젝트 생성 대신, 플랫폼 GCP 프로젝트를 고객 프로젝트로 DB에 바인딩합니다.
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <Item label="Tenant ID" value={t.tenantId} />
            <Item label="역할" value={t.role || '—'} />
            <Item label="표시 이름" value={t.displayName} />
            <Item label="GCP projectId" value={t.projectId} mono />
            <Item label="tenancyMode" value={t.tenancyMode || 'shared'} />
            <Item label="sharedProject" value={String(!!t.sharedProject)} />
          </dl>
          <button
            type="button"
            disabled={busy}
            onClick={reprovision}
            className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-on-surface-variant hover:text-on-surface"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            테넌트 멤버십 다시 보장
          </button>
        </section>
      )}

      <section className="rounded-2xl border border-outline-variant/20 bg-surface-container-low/60 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Link2 className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-on-surface">Google 계정 연동</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-4 leading-relaxed">
          이메일로 가입한 뒤에도 언제든지 Google을 연결해 Drive.readonly와 SSO를 사용할 수 있습니다.
        </p>
        {data?.google.linked && data.google.driveConnected ? (
          <p className="text-sm text-solana-green flex items-center gap-2">
            <Shield className="w-4 h-4" />
            Google 연동 및 Drive 권한이 활성화되어 있습니다.
          </p>
        ) : (
          <button
            type="button"
            disabled={busy || !data?.google.linkUrl}
            onClick={linkGoogle}
            className="btn-primary px-5 py-2.5 rounded-full text-sm font-medium disabled:opacity-50"
          >
            {data?.google.linked ? 'Drive 권한 다시 연결' : 'Google 계정 연동하기'}
          </button>
        )}
      </section>
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span
      className={
        ok
          ? 'text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full bg-solana-green/15 text-solana-green'
          : 'text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full bg-outline-variant/20 text-on-surface-variant'
      }
    >
      {children}
    </span>
  );
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-outline mb-0.5">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-on-surface break-all' : 'text-on-surface'}>
        {value}
      </dd>
    </div>
  );
}
