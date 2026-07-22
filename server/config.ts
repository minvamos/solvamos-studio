/**
 * Central runtime configuration for SolVamos Studio (Cloud Run / local).
 */

import dotenv from 'dotenv';
dotenv.config();

export type CustomerTier = 'starter' | 'professional' | 'enterprise';

/** sandbox = pay.sh local sandbox proofs; localnet = solana-test-validator; devnet = public Devnet */
export type PaymentNetwork = 'sandbox' | 'localnet' | 'devnet';

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function resolvePaymentNetwork(): PaymentNetwork {
  const raw = (process.env.PAYMENT_NETWORK || process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
  if (raw === 'sandbox' || raw === 'paysh' || raw === 'pay.sh') return 'sandbox';
  if (raw === 'localnet' || raw === 'local' || raw === 'localhost') return 'localnet';
  return 'devnet';
}

function defaultRpc(network: PaymentNetwork): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (network === 'localnet') return 'http://127.0.0.1:8899';
  if (network === 'sandbox') return process.env.PAYSH_SANDBOX_RPC || 'http://127.0.0.1:8899';
  return 'https://api.devnet.solana.com';
}

function defaultUsdcMint(network: PaymentNetwork): string {
  if (process.env.USDC_MINT) return process.env.USDC_MINT;
  // Devnet USDC (Circle faucet mint commonly used in demos)
  if (network === 'devnet') return '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  // Localnet / sandbox: set USDC_MINT after creating a local mint
  return process.env.USDC_MINT_LOCAL || 'LocalUsdC111111111111111111111111111111111';
}

const paymentNetwork = resolvePaymentNetwork();

/** Mutable runtime payment settings (dev UI can switch sandbox ↔ devnet). */
let runtimeNetwork: PaymentNetwork = paymentNetwork;
let runtimeRpcOverride: string | undefined = process.env.SOLANA_RPC_URL || undefined;
let runtimeMintOverride: string | undefined = process.env.USDC_MINT || undefined;

function refreshPaymentDerived() {
  config.paymentNetwork = runtimeNetwork;
  config.solanaRpcUrl = runtimeRpcOverride || defaultRpc(runtimeNetwork);
  config.usdcMint = runtimeMintOverride || defaultUsdcMint(runtimeNetwork);
}

export const config = {
  product: 'SolVamos Studio',
  version: '0.7.0',
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',

  gcpProject: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '',
  tenantId: process.env.SOLVAMOS_TENANT_ID || '',
  tier: (process.env.CUSTOMER_TIER || 'starter') as CustomerTier,
  kmsKeyName: process.env.KMS_KEY_NAME || '',

  vertexDataStoreId: process.env.VERTEX_DATA_STORE_ID || '',
  vertexSearchLocation: process.env.VERTEX_SEARCH_LOCATION || 'global',
  vertexSearchCollection: process.env.VERTEX_SEARCH_COLLECTION || 'default_collection',

  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  oauthRedirectUri:
    process.env.OAUTH_REDIRECT_URI ||
    `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/google/callback`,
  appUrl: process.env.APP_URL || 'http://localhost:3000',

  orgId: process.env.SOLVAMOS_ORG_ID || '',
  customersFolderId: process.env.SOLVAMOS_CUSTOMERS_FOLDER_ID || '',
  billingAccount: process.env.SOLVAMOS_BILLING_ACCOUNT || '',
  /**
   * mock | shared | terraform-only | live
   * - shared/mock: single GOOGLE_CLOUD_PROJECT (dev, no org billing)
   * - live + TENANCY_MODE=isolated: create cust-*-prod under Org
   */
  provisionMode: (process.env.PROVISION_MODE || 'shared') as
    | 'mock'
    | 'shared'
    | 'terraform-only'
    | 'live',
  /** shared (dev) | isolated (product per-customer project) */
  tenancyMode: (() => {
    const t = (process.env.TENANCY_MODE || '').toLowerCase();
    if (t === 'isolated' || t === 'per-customer' || t === 'product') return 'isolated' as const;
    return 'shared' as const;
  })(),
  /**
   * Product: create cust-* GCP projects under Org on account/tenant create.
   * DISABLED by default (no org billing yet). Keep logic; do not call until true.
   */
  enableOrgProjectCreate: bool('ENABLE_ORG_PROJECT_CREATE', false),
  /** Lab: on tenant create, deploy Cloud Run service inside shared project */
  deployTenantCloudRun: bool('DEPLOY_TENANT_CLOUD_RUN', true),
  cloudRunRegion: process.env.CLOUD_RUN_REGION || 'asia-northeast3',
  /** Image from Artifact Registry after first platform build */
  sharedCloudRunImage: process.env.SHARED_CLOUD_RUN_IMAGE || '',
  cloudRunMinInstances: Math.max(0, Number(process.env.CLOUD_RUN_MIN_INSTANCES || 1)),

  /** Dev only — never true on Cloud Run prod */
  allowLocalVaultFallback: bool('ALLOW_LOCAL_VAULT_FALLBACK', process.env.NODE_ENV !== 'production'),
  allowPaymentBypass: bool('ALLOW_PAYMENT_BYPASS', process.env.NODE_ENV !== 'production'),

  paymentNetwork: runtimeNetwork as PaymentNetwork,
  solanaRpcUrl: defaultRpc(runtimeNetwork),
  usdcMint: defaultUsdcMint(runtimeNetwork),
  /** Platform take-rate (0.1 = 10%). Rest goes to agent vault. */
  platformFeeShare: Math.min(1, Math.max(0, Number(process.env.PLATFORM_FEE_SHARE || 0.1))),
  /**
   * 플랫폼 10% 수금 지갑.
   * 기본값 = SolVamos 개발/테스트용 계좌(팀에서 발급한 CREATOR_WALLET).
   * 프로덕션·다른 환경은 PLATFORM_TREASURY_PUBKEY 로 반드시 오버라이드.
   */
  platformTreasuryPubkey:
    process.env.PLATFORM_TREASURY_PUBKEY ||
    'AoUNKE8uQ8y1FEtU6YSFCsopK9veP6jZ6EGNoULjdwva',
  /**
   * Deprecated for new agents — create always mints a dedicated agent vault.
   * Kept only for legacy seed agents / env override demos.
   */
  defaultAgentVaultPubkey:
    process.env.DEFAULT_AGENT_VAULT_PUBKEY ||
    '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
  defaultAgentFeeUsdc: Number(process.env.DEFAULT_AGENT_FEE_USDC || 0.001),
};

/** Switch payment network at runtime (blocked in production). */
export function setPaymentNetwork(
  network: PaymentNetwork,
  opts?: { rpcUrl?: string; usdcMint?: string }
): { ok: boolean; error?: string } {
  if (config.isProd) {
    return { ok: false, error: 'Runtime payment network switch is disabled in production' };
  }
  if (network !== 'sandbox' && network !== 'localnet' && network !== 'devnet') {
    return { ok: false, error: 'network must be sandbox | localnet | devnet' };
  }
  runtimeNetwork = network;
  if (opts?.rpcUrl) runtimeRpcOverride = opts.rpcUrl;
  else if (network === 'devnet') runtimeRpcOverride = process.env.SOLANA_RPC_URL || undefined;
  else if (network === 'sandbox') runtimeRpcOverride = process.env.PAYSH_SANDBOX_RPC || process.env.SOLANA_RPC_URL || undefined;
  else runtimeRpcOverride = process.env.SOLANA_RPC_URL || undefined;

  if (opts?.usdcMint) runtimeMintOverride = opts.usdcMint;
  else runtimeMintOverride = process.env.USDC_MINT || undefined;

  refreshPaymentDerived();
  console.log(
    `[payment] network → ${config.paymentNetwork} rpc=${config.solanaRpcUrl} mint=${config.usdcMint}`
  );
  return { ok: true };
}

export function paymentNetworkInfo() {
  return {
    paymentNetwork: config.paymentNetwork,
    networkLabel: networkLabel(),
    solanaRpcUrl: config.solanaRpcUrl,
    usdcMint: config.usdcMint,
    platformTreasuryPubkey: config.platformTreasuryPubkey,
    platformFeeShare: config.platformFeeShare,
    allowPaymentBypass: config.allowPaymentBypass,
    sandboxProofsAllowed: config.paymentNetwork === 'sandbox' || config.allowPaymentBypass,
    modes: [
      {
        id: 'sandbox' as const,
        label: 'Sandbox (테스트)',
        description: 'pay.sh 로컬 증명 PAYSH_LOCAL_ / PAYSH_A2A_ — 체인 없이 UX·A2A 테스트',
      },
      {
        id: 'devnet' as const,
        label: 'Devnet (프로덕트)',
        description: 'Solana Devnet 실 USDC 트랜잭션 서명 검증 — 제품 경로',
      },
      {
        id: 'localnet' as const,
        label: 'Localnet',
        description: 'solana-test-validator + 로컬 USDC mint',
      },
    ],
  };
}

export function assertProductionSafety() {
  if (!config.isProd) return;
  const problems: string[] = [];
  if (config.allowLocalVaultFallback) {
    problems.push('ALLOW_LOCAL_VAULT_FALLBACK must be false in production');
  }
  if (config.allowPaymentBypass) {
    problems.push('ALLOW_PAYMENT_BYPASS must be false in production');
  }
  if (config.paymentNetwork === 'sandbox') {
    problems.push('PAYMENT_NETWORK=sandbox must not be used in production');
  }
  if (!config.gcpProject) {
    problems.push('GOOGLE_CLOUD_PROJECT is required in production');
  }
  const jwt = process.env.JWT_SECRET || '';
  if (jwt.length < 32) {
    problems.push('JWT_SECRET (>=32 chars) is required in production');
  }
  if (problems.length) {
    console.error('[SolVamos] Production safety check FAILED:\n - ' + problems.join('\n - '));
    throw new Error(`Production safety check failed: ${problems.join('; ')}`);
  }
}

export function networkLabel(): string {
  if (config.paymentNetwork === 'sandbox') return 'pay.sh-sandbox';
  if (config.paymentNetwork === 'localnet') return 'solana-localnet';
  return 'solana-devnet';
}
