#!/bin/sh
set -eu

: "${PAY_ORIGIN_URL:?PAY_ORIGIN_URL is required}"
: "${PAY_INTERNAL_SECRET:?PAY_INTERNAL_SECRET is required}"

# Primary charge recipient = platform treasury (remainder after seller split).
# PAY_RECIPIENT remains accepted as legacy fallback when treasury unset.
PLATFORM_TREASURY_PUBKEY="${PLATFORM_TREASURY_PUBKEY:-${PAY_RECIPIENT:-}}"
: "${PLATFORM_TREASURY_PUBKEY:?PLATFORM_TREASURY_PUBKEY or PAY_RECIPIENT is required}"

export PROVIDER_TEMPLATE=/app/provider.template.yml
export PROVIDER_RUNTIME=/tmp/provider.yml
export PLATFORM_TREASURY_PUBKEY
export PLATFORM_FEE_SHARE="${PLATFORM_FEE_SHARE:-0.1}"
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
# Renders PROVIDER_TEMPLATE → $PROVIDER_OUT:
#  - per-agent feeUsdc from Studio /api/catalog (NOT a hardcoded 0.001)
#  - MPP splits: seller vault gets seller% ; treasury (operator.recipient) gets remainder
cat > /tmp/gen-provider.mjs <<'NODE'
import fs from 'node:fs';

const template = fs.readFileSync(process.env.PROVIDER_TEMPLATE, 'utf8');
const origin = process.env.PAY_ORIGIN_URL.replace(/\/+$/, '');
const outPath = process.env.PROVIDER_OUT || process.env.PROVIDER_RUNTIME;
const treasury = String(process.env.PLATFORM_TREASURY_PUBKEY || '').trim();
const share = Math.min(0.99, Math.max(0.01, Number(process.env.PLATFORM_FEE_SHARE || 0.1) || 0.1));
const sellerPercent = Math.min(99, Math.max(1, Math.round((1 - share) * 100)));

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

function formatPrice(fee) {
  return fee.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function sellerAlias(agentId) {
  return `seller_${agentId.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function endpointBlock(agentId, method, price, alias) {
  return [
    `  - method: ${method}`,
    `    path: 'v1/agents/${agentId}/invoke'`,
    `    description: 'Paid SolVamos agent invoke (${agentId}) — catalog fee, ${sellerPercent}/${100 - sellerPercent} split.'`,
    '    metering:',
    '      schemes:',
    '        - mpp-charge',
    '      splits:',
    `        - recipient: ${alias}`,
    `          percent: ${sellerPercent}`,
    '      dimensions:',
    '        - direction: usage',
    '          unit: requests',
    '          scale: 1',
    '          tiers:',
    `            - price_usd: ${price}`,
  ].join('\n');
}

async function fetchCatalogAgents() {
  const res = await fetch(`${origin}/api/catalog`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json.agents)
    ? json.agents
    : Array.isArray(json.data)
      ? json.data
      : [];
  return rows;
}

async function buildInjection() {
  const rows = await fetchCatalogAgents();
  const seen = new Set();
  const recipientLines = [];
  const endpointBlocks = [];
  let injected = 0;

  for (const row of rows) {
    const agentId = String(row.agent_id || row.agentId || '');
    const fee = Number(row.fee_usdc ?? row.feeUsdc ?? 0) || 0;
    const status = String(row.status || 'listed');
    const wallet = String(
      row.recipient_wallet || row.recipientWallet || row.publicKey || row.public_key || ''
    ).trim();

    if (!agentId || seen.has(agentId) || fee <= 0 || status !== 'listed') continue;
    if (!AGENT_ID_RE.test(agentId)) continue;
    if (!BASE58_RE.test(wallet)) {
      console.warn(`[pay-gateway] skip ${agentId}: invalid recipient wallet`);
      continue;
    }

    seen.add(agentId);
    const alias = sellerAlias(agentId);
    const price = formatPrice(fee);
    recipientLines.push(`  ${alias}:`);
    recipientLines.push(`    account: '${wallet}'`);
    recipientLines.push(`    label: 'Agent ${agentId} vault'`);
    endpointBlocks.push(endpointBlock(agentId, 'GET', price, alias));
    endpointBlocks.push(endpointBlock(agentId, 'POST', price, alias));
    injected += 1;
  }

  return {
    injected,
    recipientsYaml: recipientLines.length ? `${recipientLines.join('\n')}\n` : '',
    endpointsYaml: endpointBlocks.length ? `${endpointBlocks.join('\n\n')}\n\n` : '',
  };
}

if (!BASE58_RE.test(treasury)) {
  console.error(`[pay-gateway] invalid PLATFORM_TREASURY_PUBKEY: ${treasury}`);
  process.exit(1);
}

let injection = { injected: 0, recipientsYaml: '', endpointsYaml: '' };
try {
  injection = await buildInjection();
} catch (err) {
  console.warn(
    '[pay-gateway] catalog fetch failed — no per-agent paid routes (wildcard will not charge/proxy):',
    err?.message || err
  );
}

let out = template.replaceAll('__PAY_ORIGIN_URL__', origin + '/');
out = out.replaceAll('__PLATFORM_TREASURY__', treasury);
out = out.replace(
  /^[ \t]*# __PER_AGENT_RECIPIENTS__[^\n]*\n(?:[ \t]*#[^\n]*\n)*/m,
  injection.recipientsYaml || '  # (no paid agents listed)\n'
);
out = out.replace(
  /^[ \t]*# __PER_AGENT_ENDPOINTS__[^\n]*\n(?:[ \t]*#[^\n]*\n)*/m,
  injection.endpointsYaml || ''
);
fs.writeFileSync(outPath, out, 'utf8');
console.log(
  `[pay-gateway] provider -> ${outPath} agents=${injection.injected} seller%=${sellerPercent} treasury=${treasury.slice(0, 8)}…`
);
NODE

node /tmp/gen-provider.mjs

# ── solana identity ──────────────────────────────────────────────────────────
# pay server signs with the account named `gateway` for the current network in
# ~/.config/pay/accounts.yml. When an operator key is mounted (Secret Manager
# volume, Solana id.json format), register it as that account so the server
# uses the funded operator wallet instead of a random ephemeral key.
# Note: with native splits, USDC goes to seller vault + treasury — operator key
# is for challenge/signing (and optional fee_payer), not for holding the charge.
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
  const seed = crypto.randomBytes(32);
  const secret = Array.from(Buffer.concat([seed, seed]));
  fs.writeFileSync(idPath, JSON.stringify(secret));
  console.log('[pay-gateway] wrote bootstrap solana identity', idPath);
}
NODE

if [ -n "${PAY_OPERATOR_KEY_FILE:-}" ] && [ -f "${PAY_OPERATOR_KEY_FILE:-}" ]; then
  echo "[pay-gateway] operator key mounted; skipping pay setup"
else
  npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay setup --yes >/tmp/pay-setup.log 2>&1 \
    || echo "[pay-gateway] pay setup skipped/failed (see /tmp/pay-setup.log)"
fi

# ── ensure USDC ATAs for split recipients ────────────────────────────────────
# pay server exits if any metering.splits recipient lacks a USDC ATA.
# Operator pays rent; ATA owner = seller vault / treasury.
if [ -n "${PAY_OPERATOR_KEY_FILE:-}" ] && [ -f "${PAY_OPERATOR_KEY_FILE:-}" ]; then
  echo "[pay-gateway] ensuring USDC ATAs for split recipients…"
  if ! node /app/ensure-pay-atas.mjs; then
    echo "[pay-gateway] ERROR: ATA ensure failed — pay server would crash on boot"
    echo "[pay-gateway] Top up operator wallet with devnet SOL, then redeploy."
    exit 1
  fi
else
  echo "[pay-gateway] WARN: no PAY_OPERATOR_KEY_FILE — skipping ATA ensure (pay may fail if ATAs missing)"
fi

echo "[pay-gateway] starting on 0.0.0.0:${PORT:-8080} -> origin ${PAY_ORIGIN_URL} treasury=${PLATFORM_TREASURY_PUBKEY}"
# shellcheck disable=SC2086
# --recipient = platform treasury (MPP primary / remainder after seller split)
npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay ${SANDBOX_ARGS} server start "$PROVIDER_RUNTIME" \
  --bind "0.0.0.0:${PORT:-8080}" \
  --recipient "$PLATFORM_TREASURY_PUBKEY" \
  --rpc-url "$RPC_URL" &
PAY_PID=$!

# ── pricing refresher ────────────────────────────────────────────────────────
if [ "$PRICING_REFRESH_SECONDS" -gt 0 ] 2>/dev/null; then
  (
    while true; do
      sleep "$PRICING_REFRESH_SECONDS"
      if PROVIDER_OUT=/tmp/provider.next.yml node /tmp/gen-provider.mjs >/dev/null 2>&1; then
        if ! cmp -s /tmp/provider.next.yml "$PROVIDER_RUNTIME"; then
          echo "[pay-gateway] agent pricing/recipients changed — restarting to reload provider config"
          kill "$PAY_PID" 2>/dev/null || true
          exit 0
        fi
      fi
    done
  ) &
fi

wait "$PAY_PID"
