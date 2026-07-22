/**
 * Customer provisioner.
 *
 * TENANCY_MODE=shared (Lab, default — no Org billing):
 *   GOOGLE_CLOUD_PROJECT 하나에 테넌트별 Cloud Run `sv-{tenant}` 배포.
 *   Org 아래 신규 GCP 프로젝트 생성은 ENABLE_ORG_PROJECT_CREATE=false 로 비활성.
 *
 * TENANCY_MODE=isolated (product, when org+billing ready):
 *   cust-{tenant}-prod under SolVamos Org. Requires ENABLE_ORG_PROJECT_CREATE=true.
 *
 * PROVISION_MODE:
 *   mock           — registry only, no GCP calls
 *   shared         — shared project + optional Cloud Run
 *   terraform-only — planned projectId + TF hint (no deploy)
 *   live           — Resource Manager createProject (isolated + flag only)
 */

import { ProjectsClient } from '@google-cloud/resource-manager';
import { config } from './config.js';
import { upsertTenant, getTenant, type TenantRecord } from './tenants.js';
import { provisionTenantCloudRun } from './cloudrun-provision.js';

function sanitizeTenantId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20);
}

/** Product naming: one GCP project per customer under Org */
export function plannedProjectId(tenantId: string): string {
  return `cust-${sanitizeTenantId(tenantId)}-prod`;
}

export type ProvisionInput = {
  tenantId: string;
  displayName: string;
  tier?: TenantRecord['tier'];
  byoProjectId?: string;
  /** Override: shared | isolated */
  tenancyMode?: 'shared' | 'isolated';
};

export type ProvisionPlan = {
  tenancyMode: 'shared' | 'isolated';
  provisionMode: string;
  projectId: string;
  sharedProjectId: string | null;
  parent: string | null;
  willCallGcp: boolean;
  notes: string[];
};

export function resolveTenancyMode(override?: 'shared' | 'isolated'): 'shared' | 'isolated' {
  if (override) return override;
  const mode = (process.env.TENANCY_MODE || '').toLowerCase();
  if (mode === 'isolated' || mode === 'per-customer' || mode === 'product') return 'isolated';
  // PROVISION_MODE=shared forces shared
  if (config.provisionMode === 'shared') return 'shared';
  // Default: shared for local/dev until Org+billing exist
  if (config.provisionMode === 'live' && (config.orgId || config.customersFolderId)) {
    return 'isolated';
  }
  return 'shared';
}

export function buildProvisionPlan(input: ProvisionInput): ProvisionPlan {
  const tenantId = sanitizeTenantId(input.tenantId);
  const tenancyMode = resolveTenancyMode(input.tenancyMode);
  const sharedProjectId = config.gcpProject || null;
  const notes: string[] = [];

  if (input.byoProjectId) {
    return {
      tenancyMode: 'isolated',
      provisionMode: config.provisionMode,
      projectId: input.byoProjectId,
      sharedProjectId,
      parent: null,
      willCallGcp: false,
      notes: ['BYO project — customer-owned, no create'],
    };
  }

  if (tenancyMode === 'shared') {
    if (!sharedProjectId) {
      notes.push('GOOGLE_CLOUD_PROJECT unset — set it to your single shared PoC project');
    }
    notes.push(
      'Lab/shared: Org project-create DISABLED. On tenant create → new Cloud Run in shared project (sv-{tenant}).'
    );
    if (config.deployTenantCloudRun) {
      notes.push(
        config.sharedCloudRunImage
          ? `Will deploy Cloud Run image ${config.sharedCloudRunImage}`
          : 'SHARED_CLOUD_RUN_IMAGE unset → Cloud Run status pending_image until first image build'
      );
    }
    return {
      tenancyMode: 'shared',
      provisionMode: config.provisionMode,
      projectId: sharedProjectId || `shared-unset-${tenantId}`,
      sharedProjectId,
      parent: null,
      willCallGcp: config.deployTenantCloudRun && !!config.sharedCloudRunImage,
      notes,
    };
  }

  const projectId = plannedProjectId(tenantId);
  const folderId = config.customersFolderId;
  const orgId = config.orgId;
  const parent = folderId
    ? `folders/${folderId.replace('folders/', '')}`
    : orgId
      ? `organizations/${orgId}`
      : null;

  const willCallGcp =
    config.provisionMode === 'live' && config.enableOrgProjectCreate;
  if (!config.enableOrgProjectCreate) {
    notes.push(
      'ENABLE_ORG_PROJECT_CREATE=false — org/customer project creation logic is present but DISABLED'
    );
  }
  if (!parent) {
    notes.push('Need SOLVAMOS_ORG_ID or SOLVAMOS_CUSTOMERS_FOLDER_ID for isolated live create');
  }
  if (!config.billingAccount && willCallGcp) {
    notes.push('SOLVAMOS_BILLING_ACCOUNT recommended to attach billing after create');
  }
  notes.push('Product/isolated: one GCP project per customer under Org (when enabled)');

  return {
    tenancyMode: 'isolated',
    provisionMode: config.provisionMode,
    projectId,
    sharedProjectId,
    parent,
    willCallGcp,
    notes,
  };
}

export async function provisionCustomerProject(input: ProvisionInput): Promise<TenantRecord> {
  const tenantId = sanitizeTenantId(input.tenantId);
  const tier = input.tier || 'starter';
  const plan = buildProvisionPlan(input);

  if (input.byoProjectId) {
    const record: TenantRecord = {
      tenantId,
      displayName: input.displayName,
      projectId: input.byoProjectId,
      tier: 'enterprise',
      status: 'byo',
      byoProject: true,
      tenancyMode: 'isolated',
      createdAt: new Date().toISOString(),
    };
    return await upsertTenant(record);
  }

  const base: TenantRecord = {
    tenantId,
    displayName: input.displayName,
    projectId: plan.projectId,
    folderId: config.customersFolderId || undefined,
    tier,
    status: 'provisioning',
    tenancyMode: plan.tenancyMode,
    sharedProject: plan.tenancyMode === 'shared',
    createdAt: new Date().toISOString(),
  };
  await upsertTenant(base);

  // --- Shared / mock / terraform-only: no org GCP project create ---
  if (
    plan.tenancyMode === 'shared' ||
    config.provisionMode === 'mock' ||
    config.provisionMode === 'shared' ||
    config.provisionMode === 'terraform-only' ||
    !config.enableOrgProjectCreate
  ) {
    // Lab: Cloud Run inside shared project (not a new GCP project)
    let cloudRun: Awaited<ReturnType<typeof provisionTenantCloudRun>> | undefined;
    if (
      plan.tenancyMode === 'shared' &&
      config.deployTenantCloudRun &&
      config.provisionMode !== 'mock' &&
      config.provisionMode !== 'terraform-only'
    ) {
      cloudRun = await provisionTenantCloudRun({
        tenantId,
        displayName: input.displayName,
        tier,
      });
      plan.notes.push(
        ...(cloudRun.message ? [cloudRun.message] : []),
        ...(cloudRun.deployCommand ? [`Deploy cmd: ${cloudRun.deployCommand}`] : [])
      );
    }

    const record: TenantRecord = {
      ...base,
      status: 'active',
      cloudRunUri: cloudRun?.uri || undefined,
      cloudRunServiceName: cloudRun?.serviceName,
      cloudRunStatus: cloudRun?.status,
      errorMessage:
        config.provisionMode === 'terraform-only' && plan.tenancyMode === 'isolated'
          ? `Run: terraform apply -var=project_id=${plan.projectId} in infra/terraform (parent=${plan.parent || 'unset'})`
          : plan.tenancyMode === 'shared'
            ? cloudRun?.status === 'error'
              ? cloudRun.message
              : `shared-lab: project=${plan.projectId}; Cloud Run=${cloudRun?.status || 'n/a'}`
            : !config.enableOrgProjectCreate && plan.tenancyMode === 'isolated'
              ? 'Org project create disabled (ENABLE_ORG_PROJECT_CREATE=false). Use shared Cloud Run lab path or enable when billing/org ready.'
              : undefined,
      provisionNotes: plan.notes,
    };
    return await upsertTenant(record);
  }

  // --- Isolated + live + ENABLE_ORG_PROJECT_CREATE ---
  try {
    if (!plan.parent) {
      throw new Error(
        'TENANCY_MODE=isolated + live requires SOLVAMOS_ORG_ID or SOLVAMOS_CUSTOMERS_FOLDER_ID'
      );
    }

    const client = new ProjectsClient();
    const project: any = {
      projectId: plan.projectId,
      displayName: `SolVamos ${input.displayName}`.slice(0, 30),
      labels: {
        solvamos_tenant: tenantId,
        solvamos_tier: tier,
        solvamos_tenancy: 'isolated',
      },
      parent: plan.parent,
    };

    const [op] = await client.createProject({
      project,
    } as any);

    console.log(`[Provisioner] createProject ${plan.projectId} parent=${plan.parent}`, op?.name || '');

    if (config.billingAccount) {
      console.log(
        `[Provisioner] Attach billing ${config.billingAccount} via Billing API / Terraform (not fully inlined)`
      );
    }

    console.log(
      `[Provisioner] Next: enable APIs + Cloud Run + Vertex Search in ${plan.projectId} (Terraform customer-project module)`
    );

    return await upsertTenant({
      ...base,
      status: 'active',
      provisionNotes: plan.notes,
    });
  } catch (err: any) {
    console.error(`[Provisioner] ${err.message}`);
    return await upsertTenant({
      ...base,
      status: 'error',
      errorMessage: err.message,
      provisionNotes: plan.notes,
    });
  }
}

/** Runtime GCP project for a tenant (agents/RAG should use this). */
export async function gcpProjectForTenant(tenantId?: string): Promise<string> {
  if (!tenantId) return config.gcpProject;
  const mode = resolveTenancyMode();
  if (mode === 'shared') return config.gcpProject;
  const t = await getTenant(tenantId);
  return t?.projectId || plannedProjectId(tenantId);
}
