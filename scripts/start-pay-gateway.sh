#!/bin/sh
set -eu

: "${PAY_ORIGIN_URL:?PAY_ORIGIN_URL is required}"
: "${PAY_INTERNAL_SECRET:?PAY_INTERNAL_SECRET is required}"
: "${PAY_RECIPIENT:?PAY_RECIPIENT is required}"

export PROVIDER_TEMPLATE=/app/provider.template.yml
export PROVIDER_RUNTIME=/tmp/provider.yml

node <<'NODE'
const fs = require('node:fs');

const template = fs.readFileSync(process.env.PROVIDER_TEMPLATE, 'utf8');
const origin = process.env.PAY_ORIGIN_URL.replace(/\/+$/, '') + '/';
fs.writeFileSync(
  process.env.PROVIDER_RUNTIME,
  template.replace('__PAY_ORIGIN_URL__', origin),
  'utf8'
);
NODE

exec pay server start "$PROVIDER_RUNTIME" \
  --bind "0.0.0.0:${PORT:-8080}" \
  --recipient "$PAY_RECIPIENT" \
  --rpc-url "${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

