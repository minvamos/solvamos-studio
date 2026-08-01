#!/usr/bin/env node
/**
 * Install official pay.sh CLI into tools/pay/ for local Lab.
 * Cross-platform (macOS / Linux / Windows) — uses @solana/pay package installer.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const destDir = path.join(root, 'tools', 'pay');
const isWin = process.platform === 'win32';
const destBin = path.join(destDir, isWin ? 'pay.exe' : 'pay');

function log(msg) {
  console.log(`[pay:install] ${msg}`);
}

fs.mkdirSync(destDir, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solvamos-pay-'));
try {
  log('Installing @solana/pay (downloads platform binary)…');
  execSync('npm install @solana/pay --no-save --no-fund --no-audit', {
    cwd: tmp,
    stdio: 'inherit',
    env: process.env,
  });

  const pkgRoot = path.join(tmp, 'node_modules', '@solana', 'pay');
  if (!fs.existsSync(pkgRoot)) {
    throw new Error(`@solana/pay not found under ${tmp}`);
  }

  // Ensure native CLI is downloaded (preferUnplugged / install.cjs).
  const installJs = path.join(pkgRoot, 'install.cjs');
  if (fs.existsSync(installJs)) {
    execFileSync(process.execPath, [installJs], { cwd: pkgRoot, stdio: 'inherit' });
  }

  const candidates = [
    path.join(pkgRoot, 'bin', isWin ? 'pay.exe' : 'pay'),
    path.join(pkgRoot, 'bin', 'pay'),
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) {
    throw new Error(
      `pay binary missing after install. Looked in:\n  ${candidates.join('\n  ')}`
    );
  }

  fs.copyFileSync(src, destBin);
  if (!isWin) fs.chmodSync(destBin, 0o755);

  log(`Installed: ${destBin}`);
  execFileSync(destBin, ['--version'], { stdio: 'inherit' });
  log('Next: export PAY_INTERNAL_SECRET=dev-pay-internal');
  log('      npm run pay:gateway:devnet   # or npm run dev (managed :1402)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
