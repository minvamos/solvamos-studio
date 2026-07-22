/**
 * Production JWT session cookies.
 * - Short-lived access + long-lived refresh
 * - Refresh token hash stored on Session (rotation + reuse → revoke)
 * - Prod never trusts bare sid cookie / query session
 */
import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { prisma } from './db.js';

const ACCESS_COOKIE = 'solvamos_at';
const REFRESH_COOKIE = 'solvamos_rt';
const SID_COOKIE = 'solvamos_sid';

/** Access TTL — keep short in prod */
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || (config.isProd ? '15m' : '12h');
const ACCESS_MAX_AGE_SEC = Number(process.env.JWT_ACCESS_MAX_AGE || (config.isProd ? 15 * 60 : 12 * 3600));
const REFRESH_TTL_SEC = Number(process.env.JWT_REFRESH_DAYS || 30) * 24 * 3600;
const REFRESH_DAYS = Math.max(1, Math.floor(REFRESH_TTL_SEC / 86400));

export type JwtClaims = {
  sid: string;
  uid?: string;
  email?: string;
  tenantId?: string;
  typ: 'access' | 'refresh';
  jti?: string;
};

function secretKey(): Uint8Array {
  const raw = process.env.JWT_SECRET || '';
  if (raw.length >= 32) return new TextEncoder().encode(raw);
  if (config.isProd) {
    throw new Error('JWT_SECRET (>=32 chars) is required in production');
  }
  const fallback = crypto.createHash('sha256').update(`solvamos-dev:${config.gcpProject || 'local'}`).digest();
  return new Uint8Array(fallback);
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function signAccessToken(claims: Omit<JwtClaims, 'typ' | 'jti'>): Promise<string> {
  return new SignJWT({ ...claims, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .setIssuer('solvamos-studio')
    .setAudience('solvamos-studio')
    .sign(secretKey());
}

export async function signRefreshToken(
  claims: Omit<JwtClaims, 'typ'> & { jti: string }
): Promise<string> {
  return new SignJWT({ ...claims, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_DAYS}d`)
    .setIssuer('solvamos-studio')
    .setAudience('solvamos-studio')
    .setJti(claims.jti)
    .sign(secretKey());
}

export async function verifyToken(token: string, typ: 'access' | 'refresh'): Promise<JwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: 'solvamos-studio',
      audience: 'solvamos-studio',
    });
    if (payload.typ !== typ) return null;
    if (typeof payload.sid !== 'string' || !payload.sid) return null;
    return {
      sid: payload.sid,
      uid: typeof payload.uid === 'string' ? payload.uid : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
      typ,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}

function cookieFlags(maxAge: number): string {
  const secure = config.isProd ? '; Secure' : '';
  // SameSite=Lax: OAuth top-level redirects still send cookies
  return `Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

export function clearAuthCookies(res: Response) {
  const clear = `Path=/; HttpOnly; SameSite=Lax${config.isProd ? '; Secure' : ''}; Max-Age=0`;
  res.append('Set-Cookie', `${ACCESS_COOKIE}=; ${clear}`);
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; ${clear}`);
  res.append('Set-Cookie', `${SID_COOKIE}=; ${clear}`);
}

export type SessionCookieOpts = {
  sid: string;
  uid?: string;
  email?: string;
  tenantId?: string;
};

/** Issue access+refresh cookies and persist refresh hash on Session. */
export async function setAuthCookies(res: Response, opts: SessionCookieOpts): Promise<string> {
  const jti = crypto.randomBytes(16).toString('hex');
  const access = await signAccessToken({
    sid: opts.sid,
    uid: opts.uid,
    email: opts.email,
    tenantId: opts.tenantId,
  });
  const refresh = await signRefreshToken({
    sid: opts.sid,
    uid: opts.uid,
    email: opts.email,
    tenantId: opts.tenantId,
    jti,
  });

  res.append('Set-Cookie', `${ACCESS_COOKIE}=${encodeURIComponent(access)}; ${cookieFlags(ACCESS_MAX_AGE_SEC)}`);
  res.append('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(refresh)}; ${cookieFlags(REFRESH_TTL_SEC)}`);
  res.append('Set-Cookie', `${SID_COOKIE}=${encodeURIComponent(opts.sid)}; ${cookieFlags(REFRESH_TTL_SEC)}`);

  const refreshHash = hashRefreshToken(refresh);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_SEC * 1000);
  if (process.env.DATABASE_URL) {
    await prisma.session
      .update({
        where: { id: opts.sid },
        data: {
          refreshTokenHash: refreshHash,
          refreshExpiresAt,
          revokedAt: null,
        },
      })
      .catch(() => undefined);
  }
  return refresh;
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Resolve session id from verified access JWT only (prod). Refresh handled by /api/auth/refresh. */
export async function resolveAuthSessionId(req: Request): Promise<string | undefined> {
  const cookies = parseCookies(req);
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : undefined;

  const access = cookies[ACCESS_COOKIE] || bearer;
  if (access) {
    const claims = await verifyToken(access, 'access');
    if (claims?.sid) {
      if (process.env.DATABASE_URL) {
        const row = await prisma.session.findUnique({ where: { id: claims.sid } });
        if (!row || row.revokedAt) return undefined;
      }
      return claims.sid;
    }
  }

  // Dev-only soft paths (never in production)
  if (!config.isProd) {
    const refresh = cookies[REFRESH_COOKIE];
    if (refresh) {
      const claims = await verifyToken(refresh, 'refresh');
      if (claims?.sid) return claims.sid;
    }
    if (cookies[SID_COOKIE]) return cookies[SID_COOKIE];
    const headerSid = req.headers['x-solvamos-session'];
    if (typeof headerSid === 'string' && headerSid.trim()) return headerSid.trim();
    if (typeof req.query.session === 'string' && req.query.session.trim()) {
      return req.query.session.trim();
    }
  }

  return undefined;
}

/**
 * Rotate refresh token. Reuse of an old refresh hash → revoke all user sessions.
 */
export async function rotateRefreshSession(
  req: Request,
  res: Response
): Promise<{ sid: string; email?: string; tenantId?: string; uid?: string } | null> {
  const cookies = parseCookies(req);
  const rt = cookies[REFRESH_COOKIE];
  if (!rt) return null;
  const claims = await verifyToken(rt, 'refresh');
  if (!claims?.sid) return null;

  if (!process.env.DATABASE_URL) {
    // No DB: still re-issue cookies from claims (dev)
    await setAuthCookies(res, {
      sid: claims.sid,
      uid: claims.uid,
      email: claims.email,
      tenantId: claims.tenantId,
    });
    return { sid: claims.sid, email: claims.email, tenantId: claims.tenantId, uid: claims.uid };
  }

  const row = await prisma.session.findUnique({ where: { id: claims.sid } });
  if (!row || row.revokedAt) {
    clearAuthCookies(res);
    return null;
  }
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() < Date.now()) {
    await prisma.session.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    clearAuthCookies(res);
    return null;
  }

  const presented = hashRefreshToken(rt);
  if (row.refreshTokenHash && row.refreshTokenHash !== presented) {
    // Refresh reuse — revoke all sessions for this user
    if (row.userId) {
      await prisma.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await prisma.session.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
    }
    clearAuthCookies(res);
    return null;
  }

  await setAuthCookies(res, {
    sid: row.id,
    uid: row.userId || undefined,
    email: row.email || claims.email,
    tenantId: row.tenantId || claims.tenantId,
  });

  return {
    sid: row.id,
    email: row.email || claims.email,
    tenantId: row.tenantId || claims.tenantId,
    uid: row.userId || undefined,
  };
}

export async function revokeSession(sid: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await prisma.session
    .update({
      where: { id: sid },
      data: { revokedAt: new Date(), refreshTokenHash: null },
    })
    .catch(() => undefined);
}

export { ACCESS_COOKIE, REFRESH_COOKIE, SID_COOKIE, REFRESH_TTL_SEC, ACCESS_MAX_AGE_SEC };
