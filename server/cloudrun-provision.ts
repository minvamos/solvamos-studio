/**
 * Per-tenant Cloud Run runtime inside the *shared* GCP project (Lab).
 *
 * Product path (disabled): one GCP project per customer under Org — see provision.ts isolated+live.
 * Lab path (active): TENANCY_MODE=shared → deploy service `sv-{tenant}` in GOOGLE_CLOUD_PROJECT.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

export type CloudRunProvisionResult = {
  serviceName: string;
  uri: string | null;
  status: 'active' | 'pending_image' | 'skipped' | 'error';
  projectId: string;
  region: string;
  message?: string;
  deployCommand?: string;
};

function sanitizeServiceName(tenantId: string): string {
  const base = `sv-${tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.replace(/-+/g, '-');
  return base.slice(0, 49).replace(/-$/, '') || 'sv-tenant';
}

/** GCP label values: lowercase, digits, _ and - only */
function labelValue(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 63) || 'tenant';
}

async function accessToken(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    return t.token || null;
  } catch {
    return null;
  }
}

/** Deploy or update tenant Cloud Run in the shared project. */
export async function provisionTenantCloudRun(opts: {
  tenantId: string;
  displayName?: string;
  tier?: string;
}): Promise<CloudRunProvisionResult> {
  const projectId = config.gcpProject;
  const region = config.cloudRunRegion;
  const image = config.sharedCloudRunImage;
  const serviceName = sanitizeServiceName(opts.tenantId);

  if (!projectId) {
    return {
      serviceName,
      uri: null,
      status: 'error',
      projectId: '',
      region,
      message: 'GOOGLE_CLOUD_PROJECT unset — cannot deploy Cloud Run',
    };
  }

  if (!config.deployTenantCloudRun) {
    return {
      serviceName,
      uri: null,
      status: 'skipped',
      projectId,
      region,
      message: 'DEPLOY_TENANT_CLOUD_RUN=false — Cloud Run auto-deploy disabled',
    };
  }

  const deployCommand = [
    'gcloud',
    'run',
    'deploy',
    serviceName,
    `--project=${projectId}`,
    `--region=${region}`,
    `--image=${image || '<SET_SHARED_CLOUD_RUN_IMAGE>'}`,
    '--platform=managed',
    '--allow-unauthenticated',
    '--port=8080',
    `--min-instances=${config.cloudRunMinInstances}`,
    '--max=1',
    '--max-instances=1',
    `--set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${projectId},SOLVAMOS_TENANT_ID=${opts.tenantId},TENANCY_MODE=shared,PROVISION_MODE=shared,ALLOW_LOCAL_VAULT_FALLBACK=false,ALLOW_PAYMENT_BYPASS=false,PAYMENT_NETWORK=${config.paymentNetwork}`,
    `--labels=solvamos-tenant=${labelValue(opts.tenantId)},solvamos-runtime=shared`,
  ].join(' ');

  if (!image) {
    return {
      serviceName,
      uri: null,
      status: 'pending_image',
      projectId,
      region,
      message:
        'SHARED_CLOUD_RUN_IMAGE not set. Build once (solvamos-cloudrun/scripts/deploy.ps1), then set image and re-POST /api/tenants or call provision again.',
      deployCommand,
    };
  }

  // Prefer gcloud CLI (already authenticated as mikogcp97)
  try {
    const { stdout, stderr } = await execFileAsync(
      'gcloud',
      [
        'run',
        'deploy',
        serviceName,
        `--project=${projectId}`,
        `--region=${region}`,
        `--image=${image}`,
        '--platform=managed',
        '--allow-unauthenticated',
        '--port=8080',
        `--min-instances=${String(config.cloudRunMinInstances)}`,
        '--max=1',
        '--max-instances=1',
        `--set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${projectId},SOLVAMOS_TENANT_ID=${opts.tenantId},TENANCY_MODE=shared,PROVISION_MODE=shared,ALLOW_LOCAL_VAULT_FALLBACK=false,ALLOW_PAYMENT_BYPASS=false,PAYMENT_NETWORK=${config.paymentNetwork}`,
        `--labels=solvamos-tenant=${labelValue(opts.tenantId)},solvamos-runtime=shared`,
        '--quiet',
      ],
      { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }
    );
    console.log('[CloudRun]', stdout || stderr);

    const uri = await resolveServiceUri(projectId, region, serviceName);
    return {
      serviceName,
      uri,
      status: uri ? 'active' : 'error',
      projectId,
      region,
      message: uri ? `Cloud Run ready: ${uri}` : 'Deploy finished but URI lookup failed',
      deployCommand,
    };
  } catch (err: any) {
    console.error('[CloudRun] gcloud deploy failed', err?.message || err);
    // Fallback: try Admin API create/patch if token available
    const api = await deployViaRestApi({
      projectId,
      region,
      serviceName,
      image,
      tenantId: opts.tenantId,
    });
    if (api.status === 'active') return { ...api, deployCommand };

    return {
      serviceName,
      uri: null,
      status: 'error',
      projectId,
      region,
      message: err?.stderr || err?.message || 'Cloud Run deploy failed',
      deployCommand,
    };
  }
}

async function resolveServiceUri(
  projectId: string,
  region: string,
  serviceName: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gcloud',
      [
        'run',
        'services',
        'describe',
        serviceName,
        `--project=${projectId}`,
        `--region=${region}`,
        '--format=value(status.url)',
      ],
      { timeout: 60_000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function deployViaRestApi(opts: {
  projectId: string;
  region: string;
  serviceName: string;
  image: string;
  tenantId: string;
}): Promise<CloudRunProvisionResult> {
  const token = await accessToken();
  const base = {
    serviceName: opts.serviceName,
    uri: null as string | null,
    projectId: opts.projectId,
    region: opts.region,
  };
  if (!token) {
    return { ...base, status: 'error', message: 'No ADC token for Cloud Run Admin API' };
  }

  const parent = `projects/${opts.projectId}/locations/${opts.region}`;
  const name = `${parent}/services/${opts.serviceName}`;
  const body = {
    name,
    ingress: 'INGRESS_TRAFFIC_ALL',
    template: {
      containers: [
        {
          image: opts.image,
          ports: [{ containerPort: 8080 }],
          env: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'GOOGLE_CLOUD_PROJECT', value: opts.projectId },
            { name: 'SOLVAMOS_TENANT_ID', value: opts.tenantId },
            { name: 'TENANCY_MODE', value: 'shared' },
            { name: 'ALLOW_LOCAL_VAULT_FALLBACK', value: 'false' },
            { name: 'ALLOW_PAYMENT_BYPASS', value: 'false' },
          ],
        },
      ],
      scaling: {
        minInstanceCount: config.cloudRunMinInstances,
        maxInstanceCount: 10,
      },
    },
    labels: {
      'solvamos-tenant': labelValue(opts.tenantId),
      'solvamos-runtime': 'shared',
    },
  };

  try {
    // Create
    let res = await fetch(
      `https://run.googleapis.com/v2/${parent}/services?serviceId=${opts.serviceName}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (res.status === 409) {
      // Update existing
      res = await fetch(`https://run.googleapis.com/v2/${name}?updateMask=template,labels,ingress`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const text = await res.text();
      return { ...base, status: 'error', message: `Cloud Run API ${res.status}: ${text.slice(0, 400)}` };
    }
    // Wait briefly then describe
    await new Promise((r) => setTimeout(r, 3000));
    const desc = await fetch(`https://run.googleapis.com/v2/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: any = await desc.json();
    const uri = json?.uri || json?.status?.url || null;
    return {
      ...base,
      uri,
      status: uri ? 'active' : 'error',
      message: uri ? `Cloud Run API deploy: ${uri}` : 'API accepted but no URI yet',
    };
  } catch (err: any) {
    return { ...base, status: 'error', message: err.message };
  }
}
