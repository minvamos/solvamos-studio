/**
 * Persist / load Google token fields on Session (file cache hydrate).
 */
import { prisma } from './db.js';

export type SessionPayload = {
  refreshToken?: string;
  accessToken?: string;
  email?: string;
  name?: string;
  picture?: string;
  expiry?: number;
  via?: 'oauth' | 'adc' | 'password' | 'link';
  tenantId?: string;
  createdAt?: string;
  userId?: string;
};

export async function upsertUserAndSession(sessionId: string, session: SessionPayload): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await prisma.session.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        userId: session.userId || null,
        email: session.email || null,
        name: session.name || null,
        picture: session.picture || null,
        accessToken: session.accessToken || null,
        refreshToken: session.refreshToken || null,
        expiry: session.expiry ? new Date(session.expiry) : null,
        via: session.via || 'oauth',
        tenantId: null,
      },
      update: {
        userId: session.userId || undefined,
        email: session.email || undefined,
        name: session.name || undefined,
        picture: session.picture || undefined,
        accessToken: session.accessToken || undefined,
        refreshToken: session.refreshToken || undefined,
        expiry: session.expiry ? new Date(session.expiry) : undefined,
        via: session.via || undefined,
      },
    });
    if (session.tenantId) {
      await prisma.session
        .update({ where: { id: sessionId }, data: { tenantId: session.tenantId } })
        .catch(() => undefined);
    }
  } catch (err: any) {
    console.warn('[session-db] upsert failed', err?.message || err);
  }
}

export async function loadSessionFromDb(sessionId: string): Promise<SessionPayload | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const row = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!row || row.revokedAt) return null;
    return {
      refreshToken: row.refreshToken || undefined,
      accessToken: row.accessToken || undefined,
      email: row.email || undefined,
      name: row.name || undefined,
      picture: row.picture || undefined,
      expiry: row.expiry ? row.expiry.getTime() : undefined,
      via: (row.via as SessionPayload['via']) || 'oauth',
      tenantId: row.tenantId || undefined,
      createdAt: row.createdAt.toISOString(),
      userId: row.userId || undefined,
    };
  } catch (err: any) {
    console.warn('[session-db] load failed', err?.message || err);
    return null;
  }
}

export async function deleteSessionFromDb(sessionId: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await prisma.session
      .update({
        where: { id: sessionId },
        data: { revokedAt: new Date(), refreshTokenHash: null },
      })
      .catch(() => undefined);
  } catch (err: any) {
    console.warn('[session-db] delete failed', err?.message || err);
  }
}
