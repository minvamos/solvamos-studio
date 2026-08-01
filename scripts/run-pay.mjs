#!/usr/bin/env node
/** Run local tools/pay binary (or PAY_CLI_PATH / PATH pay) with forwarded args. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function resolvePay() {
  const fromEnv = process.env.PAY_CLI_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(root, 'tools', 'pay', isWin ? 'pay.exe' : 'pay');
  if (fs.existsSync(local)) return local;
  return 'pay';
}

const cli = resolvePay();
const args = process.argv.slice(2);
if (args[0] === 'fetch' && args.length === 1) {
  console.error('Usage: npm run pay:fetch -- "<gateway-invoke-url>?prompt=..."');
  process.exit(2);
}

const result = spawnSync(cli, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: isWin && cli === 'pay',
});

if (result.error) {
  console.error(
    `[run-pay] failed to spawn "${cli}": ${result.error.message}\n` +
      'Run: npm run pay:install'
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
