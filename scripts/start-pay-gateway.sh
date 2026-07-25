#!/bin/sh
set -eu

: "${PAY_ORIGIN_URL:?PAY_ORIGIN_URL is required}"
: "${PAY_INTERNAL_SECRET:?PAY_INTERNAL_SECRET is required}"
: "${PAY_RECIPIENT:?PAY_RECIPIENT is required}"

export PROVIDER_TEMPLATE=/app/provider.template.yml
export PROVIDER_RUNTIME=/tmp/provider.yml
export HOME="${HOME:-/tmp/pay-home}"
export npm_config_cache="${npm_config_cache:-/tmp/pay-home/.npm}"
mkdir -p "$HOME" "$npm_config_cache" "$HOME/.config/solana"

PAY_PKG_VERSION="${PAY_PKG_VERSION:-1.0.23}"
# How often the background refresher re-reads catalog pricing (0 disables).
PRICING_REFRESH_SECONDS="${PAY_PRICING_REFRESH_SECONDS:-600}"

# Decide mode early — sandbox needs Surfpool RPC, not public Devnet.
PAYMENT_NETWORK="${PAYMENT_NETWORK:-devnet}"
PAY_SANDBOX="${PAY_SANDBOX:-0}"
SANDBOX_ARGS=""
RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

if [ "$PAY_SANDBOX" = "1" ] || [ "$PAYMENT_NETWORK" = "localnet" ]; then
  SANDBOX_ARGS="--sandbox"
  # Public Devnet does not support Surfpool funding RPCs used by pay --sandbox.
  if echo "$RPC_URL" | grep -Eqi 'api\.devnet\.solana\.com|api\.mainnet'; then
    RPC_URL="${PAYSH_SANDBOX_RPC:-https://402.surfnet.dev:8899}"
  fi
  echo "[pay-gateway] sandbox/localnet mode enabled rpc=${RPC_URL}"
fi
export SOLANA_RPC_URL="$RPC_URL"

# ── provider config generator ────────────────────────────────────────────────
# Renders PROVIDER_TEMPLATE → $PROVIDER_OUT, replacing __PAY_ORIGIN_URL__ and
# injecting per-agent priced endpoints from the live Studio catalog so each
# agent is metered at its own feeUsdc (falls back to the static generic price).
cat > /tmp/gen-provider.mjs <<'NODE'
import fs from 'node:fs';

const template = fs.readFileSync(process.env.PROVIDER_TEMPLATE, 'utf8');
const origin = process.env.PAY_ORIGIN_URL.replace(/\/+$/, '');
const outPath = process.env.PROVIDER_OUT || process.env.PROVIDER_RUNTIME;

function endpointBlock(agentId, method, price) {
  return [
    `  - method: ${method}`,
    `    path: 'v1/agents/${agentId}/invoke'`,
    `    description: 'Paid SolVamos agent invoke (${agentId}).'`,
    '    metering:',
    '      dimensions:',
    '        - direction: usage',
    '          unit: requests',
    '          scale: 1',
    '          tiers:',
    `            - price_usd: ${price}`,
  ].join('\n');
}

async function fetchPerAgentEndpoints() {
  try {
    const res = await fetch(`${origin}/api/catalog`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json.agents) ? json.agents : Array.isArray(json.data) ? json.data : [];
    const seen = new Set();
    const blocks = [];
    for (const row of rows) {
      const agentId = String(row.agent_id || row.agentId || '');
      const fee = Number(row.fee_usdc ?? row.feeUsdc ?? 0) || 0;
      const status = String(row.status || 'listed');
      if (!agentId || seen.has(agentId) || fee <= 0 || status !== 'listed') continue;
      // Keep YAML injection-safe: agent ids are slug-like.
      if (!/^[A-Za-z0-9_-]+$/.test(agentId)) continue;
      seen.add(agentId);
      const price = fee.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      blocks.push(endpointBlock(agentId, 'GET', price));
      blocks.push(endpointBlock(agentId, 'POST', price));
    }
    return blocks.join('\n\n');
  } catch (err) {
    console.warn('[pay-gateway] catalog fetch failed — static pricing only:', err?.message || err);
    return '';
  }
}

const perAgent = await fetchPerAgentEndpoints();
let out = template.replaceAll('__PAY_ORIGIN_URL__', origin + '/');
out = out.replace(
  /^[ \t]*# __PER_AGENT_ENDPOINTS__[^\n]*\n(?:[ \t]*#[^\n]*\n)*/m,
  perAgent ? `${perAgent}\n\n` : ''
);
fs.writeFileSync(outPath, out, 'utf8');
console.log(`[pay-gateway] provider config -> ${outPath} (${perAgent ? 'per-agent pricing' : 'static pricing'})`);
NODE

node /tmp/gen-provider.mjs

# ── solana identity ──────────────────────────────────────────────────────────
# pay server signs with the account named `gateway` for the current network in
# ~/.config/pay/accounts.yml. When an operator key is mounted (Secret Manager
# volume, Solana id.json format), register it as that account so the server
# uses the funded operator wallet instead of a random ephemeral key.
node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const idPath = path.join(process.env.HOME, '.config', 'solana', 'id.json');
const operatorKeyFile = process.env.PAY_OPERATOR_KEY_FILE || '';
const network = (process.env.PAYMENT_NETWORK || 'devnet').toLowerCase();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

if (operatorKeyFile && fs.existsSync(operatorKeyFile)) {
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeyFile, 'utf8')));
  if (secret.length !== 64) throw new Error(`operator key must be 64 bytes, got ${secret.length}`);
  const secretB58 = base58(Buffer.from(secret));
  const pubkeyB58 = base58(Buffer.from(secret.slice(32)));

  const payDir = path.join(process.env.HOME, '.config', 'pay');
  fs.mkdirSync(payDir, { recursive: true });
  const accountsYml = [
    'version: 2',
    'accounts:',
    `  ${network}:`,
    '    gateway:',
    '      keystore: ephemeral',
    '      active: true',
    '      auth_required: false',
    `      pubkey: '${pubkeyB58}'`,
    `      secret_key_b58: '${secretB58}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(payDir, 'accounts.yml'), accountsYml);
  fs.copyFileSync(operatorKeyFile, idPath);
  console.log(`[pay-gateway] operator key registered as pay account '${network}/gateway' (${pubkeyB58})`);
} else if (!fs.existsSync(idPath)) {
  // 64-byte secret key placeholder: pay/setup may overwrite; keep file present.
  const seed = crypto.randomBytes(32);
  // Minimal ed25519-looking 64-byte array (seed||pub) — pay setup prefers its own.
  const secret = Array.from(Buffer.concat([seed, seed]));
  fs.writeFileSync(idPath, JSON.stringify(secret));
  console.log('[pay-gateway] wrote bootstrap solana identity', idPath);
}
NODE

if [ -n "${PAY_OPERATOR_KEY_FILE:-}" ] && [ -f "${PAY_OPERATOR_KEY_FILE:-}" ]; then
  # Mounted operator key already installed above — do NOT run pay setup, it may
  # replace the funded identity with a fresh (unfunded) one.
  echo "[pay-gateway] operator key mounted; skipping pay setup"
else
  # Prefetch / refresh pay identity when possible (ignore failures — server may still boot).
  npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay setup --yes >/tmp/pay-setup.log 2>&1 \
    || echo "[pay-gateway] pay setup skipped/failed (see /tmp/pay-setup.log)"
fi

echo "[pay-gateway] starting on 0.0.0.0:${PORT:-8080} -> origin ${PAY_ORIGIN_URL}"
# shellcheck disable=SC2086
npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay ${SANDBOX_ARGS} server start "$PROVIDER_RUNTIME" \
  --bind "0.0.0.0:${PORT:-8080}" \
  --recipient "$PAY_RECIPIENT" \
  --rpc-url "$RPC_URL" &
PAY_PID=$!

# ── pricing refresher ────────────────────────────────────────────────────────
# Re-render the provider config periodically; when agent pricing changes the
# container exits so Cloud Run boots a fresh instance with the new prices.
if [ "$PRICING_REFRESH_SECONDS" -gt 0 ] 2>/dev/null; then
  (
    while true; do
      sleep "$PRICING_REFRESH_SECONDS"
      if PROVIDER_OUT=/tmp/provider.next.yml node /tmp/gen-provider.mjs >/dev/null 2>&1; then
        if ! cmp -s /tmp/provider.next.yml "$PROVIDER_RUNTIME"; then
          echo "[pay-gateway] agent pricing changed — restarting to reload provider config"
          kill "$PAY_PID" 2>/dev/null || true
          exit 0
        fi
      fi
    done
  ) &
fi

wait "$PAY_PID"
