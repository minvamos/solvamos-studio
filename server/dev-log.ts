/**
 * In-process developer log ring buffer.
 * Captures structured serverLog() calls + console.* for the Dev Logs UI.
 */

import fs from 'fs';
import { dataFile, ensureDataDir } from './data-paths.js';

export type DevLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DevLogEntry = {
  id: string;
  ts: string;
  level: DevLogLevel;
  tag: string;
  message: string;
  meta?: unknown;
};

const MAX = Math.max(200, Number(process.env.DEV_LOG_BUFFER_SIZE || 2500) || 2500);
const buffer: DevLogEntry[] = [];
let seq = 0;
let installed = false;

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

function persistBestEffort() {
  try {
    ensureDataDir();
    const file = dataFile('dev-logs.json');
    fs.writeFileSync(file, JSON.stringify(buffer.slice(-500), null, 0), 'utf8');
  } catch {
    /* ignore */
  }
}

function pushEntry(entry: DevLogEntry) {
  buffer.push(entry);
  while (buffer.length > MAX) buffer.shift();
  if (buffer.length % 25 === 0) persistBestEffort();
}

function parseConsoleArgs(args: unknown[]): { tag: string; message: string; meta?: unknown } {
  if (!args.length) return { tag: 'console', message: '' };
  const first = args[0];
  if (typeof first === 'string') {
    const m = first.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      return {
        tag: m[1],
        message: m[2] || first,
        meta: args.length > 1 ? (args.length === 2 ? args[1] : args.slice(1)) : undefined,
      };
    }
    return {
      tag: 'console',
      message: first,
      meta: args.length > 1 ? (args.length === 2 ? args[1] : args.slice(1)) : undefined,
    };
  }
  try {
    return { tag: 'console', message: JSON.stringify(first), meta: args.slice(1) };
  } catch {
    return { tag: 'console', message: String(first) };
  }
}

export function serverLog(
  level: DevLogLevel,
  tag: string,
  message: string,
  meta?: unknown
): DevLogEntry {
  const entry: DevLogEntry = {
    id: `log_${Date.now().toString(36)}_${(++seq).toString(36)}`,
    ts: new Date().toISOString(),
    level,
    tag,
    message,
    meta,
  };
  pushEntry(entry);
  const line = `[${tag}] ${message}`;
  const printer =
    level === 'error'
      ? original.error
      : level === 'warn'
        ? original.warn
        : level === 'debug'
          ? original.debug
          : original.info;
  if (meta !== undefined) printer(line, meta);
  else printer(line);
  return entry;
}

/** Hook console.* so existing warn/error paths show up in Dev Logs. */
export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  const wrap =
    (level: DevLogLevel, fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      try {
        const parsed = parseConsoleArgs(args);
        pushEntry({
          id: `log_${Date.now().toString(36)}_${(++seq).toString(36)}`,
          ts: new Date().toISOString(),
          level,
          tag: parsed.tag,
          message: parsed.message,
          meta: parsed.meta,
        });
      } catch {
        /* never break console */
      }
      fn(...args);
    };

  console.log = wrap('info', original.log) as typeof console.log;
  console.info = wrap('info', original.info) as typeof console.info;
  console.warn = wrap('warn', original.warn) as typeof console.warn;
  console.error = wrap('error', original.error) as typeof console.error;
  console.debug = wrap('debug', original.debug) as typeof console.debug;

  serverLog('info', 'dev-log', `Console capture installed (buffer=${MAX})`);
}

export function listDevLogs(opts?: {
  level?: DevLogLevel | 'all';
  tag?: string;
  q?: string;
  limit?: number;
}): DevLogEntry[] {
  let rows = buffer.slice();
  if (opts?.level && opts.level !== 'all') {
    rows = rows.filter((r) => r.level === opts.level);
  }
  if (opts?.tag) {
    const t = opts.tag.toLowerCase();
    rows = rows.filter((r) => r.tag.toLowerCase().includes(t));
  }
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.message.toLowerCase().includes(q) ||
        r.tag.toLowerCase().includes(q) ||
        JSON.stringify(r.meta ?? '')
          .toLowerCase()
          .includes(q)
    );
  }
  const limit = Math.min(Math.max(opts?.limit || 300, 1), MAX);
  return rows.slice(-limit).reverse();
}

export function clearDevLogs(): number {
  const n = buffer.length;
  buffer.length = 0;
  persistBestEffort();
  serverLog('info', 'dev-log', 'Developer log buffer cleared');
  return n;
}

export function devLogStats() {
  const byLevel: Record<string, number> = {};
  for (const r of buffer) byLevel[r.level] = (byLevel[r.level] || 0) + 1;
  return { total: buffer.length, max: MAX, byLevel };
}
