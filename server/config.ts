/**
 * Central runtime configuration for SolVamos Studio (Cloud Run / local).
 */

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
  provisionMode: (process.env.PROVISION_MODE || 'mock') as 'mock' | 'terraform-only' | 'live',

  /** Dev only — never true on Cloud Run prod */
  allowLocalVaultFallback: bool('ALLOW_LOCAL_VAULT_FALLBACK', process.env.NODE_ENV !== 'production'),
  allowPaymentBypass: bool('ALLOW_PAYMENT_BYPASS', process.env.NODE_ENV !== 'production'),

  paymentNetwork,
  solanaRpcUrl: defaultRpc(paymentNetwork),
  usdcMint: defaultUsdcMint(paymentNetwork),
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
  defaultAgentFeeUsdc: Number(process.env.DEFAULT_AGENT_FEE_USDC || 0.001),
};

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
  if (problems.length) {
    console.error('[SolVamos] Production safety check failed:\n - ' + problems.join('\n - '));
  }
}

export function networkLabel(): string {
  if (config.paymentNetwork === 'sandbox') return 'pay.sh-sandbox';
  if (config.paymentNetwork === 'localnet') return 'solana-localnet';
  return 'solana-devnet';
}
