/**
 * Agent vault: Secret Manager + optional CMEK.
 * Agent keys are NEVER the user wallet — each agent gets its own Solana keypair.
 * Production: no plaintext local fallback unless ALLOW_LOCAL_VAULT_FALLBACK=true.
 */

import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { config } from './config.js';

export type VaultSaveResult = {
  success: boolean;
  path: string;
  mock: boolean;
};

export type AgentVaultKeys = {
  publicKey: string;
  secretKeyBase64: string;
};

/** Fresh agent vault keypair (not linked to any user wallet). */
export function createAgentVaultKeypair(): AgentVaultKeys {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKeyBase64: Buffer.from(kp.secretKey).toString('base64'),
  };
}

function allowLocalFallback(): boolean {
  // Prefer central config (defaults true outside production)
  return config.allowLocalVaultFallback === true;
}

function localVaultPath(): string {
  return path.join(process.cwd(), 'kms_vault_mock.json');
}

async function encryptWithCmek(plaintext: string): Promise<string> {
  const keyName = process.env.KMS_KEY_NAME;
  if (!keyName) return plaintext;

  const kms = new KeyManagementServiceClient();
  const [result] = await kms.encrypt({
    name: keyName,
    plaintext: Buffer.from(plaintext, 'utf8'),
  });
  return Buffer.from(result.ciphertext as Uint8Array).toString('base64');
}

export async function savePrivateKeyToGCP(
  agentId: string,
  secretKeyBase64: string
): Promise<VaultSaveResult> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

  try {
    if (!projectId) {
      throw new Error('GCP Project ID not configured');
    }

    const client = new SecretManagerServiceClient();
    const payload = await encryptWithCmek(secretKeyBase64);
    const secretId = `solvamos-agent-${agentId}-secret`;
    const parent = `projects/${projectId}`;
    let secretName = `${parent}/secrets/${secretId}`;

    try {
      const [secret] = await client.createSecret({
        parent,
        secretId,
        secret: {
          replication: { automatic: {} },
        },
      });
      secretName = secret.name || secretName;
    } catch (e: any) {
      const msg = String(e.message || e);
      const already = e.code === 6 || msg.includes('AlreadyExists') || msg.includes('already exists');
      if (!already) throw e;
    }

    const [version] = await client.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(payload, 'utf8') },
    });

    console.log(`[GCP Secret Manager] Saved key for agent ${agentId}`);
    return { success: true, path: version.name || secretName, mock: false };
  } catch (err: any) {
    if (!allowLocalFallback()) {
      console.error(`[GCP Secret Manager] Failed and local fallback disabled: ${err.message}`);
      throw new Error(
        `Secret Manager unavailable and ALLOW_LOCAL_VAULT_FALLBACK is not true: ${err.message}`
      );
    }

    // Dev-only obfuscation (NOT production-safe) — never write raw secret key string
    const file = localVaultPath();
    let vault: Record<string, { ciphertext: string; algo: string }> = {};
    if (fs.existsSync(file)) {
      try {
        vault = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        vault = {};
      }
    }
    vault[agentId] = {
      ciphertext: Buffer.from(secretKeyBase64, 'utf8').toString('base64'),
      algo: 'dev-base64-only-NOT-SECURE',
    };
    fs.writeFileSync(file, JSON.stringify(vault, null, 2), 'utf8');
    console.warn(
      `[Vault Dev Fallback] ${err.message}. Stored obfuscated local entry (dev only).`
    );
    return {
      success: true,
      path: `projects/LOCAL_DEV/secrets/solvamos-agent-${agentId}-secret/versions/1`,
      mock: true,
    };
  }
}

function agentIdFromLocalSecretPath(secretPath: string): string | null {
  const m = secretPath.match(/solvamos-agent-([^/]+)-secret/);
  return m?.[1] || null;
}

export async function loadPrivateKeyFromGCP(secretPath: string): Promise<string | null> {
  if (secretPath.includes('LOCAL_DEV') || secretPath.includes('MOCK_PROJECT')) {
    if (!allowLocalFallback()) return null;
    const agentId = agentIdFromLocalSecretPath(secretPath);
    if (!agentId) return null;
    const file = localVaultPath();
    if (!fs.existsSync(file)) return null;
    try {
      const vault = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
        string,
        { ciphertext: string; algo: string }
      >;
      const entry = vault[agentId];
      if (!entry?.ciphertext) return null;
      return Buffer.from(entry.ciphertext, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: secretPath });
  const data = version.payload?.data;
  if (!data) return null;
  const raw = Buffer.from(data as Uint8Array).toString('utf8');

  const keyName = process.env.KMS_KEY_NAME;
  if (!keyName) return raw;

  try {
    const kms = new KeyManagementServiceClient();
    const [dec] = await kms.decrypt({
      name: keyName,
      ciphertext: Buffer.from(raw, 'base64'),
    });
    return Buffer.from(dec.plaintext as Uint8Array).toString('utf8');
  } catch {
    return raw;
  }
}
