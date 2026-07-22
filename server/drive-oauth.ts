/**
 * Google OAuth + Drive.readonly.
 * Account login/register is email/password (auth-routes). Google is used for:
 *   intent=signup | login | link (Drive + identity link)
 */
import crypto from 'crypto';
import fs from 'fs';
import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { dataFile, ensureDataDir } from './data-paths.js';
import { setAuthCookies, resolveAuthSessionId, revokeSession } from './jwt-auth.js';
import { loadSessionFromDb } from './session-db.js';
import { prisma } from './db.js';
import { normalizeEmail } from './password.js';
import {
  createSessionRow,
  issueSessionCookies,
  clientMeta,
  getMeFromRequest,
} from './platform-auth.js';
import { provisionTenantForNewUser, ensureSharedCustomerTenant } from './tenant-seed.js';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.readonly',
];

const ADC_SESSION_ID = 'adc_local';
const SESSION_FILE = dataFile('oauth-sessions.json');
const STATE_TTL_MS = 15 * 60 * 1000;

type OAuthSession = {
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

type OAuthIntent = 'login' | 'signup' | 'link';

type PendingState = {
  sessionId: string;
  createdAt: number;
  intent: OAuthIntent;
  linkUserId?: string;
};

let oauthSessions: Record<string, OAuthSession> = {};
const pendingStates: Record<string, PendingState> = {};

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      oauthSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch {
    oauthSessions = {};
  }
}

function saveSessions() {
  try {
    ensureDataDir();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(oauthSessions, null, 2));
  } catch (err) {
    console.warn('[oauth] failed to persist sessions (file)', err);
  }
}

loadSessions();

function allowAdcDrive(): boolean {
  return process.env.ALLOW_ADC_DRIVE === 'true' || process.env.ALLOW_ADC_DRIVE === '1';
}

export function isOAuthClientConfigured(): boolean {
  return !!(config.googleClientId && config.googleClientSecret);
}

export function isDriveAuthAvailable(): boolean {
  return isOAuthClientConfigured() || allowAdcDrive();
}

function oauthClient(redirectUri?: string) {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const redirect = redirectUri || config.oauthRedirectUri;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirect);
}

export async function resolveSessionId(req: Request): Promise<string | undefined> {
  const id = await resolveAuthSessionId(req);
  if (!id) return undefined;
  if (!oauthSessions[id]) {
    const fromDb = await loadSessionFromDb(id);
    if (fromDb) oauthSessions[id] = fromDb as OAuthSession;
  }
  return id;
}

export function getSession(sessionId: string) {
  return oauthSessions[sessionId];
}

export async function destroySession(sessionId: string) {
  delete oauthSessions[sessionId];
  saveSessions();
  await revokeSession(sessionId);
}

function cacheSession(sid: string, session: OAuthSession) {
  oauthSessions[sid] = session;
  saveSessions();
}

export function getAuthUrl(state: string): string {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

async function exchangeCode(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const me = await oauth2.userinfo.get();
  const tokenInfo = await client.getTokenInfo(tokens.access_token!).catch(() => null);
  return {
    tokens,
    email: normalizeEmail(me.data.email || ''),
    name: me.data.name || undefined,
    picture: me.data.picture || undefined,
    googleSub: (tokenInfo as any)?.sub || me.data.id || undefined,
  };
}

function successRedirect(opts: { email?: string; linked?: boolean; error?: string }) {
  const url = new URL('/', config.appUrl);
  if (opts.error) {
    url.searchParams.set('auth_error', opts.error);
  } else {
    url.searchParams.set('logged_in', '1');
    if (opts.email) url.searchParams.set('email', opts.email);
    if (opts.linked) url.searchParams.set('google_linked', '1');
  }
  return url.pathname + url.search;
}

function prunePendingStates() {
  const now = Date.now();
  for (const [k, v] of Object.entries(pendingStates)) {
    if (now - v.createdAt > STATE_TTL_MS) delete pendingStates[k];
  }
}

async function attachGoogleTokensToSession(
  sid: string,
  tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  }
) {
  const accessToken = tokens.access_token || undefined;
  const refreshToken = tokens.refresh_token || undefined;
  const expiry = tokens.expiry_date || undefined;
  await prisma.session.update({
    where: { id: sid },
    data: {
      accessToken: accessToken || undefined,
      refreshToken: refreshToken || undefined,
      expiry: expiry ? new Date(expiry) : undefined,
      via: 'oauth',
    },
  });
  const row = await prisma.session.findUnique({ where: { id: sid } });
  if (row) {
    cacheSession(sid, {
      accessToken: row.accessToken || undefined,
      refreshToken: row.refreshToken || undefined,
      email: row.email || undefined,
      name: row.name || undefined,
      picture: row.picture || undefined,
      expiry: row.expiry?.getTime(),
      via: 'oauth',
      tenantId: row.tenantId || undefined,
      userId: row.userId || undefined,
    });
  }
}

/** Complete Google OAuth for signup / login / link. */
export async function completeGoogleOAuth(opts: {
  code: string;
  intent: OAuthIntent;
  linkUserId?: string;
  req: Request;
  res: Response;
  preferredSessionId?: string;
}): Promise<{ email?: string; linked?: boolean }> {
  const profile = await exchangeCode(opts.code);
  if (!profile.email) throw new Error('Google 계정에서 이메일을 가져오지 못했습니다');

  const meta = clientMeta(opts.req);

  // --- LINK (logged-in user attaches Google) ---
  if (opts.intent === 'link') {
    if (!opts.linkUserId) throw new Error('연동할 로그인 세션이 없습니다');
    const user = await prisma.user.findUnique({ where: { id: opts.linkUserId } });
    if (!user) throw new Error('사용자를 찾을 수 없습니다');

    if (profile.googleSub) {
      const taken = await prisma.user.findFirst({
        where: { googleSub: profile.googleSub, NOT: { id: user.id } },
      });
      if (taken) throw new Error('이 Google 계정은 다른 SolVamos 계정에 이미 연동되어 있습니다');
    }
    if (user.email !== profile.email) {
      const emailTaken = await prisma.user.findFirst({
        where: { email: profile.email, NOT: { id: user.id } },
      });
      if (emailTaken) {
        throw new Error('Google 이메일이 다른 계정과 충돌합니다. 같은 이메일로 가입했는지 확인하세요.');
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        googleSub: profile.googleSub || user.googleSub,
        picture: profile.picture || user.picture,
        name: user.name || profile.name,
        emailVerifiedAt: new Date(),
      },
    });

    // Prefer existing session from cookies; else create
    let sid = await resolveAuthSessionId(opts.req);
    if (!sid || !(await prisma.session.findUnique({ where: { id: sid } }))?.userId) {
      sid = await createSessionRow({
        userId: user.id,
        email: user.email,
        name: user.name,
        picture: profile.picture || user.picture,
        tenantId: user.primaryTenantId,
        via: 'link',
        accessToken: profile.tokens.access_token || undefined,
        refreshToken: profile.tokens.refresh_token || undefined,
        expiry: profile.tokens.expiry_date || undefined,
        sessionId: opts.preferredSessionId,
        ...meta,
      });
    } else {
      await attachGoogleTokensToSession(sid, profile.tokens);
    }

    await issueSessionCookies(opts.res, {
      sid,
      userId: user.id,
      email: user.email,
      tenantId: user.primaryTenantId,
    });
    await attachGoogleTokensToSession(sid, profile.tokens);
    return { email: user.email, linked: true };
  }

  // --- SIGNUP ---
  if (opts.intent === 'signup') {
    let user = await prisma.user.findUnique({ where: { email: profile.email } });
    if (user?.passwordHash && !user.googleSub) {
      throw new Error(
        '이미 이메일로 가입된 계정입니다. 로그인 후 마이페이지에서 Google을 연동하세요.'
      );
    }
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: profile.email,
          name: profile.name || profile.email.split('@')[0],
          picture: profile.picture,
          googleSub: profile.googleSub,
          emailVerifiedAt: new Date(),
        },
      });
      await provisionTenantForNewUser({ userId: user.id });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          googleSub: profile.googleSub || user.googleSub,
          picture: profile.picture || user.picture,
          emailVerifiedAt: user.emailVerifiedAt || new Date(),
        },
      });
      if (!user.primaryTenantId) await provisionTenantForNewUser({ userId: user.id });
    }

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const sid = await createSessionRow({
      userId: fresh.id,
      email: fresh.email,
      name: fresh.name,
      picture: fresh.picture,
      tenantId: fresh.primaryTenantId,
      via: 'oauth',
      accessToken: profile.tokens.access_token || undefined,
      refreshToken: profile.tokens.refresh_token || undefined,
      expiry: profile.tokens.expiry_date || undefined,
      sessionId: opts.preferredSessionId,
      ...meta,
    });
    cacheSession(sid, {
      accessToken: profile.tokens.access_token || undefined,
      refreshToken: profile.tokens.refresh_token || undefined,
      email: fresh.email,
      name: fresh.name || undefined,
      picture: fresh.picture || undefined,
      expiry: profile.tokens.expiry_date || undefined,
      via: 'oauth',
      tenantId: fresh.primaryTenantId || undefined,
      userId: fresh.id,
    });
    await issueSessionCookies(opts.res, {
      sid,
      userId: fresh.id,
      email: fresh.email,
      tenantId: fresh.primaryTenantId,
    });
    return { email: fresh.email };
  }

  // --- LOGIN (default) ---
  let user =
    (profile.googleSub
      ? await prisma.user.findUnique({ where: { googleSub: profile.googleSub } })
      : null) || (await prisma.user.findUnique({ where: { email: profile.email } }));

  if (!user) {
    throw new Error('가입되지 않은 Google 계정입니다. 회원가입을 먼저 진행하세요.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      googleSub: profile.googleSub || user.googleSub,
      picture: profile.picture || user.picture,
      name: user.name || profile.name,
      emailVerifiedAt: user.emailVerifiedAt || new Date(),
    },
  });
  if (!user.primaryTenantId) {
    await provisionTenantForNewUser({ userId: user.id });
    user = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  const sid = await createSessionRow({
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    tenantId: user.primaryTenantId,
    via: 'oauth',
    accessToken: profile.tokens.access_token || undefined,
    refreshToken: profile.tokens.refresh_token || undefined,
    expiry: profile.tokens.expiry_date || undefined,
    sessionId: opts.preferredSessionId,
    ...meta,
  });
  cacheSession(sid, {
    accessToken: profile.tokens.access_token || undefined,
    refreshToken: profile.tokens.refresh_token || undefined,
    email: user.email,
    name: user.name || undefined,
    picture: user.picture || undefined,
    expiry: profile.tokens.expiry_date || undefined,
    via: 'oauth',
    tenantId: user.primaryTenantId || undefined,
    userId: user.id,
  });
  await issueSessionCookies(opts.res, {
    sid,
    userId: user.id,
    email: user.email,
    tenantId: user.primaryTenantId,
  });
  return { email: user.email };
}

export async function connectViaAdc(): Promise<OAuthSession> {
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token || undefined;
  let email = process.env.GOOGLE_ADC_EMAIL || 'adc-local@gcloud';
  let name: string | undefined;
  let picture: string | undefined;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client as any });
    const me = await oauth2.userinfo.get();
    email = normalizeEmail(me.data.email || email);
    name = me.data.name || undefined;
    picture = me.data.picture || undefined;
  } catch {
    /* keep defaults */
  }

  await ensureSharedCustomerTenant();
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name: name || email, picture, emailVerifiedAt: new Date() },
    });
    await provisionTenantForNewUser({ userId: user.id });
  }
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const sid = ADC_SESSION_ID;
  await prisma.session.upsert({
    where: { id: sid },
    create: {
      id: sid,
      userId: fresh.id,
      email: fresh.email,
      name: fresh.name,
      picture: fresh.picture,
      accessToken,
      via: 'adc',
      expiry: new Date(Date.now() + 45 * 60 * 1000),
      tenantId: fresh.primaryTenantId,
    },
    update: {
      accessToken,
      via: 'adc',
      expiry: new Date(Date.now() + 45 * 60 * 1000),
      tenantId: fresh.primaryTenantId,
    },
  });
  const session: OAuthSession = {
    accessToken,
    email: fresh.email,
    name: fresh.name || undefined,
    picture: fresh.picture || undefined,
    via: 'adc',
    expiry: Date.now() + 45 * 60 * 1000,
    tenantId: fresh.primaryTenantId || undefined,
    userId: fresh.id,
    createdAt: new Date().toISOString(),
  };
  cacheSession(sid, session);
  return session;
}

export async function authedDrive(sessionId: string) {
  let session = oauthSessions[sessionId];
  if (!session) {
    const fromDb = await loadSessionFromDb(sessionId);
    if (fromDb) {
      oauthSessions[sessionId] = fromDb as OAuthSession;
      session = oauthSessions[sessionId];
    }
  }
  if (!session) throw new Error('Not authenticated with Google');

  if (session.via === 'adc' || sessionId === ADC_SESSION_ID) {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const client = await auth.getClient();
    return google.drive({ version: 'v3', auth: client as any });
  }

  if (!session.refreshToken && !session.accessToken) {
    throw new Error('Google Drive가 연동되지 않았습니다. 마이페이지에서 Google을 연결하세요.');
  }
  const client = oauthClient();
  client.setCredentials({
    refresh_token: session.refreshToken,
    access_token: session.accessToken,
    expiry_date: session.expiry,
  });
  client.on('tokens', (tokens) => {
    if (tokens.access_token) session!.accessToken = tokens.access_token;
    if (tokens.refresh_token) session!.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date) session!.expiry = tokens.expiry_date;
    saveSessions();
    void prisma.session
      .update({
        where: { id: sessionId },
        data: {
          accessToken: session!.accessToken || null,
          refreshToken: session!.refreshToken || null,
          expiry: session!.expiry ? new Date(session!.expiry) : null,
        },
      })
      .catch(() => undefined);
  });
  return google.drive({ version: 'v3', auth: client });
}

export async function listDriveChildren(
  sessionId: string,
  parentId = 'root',
  opts?: { foldersOnly?: boolean }
) {
  const drive = await authedDrive(sessionId);
  const safeParent = String(parentId).replace(/'/g, "\\'");
  const foldersOnly = !!opts?.foldersOnly;
  const typeFilter = foldersOnly
    ? ` and mimeType = 'application/vnd.google-apps.folder'`
    : '';
  const res = await drive.files.list({
    q: `'${safeParent}' in parents and trashed = false${typeFilter}`,
    fields: 'files(id, name, mimeType, parents, modifiedTime, size, webViewLink)',
    pageSize: 200,
    orderBy: 'folder,name',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name || '(untitled)',
    mimeType: f.mimeType || 'application/octet-stream',
    parents: f.parents || undefined,
    modifiedTime: f.modifiedTime || undefined,
    size: f.size || undefined,
    webViewLink: f.webViewLink || undefined,
    kind:
      f.mimeType === 'application/vnd.google-apps.folder' ? ('folder' as const) : ('file' as const),
  }));
}

export async function listDriveFolders(sessionId: string, parentId = 'root') {
  return listDriveChildren(sessionId, parentId, { foldersOnly: true });
}

/** Soft: logged-in user enough for Studio APIs; Drive still needs Google tokens. */
export async function requireGoogleSession(req: Request, res: Response, next: NextFunction) {
  const me = await getMeFromRequest(req);
  if (!me.connected) {
    res.status(401).json({ status: 'error', message: '로그인이 필요합니다' });
    return;
  }
  (req as any).solvamosSessionId = me.sessionId;
  (req as any).solvamosUser = me.user;
  next();
}

export function registerDriveAuthRoutes(app: import('express').Express) {
  app.get('/api/auth/google', async (req: Request, res: Response) => {
    try {
      const intentRaw = String(req.query.intent || 'login').toLowerCase();
      const intent: OAuthIntent =
        intentRaw === 'signup' || intentRaw === 'link' ? intentRaw : 'login';

      if (!isOAuthClientConfigured()) {
        if (allowAdcDrive() && intent !== 'link') {
          const session = await connectViaAdc();
          if (session.userId) {
            await setAuthCookies(res, {
              sid: ADC_SESSION_ID,
              uid: session.userId,
              email: session.email,
              tenantId: session.tenantId,
            });
          }
          res.json({
            status: 'success',
            mode: 'adc',
            sessionId: ADC_SESSION_ID,
            authUrl: null,
            user: {
              email: session.email,
              name: session.name,
              tenantId: session.tenantId,
              connected: true,
            },
          });
          return;
        }
        res.status(503).json({
          status: 'error',
          message: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured',
        });
        return;
      }

      prunePendingStates();
      const sessionId = `sess_${crypto.randomBytes(16).toString('hex')}`;
      const state = crypto.randomBytes(24).toString('hex');
      let linkUserId: string | undefined;

      if (intent === 'link') {
        const me = await getMeFromRequest(req);
        if (!me.user) {
          res.status(401).json({ status: 'error', message: 'Google 연동은 로그인 후 가능합니다' });
          return;
        }
        linkUserId = me.user.id;
      }

      pendingStates[state] = { sessionId, createdAt: Date.now(), intent, linkUserId };
      const url = getAuthUrl(state);
      res.json({
        status: 'success',
        authUrl: url,
        sessionId,
        mode: 'oauth',
        intent,
        message: 'Redirect browser to authUrl',
      });
    } catch (err: any) {
      res.status(503).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string;
      const oauthError = req.query.error as string | undefined;
      if (oauthError) {
        res.redirect(successRedirect({ error: `OAuth denied: ${oauthError}` }));
        return;
      }
      if (!code || !state) {
        res.redirect(successRedirect({ error: 'Missing code or state' }));
        return;
      }
      prunePendingStates();
      const pending = pendingStates[state];
      delete pendingStates[state];
      if (!pending) {
        res.redirect(successRedirect({ error: '만료된 로그인 요청입니다. 다시 시도하세요.' }));
        return;
      }

      const result = await completeGoogleOAuth({
        code,
        intent: pending.intent,
        linkUserId: pending.linkUserId,
        preferredSessionId: pending.sessionId,
        req,
        res,
      });
      res.redirect(successRedirect(result));
    } catch (err: any) {
      console.error('[oauth] callback', err);
      res.redirect(successRedirect({ error: err.message || 'OAuth error' }));
    }
  });

  app.get('/api/drive/folders', async (req: Request, res: Response) => {
    try {
      const sessionId = await resolveSessionId(req);
      if (!sessionId) {
        res.status(401).json({ status: 'error', message: '로그인이 필요합니다' });
        return;
      }
      const parent = typeof req.query.parent === 'string' ? req.query.parent : 'root';
      if (parent !== 'root' && !/^[a-zA-Z0-9_-]+$/.test(parent)) {
        res.status(400).json({ status: 'error', message: 'Invalid parent id' });
        return;
      }
      const foldersOnly = req.query.foldersOnly === 'true' || req.query.foldersOnly === '1';
      const items = await listDriveChildren(sessionId, parent, { foldersOnly });
      res.json({
        status: 'success',
        parent,
        items,
        folders: items.filter((i) => i.kind === 'folder'),
      });
    } catch (err: any) {
      const needsApi =
        /Drive API has not been used|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication|연동되지/i.test(
          err.message || ''
        );
      res.status(needsApi ? 503 : 401).json({
        status: 'error',
        message: err.message,
      });
    }
  });
}
