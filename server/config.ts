/**
 * Central runtime configuration for SolVamos Studio (Cloud Run / local).
 */

import dotenv from 'dotenv';
dotenv.config();

export type CustomerTier = 'starter' | 'professional' | 'enterprise';

/**
 * Two product modes only (no mainnet):
 * - localnet → pay.sh `--sandbox` (Surfpool; no real funds)
 * - devnet → pay.sh without `--sandbox`, Solana Devnet on-chain USDC
 *
 * Legacy env `PAYMENT_NETWORK=sandbox` maps to `localnet`.
 */
export type PaymentNetwork = 'localnet' | 'devnet';

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function resolvePaymentNetwork(): PaymentNetwork {
  const raw = (process.env.PAYMENT_NETWORK || process.env.SOLANA_NETWORK || 'localnet').toLowerCase();
  // sandbox / pay.sh aliases → localnet (official pay --sandbox)
  if (
    raw === 'sandbox' ||
    raw === 'paysh' ||
    raw === 'pay.sh' ||
    raw === 'localnet' ||
    raw === 'local' ||
    raw === 'localhost'
  ) {
    return 'localnet';
  }
  return 'devnet';
}

function defaultRpc(network: PaymentNetwork): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (network === 'localnet') return process.env.PAYSH_SANDBOX_RPC || 'https://402.surfnet.dev:8899';
  return 'https://api.devnet.solana.com';
}

function defaultUsdcMint(network: PaymentNetwork): string {
  if (process.env.USDC_MINT) return process.env.USDC_MINT;
  // Devnet USDC (Circle faucet mint commonly used in demos)
  if (network === 'devnet') return '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  // pay.sh sandbox / Surfpool — mint is managed by gateway; placeholder for UI
  return process.env.USDC_MINT_LOCAL || 'LocalUsdC111111111111111111111111111111111';
}

const paymentNetwork = resolvePaymentNetwork();

/** Mutable runtime payment settings (dev UI can switch localnet ↔ devnet). */
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
  version: '0.8.0',
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
  // Initial production policy: one instance maximum, so minimum must be 0 or 1.
  cloudRunMinInstances: Math.min(
    1,
    Math.max(0, Number(process.env.CLOUD_RUN_MIN_INSTANCES || 1))
  ),

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

  /**
   * Official pay.sh gateway (local default :1402).
   * When usePayGateway=true, catalog invokeUrl points here and paid A2A uses pay CLI.
   */
  payGatewayUrl: (process.env.PAY_GATEWAY_URL || 'http://127.0.0.1:1402').replace(/\/$/, ''),
  /** Studio origin that the gateway proxies to after settlement */
  payOriginUrl: (process.env.PAY_ORIGIN_URL || process.env.APP_URL || 'http://127.0.0.1:3000').replace(
    /\/$/,
    ''
  ),
  /** Shared secret gateway → origin (header X-Pay-Internal-Secret) */
  payInternalSecret: process.env.PAY_INTERNAL_SECRET || '',
  /** Prefer pay.sh gateway URLs in catalog / Agent Card */
  usePayGateway: bool('USE_PAY_GATEWAY', true),
  /**
   * Local Lab only: Studio owns one pay child process and restarts it on mode changes.
   * Always disabled in production / Cloud Run.
   */
  payGatewayManaged:
    !((process.env.NODE_ENV || 'development') === 'production') &&
    bool('PAY_GATEWAY_MANAGED', true),
  /**
   * Accept legacy MOCK_/PAYSH_LOCAL_/PAYSH_A2A_ proofs on origin.
   * Default false — real pay.sh path does not need them.
   */
  allowLegacySandboxProof: bool('ALLOW_LEGACY_SANDBOX_PROOF', false),
};

/** pay.sh CLI should pass `--sandbox` (Surfpool). True only in localnet mode. */
export function payCliUsesSandbox(): boolean {
  return config.paymentNetwork === 'localnet';
}

/** Which provider YAML + CLI flags match the current Studio payment mode. */
export function payShModeInfo() {
  if (config.paymentNetwork === 'devnet') {
    return {
      paymentNetwork: 'devnet' as const,
      cliSandbox: false,
      operatorNetwork: 'devnet' as const,
      providerYaml: 'pay/solvamos-provider.devnet.yml',
      gatewayStartHint:
        'pay server start pay/solvamos-provider.devnet.yml --bind 127.0.0.1:1402  (no --sandbox)',
      clientCallHint: 'pay fetch "http://127.0.0.1:1402/v1/agents/<ID>/invoke?prompt=hi"  (no --sandbox)',
      funds: 'on-chain Devnet USDC (faucet / test tokens — not mainnet)',
      label: 'Devnet · pay.sh on-chain',
    };
  }
  return {
    paymentNetwork: 'localnet' as const,
    cliSandbox: true,
    operatorNetwork: 'localnet' as const,
    providerYaml: 'pay/solvamos-provider.yml',
    gatewayStartHint:
      'pay --sandbox server start pay/solvamos-provider.yml --bind 127.0.0.1:1402',
    clientCallHint:
      'pay --sandbox fetch "http://127.0.0.1:1402/v1/agents/<ID>/invoke?prompt=hi"',
    funds: 'pay.sh Surfpool sandbox — no real funds',
    label: 'Localnet · pay.sh sandbox',
  };
}

/** Normalize UI/API aliases: sandbox → localnet. Mainnet rejected. */
export function normalizePaymentNetwork(raw: string): PaymentNetwork | null {
  const n = (raw || '').toLowerCase().trim();
  if (n === 'mainnet' || n === 'main') return null;
  if (n === 'sandbox' || n === 'paysh' || n === 'pay.sh' || n === 'localnet' || n === 'local') {
    return 'localnet';
  }
  if (n === 'devnet' || n === 'dev') return 'devnet';
  return null;
}

/** Switch payment network at runtime (blocked in production). */
export function setPaymentNetwork(
  network: string,
  opts?: { rpcUrl?: string; usdcMint?: string }
): { ok: boolean; error?: string } {
  if (config.isProd) {
    return { ok: false, error: 'Runtime payment network switch is disabled in production' };
  }
  const normalized = normalizePaymentNetwork(network);
  if (!normalized) {
    return {
      ok: false,
      error: 'network must be localnet | devnet (sandbox→localnet). mainnet is not supported',
    };
  }
  runtimeNetwork = normalized;
  if (opts?.rpcUrl) runtimeRpcOverride = opts.rpcUrl;
  else if (normalized === 'devnet') runtimeRpcOverride = process.env.SOLANA_RPC_URL || undefined;
  else runtimeRpcOverride = process.env.PAYSH_SANDBOX_RPC || process.env.SOLANA_RPC_URL || undefined;

  if (opts?.usdcMint) runtimeMintOverride = opts.usdcMint;
  else runtimeMintOverride = process.env.USDC_MINT || undefined;

  refreshPaymentDerived();
  const mode = payShModeInfo();
  console.log(
    `[payment] network → ${config.paymentNetwork} pay.sh=${mode.label} rpc=${config.solanaRpcUrl} mint=${config.usdcMint}`
  );
  console.log(`[payment] restart gateway: ${mode.gatewayStartHint}`);
  return { ok: true };
}

export function paymentNetworkInfo() {
  const mode = payShModeInfo();
  return {
    paymentNetwork: config.paymentNetwork,
    networkLabel: networkLabel(),
    solanaRpcUrl: config.solanaRpcUrl,
    usdcMint: config.usdcMint,
    platformTreasuryPubkey: config.platformTreasuryPubkey,
    platformFeeShare: config.platformFeeShare,
    allowPaymentBypass: config.allowPaymentBypass,
    allowLegacySandboxProof: config.allowLegacySandboxProof,
    usePayGateway: config.usePayGateway,
    payGatewayUrl: config.payGatewayUrl,
    /** Legacy field: localnet may still accept PAYSH_* if ALLOW_LEGACY_SANDBOX_PROOF */
    sandboxProofsAllowed:
      config.allowLegacySandboxProof &&
      (config.paymentNetwork === 'localnet' || config.allowPaymentBypass),
    paySh: mode,
    gatewayRestartRequired: !config.payGatewayManaged,
    modes: [
      {
        id: 'localnet' as const,
        label: 'Localnet',
        description: 'pay.sh --sandbox (Surfpool). 실돈 없음. 예전 UI Sandbox와 동일.',
      },
      {
        id: 'devnet' as const,
        label: 'Devnet',
        description: 'pay.sh → Solana Devnet 온체인 USDC (테스트 토큰). 메인넷 없음.',
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
  if (config.paymentNetwork === 'localnet') {
    problems.push(
      'PAYMENT_NETWORK=localnet (pay.sh sandbox) must not be used in production — use devnet'
    );
  }
  if (!config.gcpProject) {
    problems.push('GOOGLE_CLOUD_PROJECT is required in production');
  }
  const jwt = process.env.JWT_SECRET || '';
  if (jwt.length < 32) {
    problems.push('JWT_SECRET (>=32 chars) is required in production');
  }
  if (!process.env.DATABASE_URL) {
    problems.push('DATABASE_URL is required in production');
  }
  if (problems.length) {
    console.error('[SolVamos] Production safety check FAILED:\n - ' + problems.join('\n - '));
    throw new Error(`Production safety check failed: ${problems.join('; ')}`);
  }
}

export function networkLabel(): string {
  if (config.paymentNetwork === 'localnet') return 'pay.sh-sandbox / localnet';
  return 'pay.sh → solana-devnet';
}
