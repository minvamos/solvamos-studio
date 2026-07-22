/**
 * Tenant registry — PostgreSQL (Prisma).
 */

import { prisma } from './db.js';
import type { Tenant as DbTenant } from '@prisma/client';

export type TenantRecord = {
  tenantId: string;
  displayName: string;
  projectId: string;
  folderId?: string;
  tier: 'starter' | 'professional' | 'enterprise';
  status: 'provisioning' | 'active' | 'error' | 'byo';
  createdAt: string;
  kmsKeyId?: string;
  cloudRunUri?: string;
  cloudRunServiceName?: string;
  cloudRunStatus?: 'active' | 'pending_image' | 'skipped' | 'error' | string;
  errorMessage?: string;
  byoProject?: boolean;
  tenancyMode?: 'shared' | 'isolated';
  sharedProject?: boolean;
  provisionNotes?: string[];
};

function toRecord(t: DbTenant): TenantRecord {
  return {
    tenantId: t.id,
    displayName: t.displayName,
    projectId: t.projectId,
    folderId: t.folderId || undefined,
    tier: t.tier as TenantRecord['tier'],
    status: t.status as TenantRecord['status'],
    createdAt: t.createdAt.toISOString(),
    kmsKeyId: t.kmsKeyId || undefined,
    cloudRunUri: t.cloudRunUri || undefined,
    cloudRunServiceName: t.cloudRunServiceName || undefined,
    cloudRunStatus: t.cloudRunStatus || undefined,
    errorMessage: t.errorMessage || undefined,
    byoProject: t.byoProject,
    tenancyMode: (t.tenancyMode as TenantRecord['tenancyMode']) || undefined,
    sharedProject: t.sharedProject,
    provisionNotes: Array.isArray(t.provisionNotes)
      ? (t.provisionNotes as string[])
      : undefined,
  };
}

export async function loadTenants(): Promise<void> {
  const n = await prisma.tenant.count();
  console.log(`Loaded ${n} tenants from database.`);
}

export async function listTenants(): Promise<TenantRecord[]> {
  const rows = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toRecord);
}

export async function getTenant(tenantId: string): Promise<TenantRecord | undefined> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  return t ? toRecord(t) : undefined;
}

export async function upsertTenant(record: TenantRecord): Promise<TenantRecord> {
  const saved = await prisma.tenant.upsert({
    where: { id: record.tenantId },
    create: {
      id: record.tenantId,
      displayName: record.displayName,
      projectId: record.projectId,
      folderId: record.folderId || null,
      tier: record.tier,
      status: record.status,
      kmsKeyId: record.kmsKeyId || null,
      cloudRunUri: record.cloudRunUri || null,
      cloudRunServiceName: record.cloudRunServiceName || null,
      cloudRunStatus: record.cloudRunStatus || null,
      errorMessage: record.errorMessage || null,
      byoProject: !!record.byoProject,
      tenancyMode: record.tenancyMode || null,
      sharedProject: record.sharedProject !== false,
      provisionNotes: record.provisionNotes || undefined,
    },
    update: {
      displayName: record.displayName,
      projectId: record.projectId,
      folderId: record.folderId || null,
      tier: record.tier,
      status: record.status,
      kmsKeyId: record.kmsKeyId || null,
      cloudRunUri: record.cloudRunUri || null,
      cloudRunServiceName: record.cloudRunServiceName || null,
      cloudRunStatus: record.cloudRunStatus || null,
      errorMessage: record.errorMessage || null,
      byoProject: !!record.byoProject,
      tenancyMode: record.tenancyMode || null,
      sharedProject: record.sharedProject !== false,
      provisionNotes: record.provisionNotes || undefined,
    },
  });
  return toRecord(saved);
}

export async function projectIdForTenant(tenantId: string): Promise<string | undefined> {
  const t = await getTenant(tenantId);
  return t?.projectId;
}
