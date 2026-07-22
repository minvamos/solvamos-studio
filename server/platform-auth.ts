/**
 * Platform auth: email/password register & login, session creation, Google link helpers.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { prisma } from './db.js';
import {
  assertEmail,
  assertPasswordPolicy,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from './password.js';
import { provisionTenantForNewUser, ensureSharedCustomerTenant, sharedTenantId } from './tenant-seed.js';
import { setAuthCookies, clearAuthCookies, revokeSession, resolveAuthSessionId } from './jwt-auth.js';

export type PublicUser = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  tenantId: string | null;
  googleLinked: boolean;
  hasPassword: boolean;
  driveConnected: boolean;
};

export function clientMeta(req: Request): { userAgent?: string; ip?: string } {
  return {
    userAgent: req.headers['user-agent']?.slice(0, 400),
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress,
  };
}

export async function createSessionRow(opts: {
  userId: string;
  email: string;
  name?: string | null;
  picture?: string | null;
  tenantId?: string | null;
  via: 'password' | 'oauth' | 'adc' | 'link';
  accessToken?: string;
  refreshToken?: string;
  expiry?: number;
  userAgent?: string;
  ip?: string;
  sessionId?: string;
}): Promise<string> {
  const sid = opts.sessionId || `sess_${crypto.randomBytes(16).toString('hex')}`;
  await prisma.session.create({
    data: {
      id: sid,
      userId: opts.userId,
      email: opts.email,
      name: opts.name || null,
      picture: opts.picture || null,
      tenantId: opts.tenantId || null,
      via: opts.via,
      accessToken: opts.accessToken || null,
      refreshToken: opts.refreshToken || null,
      expiry: opts.expiry ? new Date(opts.expiry) : null,
      userAgent: opts.userAgent || null,
      ip: opts.ip || null,
    },
  });
  return sid;
}

export async function issueSessionCookies(
  res: Response,
  opts: {
    sid: string;
    userId: string;
    email: string;
    tenantId?: string | null;
  }
) {
  await setAuthCookies(res, {
    sid: opts.sid,
    uid: opts.userId,
    email: opts.email,
    tenantId: opts.tenantId || undefined,
  });
}

export async function toPublicUser(userId: string, sid?: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { members: true },
  });
  if (!user) return null;
  let driveConnected = false;
  if (sid) {
    const sess = await prisma.session.findUnique({ where: { id: sid } });
    driveConnected = !!(sess?.accessToken || sess?.refreshToken || sess?.via === 'adc');
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    tenantId: user.primaryTenantId || user.members[0]?.tenantId || null,
    googleLinked: !!user.googleSub,
    hasPassword: !!user.passwordHash,
    driveConnected,
  };
}

export async function registerWithPassword(input: {
  email: string;
  password: string;
  name?: string;
  orgName?: string;
  req: Request;
  res: Response;
}): Promise<{ user: PublicUser; sid: string }> {
  const emailErr = assertEmail(input.email);
  if (emailErr) throw Object.assign(new Error(emailErr), { status: 400 });
  const pwErr = assertPasswordPolicy(input.password);
  if (pwErr) throw Object.assign(new Error(pwErr), { status: 400 });

  const email = normalizeEmail(input.email);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw Object.assign(new Error('이미 가입된 이메일입니다. 로그인하거나 Google로 연동하세요.'), {
      status: 409,
    });
  }

  await ensureSharedCustomerTenant();
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || email.split('@')[0],
      passwordHash,
      emailVerifiedAt: null,
    },
  });

  const tenant = await provisionTenantForNewUser({
    userId: user.id,
    orgName: input.orgName,
  });

  const meta = clientMeta(input.req);
  const sid = await createSessionRow({
    userId: user.id,
    email: user.email,
    name: user.name,
    tenantId: tenant.tenantId,
    via: 'password',
    ...meta,
  });

  await issueSessionCookies(input.res, {
    sid,
    userId: user.id,
    email: user.email,
    tenantId: tenant.tenantId,
  });

  const pub = await toPublicUser(user.id, sid);
  return { user: pub!, sid };
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  req: Request;
  res: Response;
}): Promise<{ user: PublicUser; sid: string }> {
  const emailErr = assertEmail(input.email);
  if (emailErr) throw Object.assign(new Error(emailErr), { status: 400 });
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) {
    throw Object.assign(
      new Error(
        user?.googleSub
          ? '이 계정은 Google 로그인만 가능합니다. Google로 로그인하거나 비밀번호를 설정하세요.'
          : '이메일 또는 비밀번호가 올바르지 않습니다.'
      ),
      { status: 401 }
    );
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw Object.assign(new Error('이메일 또는 비밀번호가 올바르지 않습니다.'), { status: 401 });
  }

  let tenantId = user.primaryTenantId;
  if (!tenantId) {
    const tenant = await provisionTenantForNewUser({ userId: user.id });
    tenantId = tenant.tenantId;
  }

  const meta = clientMeta(input.req);
  const sid = await createSessionRow({
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    tenantId,
    via: 'password',
    ...meta,
  });

  await issueSessionCookies(input.res, {
    sid,
    userId: user.id,
    email: user.email,
    tenantId,
  });

  const pub = await toPublicUser(user.id, sid);
  return { user: pub!, sid };
}

export async function logoutRequest(req: Request, res: Response) {
  const sid = await resolveAuthSessionId(req);
  if (sid) await revokeSession(sid);
  clearAuthCookies(res);
}

export async function getMeFromRequest(req: Request): Promise<{
  connected: boolean;
  user: PublicUser | null;
  sessionId: string | null;
  sharedTenantId: string;
}> {
  const sid = await resolveAuthSessionId(req);
  if (!sid) {
    return {
      connected: false,
      user: null,
      sessionId: null,
      sharedTenantId: sharedTenantId(),
    };
  }
  const sess = await prisma.session.findUnique({ where: { id: sid } });
  if (!sess || sess.revokedAt || !sess.userId) {
    return {
      connected: false,
      user: null,
      sessionId: null,
      sharedTenantId: sharedTenantId(),
    };
  }
  const user = await toPublicUser(sess.userId, sid);
  return {
    connected: !!user,
    user,
    sessionId: sid,
    sharedTenantId: sharedTenantId(),
  };
}
