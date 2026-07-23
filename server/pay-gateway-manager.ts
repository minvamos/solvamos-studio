/**
 * Local Lab pay.sh process manager.
 *
 * Keeps exactly one gateway on :1402 and restarts only that child process when
 * Studio switches localnet <-> devnet. Deliberately disabled in production /
 * Cloud Run because process-local state cannot coordinate multiple instances.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config, type PaymentNetwork } from './config.js';

export type PayGatewayStatus = {
  managed: boolean;
  state: 'disabled' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  network: PaymentNetwork | null;
  pid: number | null;
  error: string | null;
  recentLogs: string[];
};

let child: ChildProcessWithoutNullStreams | null = null;
let state: PayGatewayStatus['state'] = config.payGatewayManaged ? 'stopped' : 'disabled';
let activeNetwork: PaymentNetwork | null = null;
let lastError: string | null = null;
let recentLogs: string[] = [];
let transition: Promise<PayGatewayStatus> | null = null;
let transitionNetwork: PaymentNetwork | null = null;

function log(line: string) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  recentLogs = [...recentLogs, clean].slice(-20);
  console.log(`[pay gateway] ${clean}`);
}

function resolvePayCli(): string {
  const configured = process.env.PAY_CLI_PATH?.trim();
  if (configured) return configured;
  const windows = path.join(process.cwd(), 'tools', 'pay', 'pay.exe');
  if (fs.existsSync(windows)) return windows;
  const unix = path.join(process.cwd(), 'tools', 'pay', 'pay');
  if (fs.existsSync(unix)) return unix;
  return 'pay';
}

function managedProviderPath(network: PaymentNetwork): string {
  const source =
    network === 'localnet'
      ? 'pay/solvamos-provider.yml'
      : 'pay/solvamos-provider.devnet.yml';
  const sourcePath = path.join(process.cwd(), source);
  const runtimeDir = path.join(process.cwd(), '.data');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimePath = path.join(runtimeDir, `paysh-managed-${network}.yml`);
  const yaml = fs
    .readFileSync(sourcePath, 'utf8')
    .replace(
      /(\nrouting:\s*\n\s*type:\s*proxy\s*\n\s*url:)\s*\S+/,
      `$1 http://127.0.0.1:${config.port}/`
    );
  fs.writeFileSync(runtimePath, yaml, 'utf8');
  return runtimePath;
}

function commandFor(network: PaymentNetwork): string[] {
  const yaml = managedProviderPath(network);
  return [
    ...(network === 'localnet' ? ['--sandbox'] : []),
    'server',
    'start',
    yaml,
    '--bind',
    '127.0.0.1:1402',
  ];
}

export function payGatewayStatus(): PayGatewayStatus {
  return {
    managed: config.payGatewayManaged,
    state,
    network: activeNetwork,
    pid: child?.pid || null,
    error: lastError,
    recentLogs,
  };
}

async function stopChild(): Promise<void> {
  if (!child) {
    state = 'stopped';
    activeNetwork = null;
    return;
  }
  state = 'stopping';
  const current = child;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    current.once('close', finish);
    current.kill('SIGTERM');
    setTimeout(() => {
      if (current.exitCode === null) current.kill('SIGKILL');
      finish();
    }, 3_000).unref();
  });
  if (child === current) child = null;
  state = 'stopped';
  activeNetwork = null;
}

async function waitUntilReady(current: ChildProcessWithoutNullStreams): Promise<void> {
  // First Surfpool wallet funding can be slow on Windows.
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.PAY_GATEWAY_READY_TIMEOUT_MS || 120_000)
  );
  const deadline = Date.now() + timeoutMs;
  let lastHealthError = '';
  // Give bind/configuration errors time to terminate before probing an old process
  // that may already own the same port.
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (Date.now() < deadline) {
    if (current.exitCode !== null || current.killed) {
      throw new Error(
        `pay gateway exited before ready (code=${current.exitCode}). ${recentLogs.slice(-3).join(' | ')}`
      );
    }
    try {
      const response = await fetch(`${config.payGatewayUrl}/v1/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok && current.exitCode === null && !current.killed) return;
      lastHealthError = `health HTTP ${response.status}`;
    } catch (err: any) {
      lastHealthError = err?.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`pay gateway readiness timeout: ${lastHealthError}`);
}

async function performStart(network: PaymentNetwork): Promise<PayGatewayStatus> {
  if (!config.payGatewayManaged) {
    throw new Error('Managed pay gateway is disabled (PAY_GATEWAY_MANAGED=false or production)');
  }
  if (!config.payInternalSecret) {
    throw new Error('PAY_INTERNAL_SECRET is required to start the managed pay gateway');
  }

  await stopChild();
  state = 'starting';
  lastError = null;
  recentLogs = [];

  const executable = resolvePayCli();
  const args = commandFor(network);
  log(`starting ${network}: ${executable} ${args.join(' ')}`);
  const current = spawn(executable, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PAY_INTERNAL_SECRET: config.payInternalSecret,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = current;
  activeNetwork = network;
  current.stdout.on('data', (chunk) => log(String(chunk)));
  current.stderr.on('data', (chunk) => log(String(chunk)));
  current.on('error', (err) => {
    lastError = err.message;
    state = 'error';
  });
  current.on('close', (code) => {
    if (child !== current) return;
    child = null;
    if (state !== 'stopping') {
      lastError = `pay gateway exited (code=${code})`;
      state = 'error';
    }
  });

  try {
    await waitUntilReady(current);
    state = 'ready';
    log(`ready on ${config.payGatewayUrl}`);
    return payGatewayStatus();
  } catch (err: any) {
    lastError = err?.message || String(err);
    state = 'error';
    current.kill('SIGTERM');
    throw err;
  }
}

/** Serializes mode changes so rapid UI clicks cannot launch two gateways. */
export async function restartManagedPayGateway(
  network: PaymentNetwork
): Promise<PayGatewayStatus> {
  if (state === 'ready' && activeNetwork === network && child?.exitCode === null) {
    return payGatewayStatus();
  }
  if (transition) {
    if (transitionNetwork === network) return transition;
    await transition.catch(() => undefined);
  }
  transitionNetwork = network;
  transition = performStart(network).finally(() => {
    transition = null;
    transitionNetwork = null;
  });
  return transition;
}

export async function stopManagedPayGateway(): Promise<void> {
  if (transition) await transition.catch(() => undefined);
  await stopChild();
}

