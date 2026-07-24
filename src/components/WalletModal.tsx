/**
 * Solana wallet registry UI — add addresses, Phantom connect, pick primary.
 */
import { useState } from 'react';
import { Wallet, X, Star, Trash2, Plus, Link2 } from 'lucide-react';

export type WalletRow = {
  id: string;
  address: string;
  label: string;
  source: string;
  isPrimary: boolean;
  createdAt: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  wallets: WalletRow[];
  busy?: boolean;
  error?: string | null;
  onAdd: (address: string, label: string, source?: string) => Promise<void>;
  onSetPrimary: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

type PhantomProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: { toString: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{
    publicKey: { toString: () => string };
  }>;
};

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: {
      solana?: PhantomProvider;
    };
    solflare?: {
      connect: () => Promise<void>;
      publicKey?: { toString: () => string };
    };
  }
}

function short(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function getPhantomProvider(): PhantomProvider | null {
  const fromNamespace = window.phantom?.solana;
  if (fromNamespace?.isPhantom) return fromNamespace;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

/** Phantom injects async after page load — wait briefly before giving up. */
function waitForPhantom(timeoutMs = 2500): Promise<PhantomProvider | null> {
  const existing = getPhantomProvider();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const started = Date.now();
    const onReady = () => {
      const p = getPhantomProvider();
      if (p) {
        cleanup();
        resolve(p);
      }
    };
    const tick = window.setInterval(() => {
      if (getPhantomProvider()) {
        cleanup();
        resolve(getPhantomProvider());
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        cleanup();
        resolve(null);
      }
    }, 120);
    const cleanup = () => {
      window.clearInterval(tick);
      window.removeEventListener('phantom#initialized', onReady);
    };
    window.addEventListener('phantom#initialized', onReady);
  });
}

export default function WalletModal({
  open,
  onClose,
  wallets,
  busy,
  error,
  onAdd,
  onSetPrimary,
  onRemove,
}: Props) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [phantomBusy, setPhantomBusy] = useState(false);

  if (!open) return null;

  const submitManual = async () => {
    setLocalError(null);
    try {
      await onAdd(address.trim(), label.trim(), 'manual');
      setAddress('');
      setLabel('');
    } catch (err: any) {
      setLocalError(err?.message || '등록 실패');
    }
  };

  const connectPhantom = async () => {
    setLocalError(null);
    setPhantomBusy(true);
    try {
      const provider = await waitForPhantom();
      if (!provider?.isPhantom) {
        setLocalError(
          'Phantom을 찾지 못했습니다. 확장 프로그램을 설치·잠금 해제한 뒤 이 탭을 새로고침하거나, 아래 칸에 주소를 직접 입력하세요.'
        );
        return;
      }
      let addr = provider.publicKey?.toString?.() || '';
      if (!addr) {
        const res = await provider.connect({ onlyIfTrusted: false });
        addr = res?.publicKey?.toString?.() || provider.publicKey?.toString?.() || '';
      }
      if (!addr) {
        setLocalError('Phantom에서 공개키를 받지 못했습니다. 지갑 잠금을 해제한 뒤 다시 시도하세요.');
        return;
      }
      await onAdd(addr, 'Phantom', 'phantom');
    } catch (err: any) {
      const code = err?.code;
      const msg = String(err?.message || err?.error || '');
      if (code === 4001 || /reject|denied|cancel/i.test(msg)) {
        setLocalError('Phantom 연결이 취소되었습니다.');
      } else if (/login required|unauthorized|401/i.test(msg)) {
        setLocalError('지갑 등록에는 Google 로그인이 필요합니다. 먼저 로그인한 뒤 다시 시도하세요.');
      } else if (/invalid solana address/i.test(msg)) {
        setLocalError(
          '받은 주소가 유효하지 않습니다. Phantom 네트워크(Solana)를 확인한 뒤 다시 시도하세요.'
        );
      } else {
        setLocalError(msg || 'Phantom 연결 실패');
      }
    } finally {
      setPhantomBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="닫기"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg rounded-2xl border border-outline-variant/30 bg-surface-container-lowest shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/20">
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-solana-green" />
            <h2 className="text-lg font-semibold text-on-surface">Solana 지갑</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container-high"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <p className="text-sm text-on-surface-variant leading-relaxed">
            정산·표시용으로 쓸 주소를 등록하세요. <strong className="text-on-surface">메인</strong>으로
            고른 주소가 헤더에 표시됩니다. 에이전트 A2A 수금 주소는 생성 시 기본 vault가 별도로
            붙습니다.
          </p>

          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-outline">
              등록된 주소
            </p>
            {wallets.length === 0 && (
              <p className="text-sm text-on-surface-variant py-3 text-center border border-dashed border-outline-variant/30 rounded-xl">
                아직 등록된 지갑이 없습니다.
              </p>
            )}
            <ul className="space-y-2">
              {wallets.map((w) => (
                <li
                  key={w.id}
                  className={
                    w.isPrimary
                      ? 'rounded-xl border border-solana-green/40 bg-solana-green/5 p-3'
                      : 'rounded-xl border border-outline-variant/25 bg-surface-container-low/50 p-3'
                  }
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-on-surface truncate">{w.label}</span>
                        {w.isPrimary && (
                          <span className="text-[10px] font-semibold uppercase text-solana-green border border-solana-green/40 rounded px-1.5 py-0.5">
                            메인
                          </span>
                        )}
                        <span className="text-[10px] text-outline uppercase">{w.source}</span>
                      </div>
                      <p className="font-mono text-xs text-on-surface-variant mt-1 break-all">
                        {w.address}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      {!w.isPrimary && (
                        <button
                          type="button"
                          disabled={busy}
                          title="메인으로 설정"
                          onClick={() => onSetPrimary(w.id)}
                          className="p-1.5 rounded-md text-on-surface-variant hover:text-solana-green hover:bg-solana-green/10"
                        >
                          <Star className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        title="삭제"
                        onClick={() => onRemove(w.id)}
                        className="p-1.5 rounded-md text-on-surface-variant hover:text-red-400 hover:bg-red-400/10"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3 pt-1 border-t border-outline-variant/20">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-outline">
              주소 추가
            </p>
            <button
              type="button"
              disabled={busy || phantomBusy}
              onClick={connectPhantom}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-solana-green/40 text-solana-green hover:bg-solana-green/10 text-sm font-medium disabled:opacity-50"
            >
              <Link2 className="w-4 h-4" />
              {phantomBusy ? 'Phantom 연결 중…' : 'Phantom으로 연결'}
            </button>
            <div className="flex flex-col gap-2">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="라벨 (예: 회사 정산 지갑)"
                className="w-full bg-surface-container-high border border-outline-variant/40 rounded-lg px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:border-solana-green/50"
              />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Solana 주소 (Base58)"
                className="w-full bg-surface-container-high border border-outline-variant/40 rounded-lg px-3 py-2 text-sm font-mono text-on-surface placeholder:text-outline focus:outline-none focus:border-solana-green/50"
              />
              <button
                type="button"
                disabled={busy || !address.trim()}
                onClick={submitManual}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl btn-primary text-sm font-medium disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                주소 등록
              </button>
            </div>
          </div>

          {(error || localError) && (
            <p className="text-sm text-red-400 whitespace-pre-wrap">{error || localError}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export { short as shortWallet };
