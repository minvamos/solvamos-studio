/**
 * Lab tenancy: treat GOOGLE_CLOUD_PROJECT as the customer GCP project.
 * No Org project create — bind every new user to this shared tenant in DB.
 */
import { config } from './config.js';
import { upsertTenant, getTenant, type TenantRecord } from './tenants.js';
import { prisma } from './db.js';

export function sharedTenantId(): string {
  return (
    process.env.SOLVAMOS_SHARED_TENANT_ID ||
    config.tenantId ||
    'lab-customer'
  );
}

export async function ensureSharedCustomerTenant(): Promise<TenantRecord> {
  const id = sharedTenantId();
  const projectId = config.gcpProject || `local-${id}`;
  const existing = await getTenant(id);
  if (existing) {
    // Keep projectId in sync with env if it drifted
    if (config.gcpProject && existing.projectId !== config.gcpProject) {
      return upsertTenant({
        ...existing,
        projectId: config.gcpProject,
        sharedProject: true,
        tenancyMode: 'shared',
        status: 'active',
      });
    }
    return existing;
  }

  return upsertTenant({
    tenantId: id,
    displayName: process.env.SOLVAMOS_SHARED_TENANT_NAME || 'Lab Customer (shared GCP)',
    projectId,
    tier: (config.tier as TenantRecord['tier']) || 'starter',
    status: 'active',
    tenancyMode: 'shared',
    sharedProject: true,
    byoProject: false,
    createdAt: new Date().toISOString(),
    provisionNotes: [
      'Lab mode: customer project = GOOGLE_CLOUD_PROJECT (no org provisioning).',
      `projectId=${projectId}`,
      `seededAt=${new Date().toISOString()}`,
    ],
  });
}

/**
 * On account signup: attach user as owner of the shared customer tenant
 * and set primaryTenantId. This is the “provision tenant project” line for Lab.
 */
export async function provisionTenantForNewUser(opts: {
  userId: string;
  orgName?: string;
}): Promise<TenantRecord> {
  const tenant = await ensureSharedCustomerTenant();
  const notes = [
    ...(tenant.provisionNotes || []),
    `member_joined userId=${opts.userId} at=${new Date().toISOString()}`,
    opts.orgName ? `orgName=${opts.orgName}` : null,
  ].filter(Boolean) as string[];

  await prisma.tenantMember.upsert({
    where: {
      tenantId_userId: { tenantId: tenant.tenantId, userId: opts.userId },
    },
    create: {
      tenantId: tenant.tenantId,
      userId: opts.userId,
      role: 'owner',
    },
    update: { role: 'owner' },
  });

  await prisma.user.update({
    where: { id: opts.userId },
    data: { primaryTenantId: tenant.tenantId },
  });

  return upsertTenant({
    ...tenant,
    displayName: opts.orgName?.trim() || tenant.displayName,
    provisionNotes: notes.slice(-40),
    status: 'active',
  });
}
