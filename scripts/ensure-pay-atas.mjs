/**
 * Ensure USDC Associated Token Accounts exist for pay.sh split recipients.
 *
 * pay server validates ATAs at boot and exits if any split recipient lacks one.
 * Operator key pays rent; ATA owner = seller vault / treasury pubkey.
 *
 * Env:
 *   PAY_OPERATOR_KEY_FILE  Solana id.json (64-byte secret)
 *   PROVIDER_RUNTIME       rendered provider.yml (recipients.account lines)
 *   PLATFORM_TREASURY_PUBKEY
 *   SOLANA_RPC_URL
 *   USDC_MINT              optional (default: network mint)
 *   PAYMENT_NETWORK        localnet|devnet|mainnet-beta
 */
import fs from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function defaultMint(network) {
  if (process.env.USDC_MINT) return process.env.USDC_MINT;
  const n = String(network || 'devnet').toLowerCase();
  if (n === 'mainnet' || n === 'mainnet-beta') return MAINNET_USDC;
  return DEVNET_USDC;
}

function loadOperator() {
  const path = process.env.PAY_OPERATOR_KEY_FILE || '';
  if (!path || !fs.existsSync(path)) {
    throw new Error('PAY_OPERATOR_KEY_FILE missing — cannot create ATAs');
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8')));
  if (secret.length < 64) throw new Error(`operator key must be 64 bytes, got ${secret.length}`);
  return Keypair.fromSecretKey(secret.slice(0, 64));
}

function collectOwners() {
  const owners = new Set();
  const treasury = String(process.env.PLATFORM_TREASURY_PUBKEY || '').trim();
  if (BASE58_RE.test(treasury)) owners.add(treasury);

  const yamlPath = process.env.PROVIDER_RUNTIME || '/tmp/provider.yml';
  if (fs.existsSync(yamlPath)) {
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    for (const m of yaml.matchAll(/^\s*account:\s*'([^']+)'/gm)) {
      if (BASE58_RE.test(m[1])) owners.add(m[1]);
    }
  }
  return [...owners];
}

async function ensureAta(connection, payer, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (info) {
    return { owner: owner.toBase58(), ata: ata.toBase58(), created: false };
  }
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint)
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
  });
  return { owner: owner.toBase58(), ata: ata.toBase58(), created: true, signature: sig };
}

const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const network = process.env.PAYMENT_NETWORK || 'devnet';
const mintStr = defaultMint(network);
const owners = collectOwners();

if (owners.length === 0) {
  console.log('[ensure-atas] no recipients — skip');
  process.exit(0);
}

const payer = loadOperator();
const connection = new Connection(rpc, 'confirmed');
const mint = new PublicKey(mintStr);
const bal = await connection.getBalance(payer.publicKey);
console.log(
  `[ensure-atas] payer=${payer.publicKey.toBase58()} sol=${(bal / 1e9).toFixed(4)} mint=${mintStr} owners=${owners.length}`
);

if (bal < 50_000) {
  console.error(
    '[ensure-atas] operator has almost no SOL — cannot pay ATA rent. Top up the operator wallet on devnet.'
  );
  process.exit(1);
}

let created = 0;
let existed = 0;
let failed = 0;
for (const ownerStr of owners) {
  try {
    const result = await ensureAta(connection, payer, mint, new PublicKey(ownerStr));
    if (result.created) {
      created += 1;
      console.log(`[ensure-atas] created ATA owner=${result.owner.slice(0, 8)}… sig=${result.signature}`);
    } else {
      existed += 1;
      console.log(`[ensure-atas] exists ATA owner=${result.owner.slice(0, 8)}…`);
    }
  } catch (err) {
    failed += 1;
    console.error(`[ensure-atas] FAILED owner=${ownerStr}:`, err?.message || err);
  }
}

console.log(`[ensure-atas] done created=${created} existed=${existed} failed=${failed}`);
if (failed > 0) process.exit(1);
