/**
 * Email/password auth + account (mypage) APIs.
 * Google OAuth routes stay in drive-oauth.ts (intent=login|signup|link).
 */
import type { Express, Request, Response, NextFunction } from 'express';
import {
  registerWithPassword,
  loginWithPassword,
  logoutRequest,
  getMeFromRequest,
  toPublicUser,
} from './platform-auth.js';
import { rotateRefreshSession, clearAuthCookies, resolveAuthSessionId } from './jwt-auth.js';
import { ensureSharedCustomerTenant, sharedTenantId } from './tenant-seed.js';
import { prisma } from './db.js';
import { isOAuthClientConfigured } from './drive-oauth.js';
import { config } from './config.js';

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

export async function requireUserSession(req: Request, res: Response, next: NextFunction) {
  const me = await getMeFromRequest(req);
  if (!me.connected || !me.user) {
    res.status(401).json({ status: 'error', message: '로그인이 필요합니다' });
    return;
  }
  (req as any).solvamosUser = me.user;
  (req as any).solvamosSessionId = me.sessionId;
  next();
}

export function registerPlatformAuthRoutes(app: Express) {
  app.post('/api/auth/register', async (req, res) => {
    noStore(res);
    try {
      if (!process.env.DATABASE_URL) {
        res.status(503).json({ status: 'error', message: 'DATABASE_URL required for signup' });
        return;
      }
      const { email, password, name, orgName } = req.body || {};
      const result = await registerWithPassword({
        email: String(email || ''),
        password: String(password || ''),
        name: name ? String(name) : undefined,
        orgName: orgName ? String(orgName) : undefined,
        req,
        res,
      });
      res.status(201).json({
        status: 'success',
        registered: true,
        sessionId: result.sid,
        user: result.user,
        tenant: {
          tenantId: result.user.tenantId,
          mode: 'shared',
          projectId: config.gcpProject || null,
          note: 'Lab: 고객 GCP = 공유 GOOGLE_CLOUD_PROJECT (DB에 테넌트·멤버십 생성됨)',
        },
      });
    } catch (err: any) {
      res.status(err.status || 500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    noStore(res);
    try {
      if (!process.env.DATABASE_URL) {
        res.status(503).json({ status: 'error', message: 'DATABASE_URL required for login' });
        return;
      }
      const { email, password } = req.body || {};
      const result = await loginWithPassword({
        email: String(email || ''),
        password: String(password || ''),
        req,
        res,
      });
      res.json({
        status: 'success',
        sessionId: result.sid,
        user: result.user,
        connected: true,
      });
    } catch (err: any) {
      res.status(err.status || 500).json({ status: 'error', message: err.message });
    }
  });

  app.post('/api/auth/refresh', async (req, res) => {
    noStore(res);
    try {
      const rotated = await rotateRefreshSession(req, res);
      if (!rotated) {
        clearAuthCookies(res);
        res.status(401).json({ status: 'error', message: '세션이 만료되었습니다. 다시 로그인하세요.' });
        return;
      }
      const user = rotated.uid ? await toPublicUser(rotated.uid, rotated.sid) : null;
      res.json({
        status: 'success',
        refreshed: true,
        user,
        sessionId: rotated.sid,
      });
    } catch (err: any) {
      res.status(401).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    noStore(res);
    const me = await getMeFromRequest(req);
    res.json({
      status: 'success',
      connected: me.connected,
      user: me.user,
      sessionId: me.sessionId,
      email: me.user?.email || null,
      tenantId: me.user?.tenantId || null,
      oauthConfigured: isOAuthClientConfigured(),
      sharedTenantId: me.sharedTenantId,
      googleLinked: me.user?.googleLinked || false,
      driveConnected: me.user?.driveConnected || false,
    });
  });

  app.post('/api/auth/logout', async (req, res) => {
    noStore(res);
    await logoutRequest(req, res);
    res.json({ status: 'success', connected: false });
  });

  /** Account / mypage snapshot */
  app.get('/api/account/me', requireUserSession, async (req, res) => {
    noStore(res);
    const user = (req as any).solvamosUser;
    const sid = (req as any).solvamosSessionId as string;
    const tenant = await ensureSharedCustomerTenant();
    const membership = await prisma.tenantMember.findUnique({
      where: {
        tenantId_userId: { tenantId: user.tenantId || sharedTenantId(), userId: user.id },
      },
    });
    res.json({
      status: 'success',
      user,
      sessionId: sid,
      tenant: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        projectId: tenant.projectId,
        tenancyMode: tenant.tenancyMode,
        sharedProject: tenant.sharedProject,
        role: membership?.role || null,
        provisionNotes: tenant.provisionNotes || [],
      },
      google: {
        linked: user.googleLinked,
        driveConnected: user.driveConnected,
        linkUrl: isOAuthClientConfigured() ? '/api/auth/google?intent=link' : null,
      },
    });
  });

  /** Explicit Lab provision API — ensures shared customer tenant + membership exist */
  app.post('/api/tenants/provision-lab', requireUserSession, async (req, res) => {
    noStore(res);
    try {
      const user = (req as any).solvamosUser;
      const { provisionTenantForNewUser } = await import('./tenant-seed.js');
      const orgName = req.body?.orgName ? String(req.body.orgName) : undefined;
      const tenant = await provisionTenantForNewUser({ userId: user.id, orgName });
      res.json({
        status: 'success',
        tenant,
        message:
          'Lab 프로비저닝: 공유 GCP 프로젝트를 고객 프로젝트로 DB에 바인딩했습니다. (Org 프로젝트 생성 없음)',
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });
}
