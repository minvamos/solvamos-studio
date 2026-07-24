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

node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const template = fs.readFileSync(process.env.PROVIDER_TEMPLATE, 'utf8');
const origin = process.env.PAY_ORIGIN_URL.replace(/\/+$/, '') + '/';
fs.writeFileSync(
  process.env.PROVIDER_RUNTIME,
  template.replace('__PAY_ORIGIN_URL__', origin),
  'utf8'
);

// Ensure a local Solana identity exists for pay server validation.
const idPath = path.join(process.env.HOME, '.config', 'solana', 'id.json');
if (!fs.existsSync(idPath)) {
  // 64-byte secret key placeholder: pay/setup may overwrite; keep file present.
  const seed = crypto.randomBytes(32);
  // Minimal ed25519-looking 64-byte array (seed||pub) — pay setup prefers its own.
  const secret = Array.from(Buffer.concat([seed, seed]));
  fs.writeFileSync(idPath, JSON.stringify(secret));
  console.log('[pay-gateway] wrote bootstrap solana identity', idPath);
}
NODE

# Prefetch / refresh pay identity when possible (ignore failures — server may still boot).
npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay setup --yes >/tmp/pay-setup.log 2>&1 \
  || echo "[pay-gateway] pay setup skipped/failed (see /tmp/pay-setup.log)"

echo "[pay-gateway] starting on 0.0.0.0:${PORT:-8080} -> origin ${PAY_ORIGIN_URL}"
# shellcheck disable=SC2086
exec npx --yes --package "@solana/pay@${PAY_PKG_VERSION}" pay ${SANDBOX_ARGS} server start "$PROVIDER_RUNTIME" \
  --bind "0.0.0.0:${PORT:-8080}" \
  --recipient "$PAY_RECIPIENT" \
  --rpc-url "$RPC_URL"
