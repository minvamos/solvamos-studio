/**
 * Outbound pay.sh client — official `pay` CLI for 402 handshake.
 * Windows: prefer `pay fetch` (built-in). POST needs system curl visible to pay CLI.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config, payCliUsesSandbox } from './config.js';

export type PayCurlResult = {
  ok: boolean;
  status: number;
  body: string;
  json?: any;
  error?: string;
  usedPayCli: boolean;
};

function resolvePayCli(): string | null {
  const fromEnv = process.env.PAY_CLI_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const localWin = path.join(process.cwd(), 'tools', 'pay', 'pay.exe');
  if (fs.existsSync(localWin)) return localWin;

  const localUnix = path.join(process.cwd(), 'tools', 'pay', 'pay');
  if (fs.existsSync(localUnix)) return localUnix;

  return 'pay';
}

/** Build gateway invoke URL for an agent. */
export function gatewayInvokeUrl(agentId: string): string {
  const base = (config.payGatewayUrl || 'http://127.0.0.1:1402').replace(/\/$/, '');
  return `${base}/v1/agents/${agentId}/invoke`;
}

function spawnPay(args: string[], timeoutMs: number): Promise<PayCurlResult> {
  const cli = resolvePayCli();
  if (!cli) {
    return Promise.resolve({
      ok: false,
      status: 0,
      body: '',
      usedPayCli: false,
      error: 'pay CLI not found — run npm run pay:install or set PAY_CLI_PATH',
    });
  }

  const payDir = path.dirname(cli === 'pay' ? process.cwd() : cli);
  const pathExtra = [payDir, path.join(process.cwd(), 'tools', 'bin'), 'C:\\Windows\\System32']
    .filter(Boolean)
    .join(path.delimiter);

  return new Promise((resolve) => {
    const child = spawn(cli, args, {
      env: {
        ...process.env,
        PATH: `${pathExtra}${path.delimiter}${process.env.PATH || ''}`,
        Path: `${pathExtra}${path.delimiter}${process.env.Path || process.env.PATH || ''}`,
      },
      windowsHide: true,
      cwd: payDir !== process.cwd() ? payDir : undefined,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: 0,
        body: stdout,
        usedPayCli: true,
        error: `pay CLI timed out after ${timeoutMs}ms: ${stderr.slice(0, 200)}`,
      });
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 0,
        body: '',
        usedPayCli: true,
        error: err.message || 'failed to spawn pay CLI',
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: any;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        /* plain text ok */
      }
      const ok = code === 0 && !json?.error;
      resolve({
        ok,
        status: ok ? 200 : typeof json?.error === 'string' ? Number(json.error) || 500 : code === 0 ? 502 : 500,
        body: stdout || stderr,
        json,
        usedPayCli: true,
        error: ok
          ? undefined
          : json?.message || stderr.slice(0, 400) || `pay exit ${code}`,
      });
    });
  });
}

/**
 * Call a paywalled URL via official pay CLI (sandbox 402 + settlement).
 * Uses GET + ?prompt= with `pay fetch` (works on Windows without external curl).
 */
export async function payCurl(opts: {
  method?: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  sandbox?: boolean;
}): Promise<PayCurlResult> {
  const sandbox = opts.sandbox ?? payCliUsesSandbox();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const prefix = sandbox ? ['--sandbox'] : [];

  const promptFromBody =
    opts.body && typeof opts.body === 'object' && opts.body !== null && 'prompt' in (opts.body as any)
      ? String((opts.body as any).prompt)
      : undefined;

  // Built-in client — preferred on Windows
  if (promptFromBody || !opts.body) {
    const u = new URL(opts.url);
    if (promptFromBody) u.searchParams.set('prompt', promptFromBody);
    if (opts.body && typeof opts.body === 'object' && (opts.body as any).enableA2A != null) {
      u.searchParams.set('enableA2A', String((opts.body as any).enableA2A));
    }
    const args = [...prefix, 'fetch', u.toString()];
    for (const [k, v] of Object.entries(opts.headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    return spawnPay(args, timeoutMs);
  }

  // POST body via curl pass-through (requires curl on PATH as pay finds it)
  const args = [
    ...prefix,
    'curl',
    '-sS',
    '-X',
    (opts.method || 'POST').toUpperCase(),
    opts.url,
    '-H',
    'Content-Type: application/json',
    '-d',
    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  ];
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  return spawnPay(args, timeoutMs);
}

/** Plain HTTP (no payment) — free peers / internal. */
export async function plainPostJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<PayCurlResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return {
      ok: res.ok,
      status: res.status,
      body: text,
      json,
      usedPayCli: false,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      body: '',
      usedPayCli: false,
      error: err?.message || 'fetch failed',
    };
  }
}
