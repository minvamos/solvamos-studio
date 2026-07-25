/**
 * pay.sh API shim for Devnet buyers.
 *
 * The official `pay` CLI checks buyer stablecoin balances through its hosted
 * backend (https://api.pay.sh/v1/balance/stablecoins) before paying an MPP
 * challenge — and that backend only knows `mainnet` and `sandbox`. On Devnet
 * the check always reports 0, so `pay fetch` refuses to pay even when the
 * wallet holds Devnet USDC.
 *
 * This router answers the balance query from the Devnet chain directly and
 * transparently proxies every other pay.sh API call upstream. External buyers
 * opt in with a single env var:
 *
 *   PAY_API_URL=https://<studio-host>/payapi pay fetch "<gateway invoke url>"
 */
import express from 'express';

import { config } from './config.js';

const UPSTREAM = 'https://api.pay.sh';

type StablecoinBalance = {
  symbol: string;
  mint: string;
  decimals: number;
  raw_amount: string;
  ui_amount: number;
};

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.solanaRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function usdcBalance(address: string): Promise<StablecoinBalance> {
  const result = await rpc('getTokenAccountsByOwner', [
    address,
    { mint: config.usdcMint },
    { encoding: 'jsonParsed' },
  ]);
  let raw = 0n;
  for (const entry of result?.value ?? []) {
    raw += BigInt(entry.account.data.parsed.info.tokenAmount.amount || '0');
  }
  return {
    symbol: 'USDC',
    mint: config.usdcMint,
    decimals: 6,
    raw_amount: raw.toString(),
    // The pay CLI requires a JSON number here (a string parses as no balance).
    ui_amount: Number(raw) / 1e6,
  };
}

export const payApiRouter = express.Router();

payApiRouter.get('/v1/balance/stablecoins', async (req, res) => {
  const address = typeof req.query.address === 'string' ? req.query.address : '';
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    res.status(400).json({ error: 'missing or invalid `address`' });
    return;
  }
  try {
    const balance = await usdcBalance(address);
    res.json({
      address,
      // Echo the network the CLI asked for (it hardcodes `mainnet`); the
      // amounts themselves come from the chain this Studio settles on.
      network: typeof req.query.network === 'string' ? req.query.network : config.paymentNetwork,
      balances: [balance],
    });
  } catch (err: any) {
    res.status(502).json({ error: `devnet balance lookup failed: ${err?.message || err}` });
  }
});

/** Pass every other pay.sh API call through unchanged. */
payApiRouter.use(async (req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM}${req.originalUrl.replace(/^\/payapi/, '')}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        accept: (req.headers.accept as string) || 'application/json',
        ...(req.headers.authorization ? { authorization: req.headers.authorization as string } : {}),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res
      .status(upstream.status)
      .set('content-type', upstream.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err: any) {
    res.status(502).json({ error: `pay.sh upstream proxy failed: ${err?.message || err}` });
  }
});
