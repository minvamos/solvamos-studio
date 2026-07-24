import { useEffect, useState } from 'react';
import { Bot, Check, Copy, ExternalLink, LogIn, RefreshCw } from 'lucide-react';

type CatalogEntry = {
  catalogId: string;
  agentId: string;
  name: string;
  description: string;
  role: string;
  feeUsdc: number;
  token: string;
  network: string;
  publicInvokeUrl?: string;
  originInvokeUrl?: string;
  agentCardUrl?: string;
  paymentProtocol?: string;
};

export default function PublicCatalogPage() {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [network, setNetwork] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [catalogUrl, setCatalogUrl] = useState(`${window.location.origin}/api/catalog`);
  const [marketplaceUrl, setMarketplaceUrl] = useState('/catalog');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/catalog', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || '카탈로그를 불러오지 못했습니다.');
      }
      setEntries(data.data || []);
      setNetwork(data.network || data.paymentNetwork || '');
      if (data.catalogUrl) setCatalogUrl(data.catalogUrl);
      if (data.publicPageUrl) setMarketplaceUrl(data.publicPageUrl);
    } catch (err: any) {
      setError(err.message || '카탈로그 요청 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <main className="min-h-screen bg-background text-on-surface px-5 py-8 md:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-3">
              <img src="/logo.png" alt="SolVamos" className="h-11 w-11 object-contain" />
              <span className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
                Public Agent Catalog · SolVamos
              </span>
            </div>
            <h1 className="text-3xl font-bold md:text-4xl">SolVamos 공개 API 카탈로그</h1>
            <p className="mt-2 text-on-surface-variant">
              공개 디스커버리는 SolVamos Catalog가 원본입니다. 이 페이지는 카탈로그 API를 조회합니다.
            </p>
          </div>
          <a
            href={marketplaceUrl}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant/40 px-4 py-2 text-sm hover:bg-surface-container-high"
          >
            <ExternalLink className="h-4 w-4" /> Marketplace
          </a>
          <a
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-outline-variant/40 px-4 py-2 text-sm hover:bg-surface-container-high"
          >
            <LogIn className="h-4 w-4" /> Studio 로그인
          </a>
        </header>

        <section className="glass-panel mb-7 rounded-xl p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-solana-green">
                Catalog API {network ? `· ${network}` : ''}
              </p>
              <p className="mt-1 break-all font-mono text-sm">{catalogUrl}</p>
            </div>
            <div className="flex gap-2">
              <CopyButton
                copied={copied === 'catalog'}
                onClick={() => copy(catalogUrl, 'catalog')}
              />
              <a
                href={catalogUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-surface-container-high px-3 py-2 text-sm hover:bg-surface-container-highest"
              >
                JSON 열기 <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-on-surface-variant">
            <RefreshCw className="h-5 w-5 animate-spin" /> 카탈로그 불러오는 중…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-error/30 bg-error/10 p-5 text-error">{error}</div>
        ) : entries.length === 0 ? (
          <div className="glass-panel rounded-xl p-10 text-center text-on-surface-variant">
            공개된 에이전트가 없습니다.
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {entries.map((entry) => {
              const invokeUrl =
                entry.publicInvokeUrl ||
                `${window.location.origin}/api/agents/${encodeURIComponent(entry.agentId)}/invoke`;
              const cardUrl =
                entry.agentCardUrl ||
                `${window.location.origin}/api/agents/${encodeURIComponent(entry.agentId)}/agent-card`;
              const callExample =
                entry.feeUsdc > 0
                  ? `pay fetch "${invokeUrl}?prompt=${encodeURIComponent('안녕하세요')}"`
                  : `curl -X POST "${invokeUrl}" -H "Content-Type: application/json" -d "{\\"prompt\\":\\"안녕하세요\\"}"`;
              return (
                <article key={entry.catalogId} className="glass-panel rounded-xl p-5">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="rounded-lg bg-primary/10 p-2.5">
                        <Bot className="h-6 w-6 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate text-xl font-semibold">{entry.name}</h2>
                        <p className="mt-1 text-xs text-on-surface-variant">
                          {entry.role} · {entry.feeUsdc} {entry.token || 'USDC'} / call
                        </p>
                      </div>
                    </div>
                  </div>
                  <p className="mb-5 text-sm leading-relaxed text-on-surface-variant">
                    {entry.description}
                  </p>

                  <EndpointRow
                    label={entry.feeUsdc > 0 ? 'Paid Invoke API (x402/MPP)' : 'Invoke API (free)'}
                    value={invokeUrl}
                    copied={copied === `invoke-${entry.agentId}`}
                    onCopy={() => copy(invokeUrl, `invoke-${entry.agentId}`)}
                  />
                  <EndpointRow
                    label="Agent Card"
                    value={cardUrl}
                    copied={copied === `card-${entry.agentId}`}
                    onCopy={() => copy(cardUrl, `card-${entry.agentId}`)}
                  />

                  <div className="mt-4 rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-outline">
                        호출 예제
                      </span>
                      <CopyButton
                        compact
                        copied={copied === `curl-${entry.agentId}`}
                        onClick={() => copy(callExample, `curl-${entry.agentId}`)}
                      />
                    </div>
                    <code className="block overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-on-surface-variant">
                      {callExample}
                    </code>
                  </div>
                  {entry.feeUsdc > 0 && (
                    <p className="mt-3 text-xs text-outline">
                      Devnet/Localnet USDC 온체인(또는 sandbox) 결제입니다. `pay fetch`가
                      HTTP 402(x402/MPP) 결제 승인·재시도를 처리합니다.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function EndpointRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-outline">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-container-lowest px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <CopyButton compact copied={copied} onClick={onCopy} />
      </div>
    </div>
  );
}

function CopyButton({
  copied,
  onClick,
  compact = false,
}: {
  copied: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-google-blue/15 text-google-blue hover:bg-google-blue/25 ${
        compact ? 'p-2' : 'px-3 py-2 text-sm'
      }`}
      title="복사"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {!compact && (copied ? '복사됨' : '복사')}
    </button>
  );
}

