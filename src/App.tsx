/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Agent, DriveItem, DrivePathCrumb, LocalUploadFile, Message, PromptOptions, Settlement } from './types';
import Landing from './Landing';
import AppShell, { AppTab } from './AppShell';
import StudioPage from './pages/StudioPage';
import AgentsPage from './pages/AgentsPage';
import AgentDetailPage, { type DetailTab } from './pages/AgentDetailPage';
import SettlementsPage from './pages/SettlementsPage';
import MyPage from './pages/MyPage';
import DevAgentLabPage from './pages/DevAgentLabPage';
import DevEvidencePage from './pages/DevEvidencePage';
import DevLogsPage from './pages/DevLogsPage';
import WalletModal, { type WalletRow } from './components/WalletModal';
import CreateAgentProgress, { CREATE_STEPS, EDIT_STEPS } from './components/CreateAgentProgress';
import { formatAgentChatMessage } from './lib/formatAgentMessage';
import { parseAppRoute, writeAppRoute, writeLandingRoute } from './lib/appRoute';

const CATALOG_MARKETPLACE =
  'https://solvamos-catalog-74094114833.asia-northeast3.run.app/marketplace';

export default function App() {
  const [view, setView] = useState<'landing' | 'studio' | 'boot'>('boot');
  const [landingBusy, setLandingBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('studio');

  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [serverStatus, setServerStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [createStepIndex, setCreateStepIndex] = useState(0);
  const [createPercent, setCreatePercent] = useState(0);
  const [createDetail, setCreateDetail] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [settlements, setSettlements] = useState<Settlement[]>([]);

  const [builderStep, setBuilderStep] = useState<1 | 2 | 3>(1);
  /** Studio hub vs create/edit form (URL ?agent= only for edit). */
  const [studioView, setStudioView] = useState<'landing' | 'builder'>('landing');
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  /** My-agents detail (`/agents?agent=`). */
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  /** Drive folder id when edit started — only send folder on PATCH if user changed it */
  const [editBaselineFolderId, setEditBaselineFolderId] = useState<string>('');
  const [savingAsEdit, setSavingAsEdit] = useState(false);
  const [options, setOptions] = useState<PromptOptions>({
    role: 'custom',
    customRole: '사내 HR/복지 안내',
    tone: 'casual',
    securityLevel: 'strict',
    fee: 0,
    runtimeMode: 'specialized',
    description: '',
    customInstructions: '',
    a2aPeersEnabled: true,
    aiAppType: 'search_docs',
    dataSourceType: 'local_upload',
  });
  const [agentName, setAgentName] = useState('');
  const [livePromptPreview, setLivePromptPreview] = useState('');
  const [creationResult, setCreationResult] = useState<any>(null);

  const [inputText, setInputText] = useState('');
  const [chatHistory, setChatHistory] = useState<Record<string, Message[]>>({});
  const [chatAttachments, setChatAttachments] = useState<
    import('./types').ChatAttachment[]
  >([]);
  const [enableWebSearch, setEnableWebSearch] = useState(false);
  const [answerSessions, setAnswerSessions] = useState<Record<string, string>>({});
  const [pendingPayment, setPendingPayment] = useState<{
    agentId: string;
    amount: number;
    token: string;
    recipientWallet: string;
    prompt: string;
    network?: string;
    paymentNetwork?: string;
    invokeUrl?: string;
    gatewayUrl?: string;
    message?: string;
  } | null>(null);
  const [paymentLogs, setPaymentLogs] = useState<string[]>([]);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [customSignature, setCustomSignature] = useState('');
  const [driveSessionId, setDriveSessionId] = useState<string>(
    () => localStorage.getItem('solvamos_drive_session') || ''
  );
  const [driveEmail, setDriveEmail] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [userPicture, setUserPicture] = useState<string | null>(null);
  const [driveItems, setDriveItems] = useState<DriveItem[]>([]);
  const [drivePath, setDrivePath] = useState<DrivePathCrumb[]>([]);
  const [driveParentId, setDriveParentId] = useState('root');
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [selectedDriveName, setSelectedDriveName] = useState<string | null>(null);
  const [selectedDriveKind, setSelectedDriveKind] = useState<'folder' | 'file' | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<LocalUploadFile[]>([]);
  const [tenantIdInput, setTenantIdInput] = useState('demo');

  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [primaryWallet, setPrimaryWallet] = useState<WalletRow | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  /** Avoid re-hydrating edit form on every agents poll when URL has ?agent=. */
  const hydratedEditIdRef = useRef<string | null>(null);

  const navigateTab = (
    tab: AppTab,
    options?: {
      replace?: boolean;
      agentId?: string | null;
      openBuilder?: boolean;
      detailTab?: DetailTab;
    }
  ) => {
    setView('studio');
    setActiveTab(tab);

    if (tab === 'studio') {
      setDetailAgentId(null);
      if (options?.agentId) {
        setStudioView('builder');
        writeAppRoute(tab, { replace: options.replace, agentId: options.agentId });
        return;
      }
      if (options?.openBuilder) {
        setStudioView('builder');
        writeAppRoute(tab, { replace: options.replace, agentId: null });
        return;
      }
      // Nav click / hub: never reopen a cached edit form
      setStudioView('landing');
      setEditingAgentId(null);
      hydratedEditIdRef.current = null;
      setCreationResult(null);
      setBuilderStep(1);
      writeAppRoute(tab, { replace: options?.replace, agentId: null });
      return;
    }

    if (tab === 'list') {
      const id = options?.agentId ?? null;
      setDetailAgentId(id);
      if (options?.detailTab) setDetailTab(options.detailTab);
      if (!id) setDetailTab('overview');
      writeAppRoute(tab, { replace: options?.replace, agentId: id });
      return;
    }

    writeAppRoute(tab, { replace: options?.replace, agentId: options?.agentId ?? null });
  };

  const hydrateEditForm = (agent: Agent) => {
    setEditBaselineFolderId(agent.googleDriveFolderId || '');
    setCreationResult(null);
    setBuilderStep(1);
    setOptions({
      role: (agent.role as PromptOptions['role']) || 'custom',
      customRole: agent.customRole || '',
      tone: agent.tone || '',
      securityLevel: (agent.securityLevel as PromptOptions['securityLevel']) || 'strict',
      fee: agent.fee ?? agent.perCallPriceUsdc ?? 0,
      runtimeMode:
        agent.runtimeMode === 'autonomous' ? 'autonomous' : 'specialized',
      description: agent.description || '',
      customInstructions: agent.customInstructions || '',
      a2aPeersEnabled: agent.a2aPeersEnabled !== false,
      aiAppType: (agent.aiAppType as PromptOptions['aiAppType']) || 'search_docs',
      dataSourceType: (agent.dataSourceType as PromptOptions['dataSourceType']) || 'local_upload',
      websiteUri: agent.websiteUri,
      gcsUri: agent.gcsUri,
    });
    setAgentName(agent.agentName || '');
    setSelectedFolderId(agent.googleDriveFolderId || '');
    setLocalFiles([]);
  };

  const authFetch = (url: string, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(init?.headers || {}),
      },
    });
  };

  /** Cookie JWT first; refresh once if access expired. */
  const ensureAuth = async (): Promise<any | null> => {
    const me = await authFetch('/api/auth/me');
    const data = await me.json();
    if (data?.connected || data?.user?.connected) return data;
    const refreshed = await authFetch('/api/auth/refresh', { method: 'POST' });
    if (!refreshed.ok) return null;
    const again = await authFetch('/api/auth/me');
    const data2 = await again.json();
    if (data2?.connected || data2?.user?.connected) return data2;
    return null;
  };

  const fetchStatusAndAgents = async () => {
    try {
      const statusRes = await fetch('/api/status', { cache: 'no-store' });
      const statusData = await statusRes.json();
      setServerStatus(statusData);

      const agentsRes = await fetch('/api/agents', { cache: 'no-store' });
      const agentsData = await agentsRes.json();
      if (agentsData.status === 'success') {
        setAgents(agentsData.data);
        // Do not auto-select first agent — that unlocked chat on the create page.
      }
      return statusData;
    } catch (err) {
      console.error('Failed to connect to backend api:', err);
      return null;
    }
  };

  const applyAuthUser = (data: any, sessionId?: string) => {
    const user = data?.user;
    const connected = !!(data?.connected || user?.email);
    if (!connected) return false;
    const email = data.email || user?.email || null;
    const name = data.name || user?.name || null;
    const picture = data.picture || user?.picture || null;
    const tenantId = data.tenantId || user?.tenantId || null;
    setDriveEmail(email);
    setUserName(name);
    setUserPicture(picture);
    if (tenantId) setTenantIdInput(tenantId);
    if (sessionId || data.sessionId) {
      const sid = sessionId || data.sessionId;
      localStorage.setItem('solvamos_drive_session', sid);
      setDriveSessionId(sid);
    }
    localStorage.setItem('solvamos_entered', '1');
    return true;
  };

  const loadDriveFolders = async (_sessionId?: string, parentId = 'root') => {
    setDriveError(null);
    setDriveBusy(true);
    try {
      const q = new URLSearchParams();
      q.set('parent', parentId);
      const foldersRes = await authFetch(`/api/drive/folders?${q.toString()}`);
      const foldersData = await foldersRes.json();
      if (foldersData.status === 'success') {
        const items: DriveItem[] = (foldersData.items || foldersData.data || []).map((f: any) => ({
          ...f,
          kind:
            f.kind ||
            (f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'),
        }));
        setDriveItems(items);
        setDriveParentId(parentId);
        if (!items.length) {
          setDriveError(null);
        }
      } else {
        setDriveError(
          `${foldersData.message || 'Drive 폴더를 불러오지 못했습니다.'}${
            foldersData.hint ? `\n${foldersData.hint}` : ''
          }`
        );
      }
    } catch (err) {
      console.error('Drive folders failed', err);
      setDriveError('Drive 폴더 요청 실패');
    } finally {
      setDriveBusy(false);
    }
  };

  const navigateDriveFolder = async (folderId: string, folderName: string) => {
    setDrivePath((prev) => [...prev, { id: folderId, name: folderName }]);
    await loadDriveFolders(undefined, folderId);
  };

  const navigateDriveCrumb = async (index: number) => {
    if (index < 0) {
      setDrivePath([]);
      await loadDriveFolders(undefined, 'root');
      return;
    }
    const next = drivePath.slice(0, index + 1);
    setDrivePath(next);
    await loadDriveFolders(undefined, next[next.length - 1].id);
  };

  const selectDriveItem = (item: DriveItem) => {
    const kind =
      item.kind ||
      (item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file');
    if (selectedFolderId === item.id) {
      setSelectedFolderId('');
      setSelectedDriveName(null);
      setSelectedDriveKind(null);
      return;
    }
    setSelectedFolderId(item.id);
    setSelectedDriveName(item.name);
    setSelectedDriveKind(kind);
    setOptions((prev) => ({ ...prev, dataSourceType: 'google_drive' }));
  };

  const fetchWallets = async () => {
    try {
      const res = await authFetch('/api/wallets');
      const data = await res.json();
      if (data.status === 'success') {
        setWallets(data.data || []);
        setPrimaryWallet(data.primary || null);
      }
    } catch (err) {
      console.error('wallets fetch failed', err);
    }
  };

  const addUserWallet = async (address: string, label: string, source?: string) => {
    setWalletBusy(true);
    setWalletError(null);
    try {
      const res = await authFetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, label, source, makePrimary: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'success') {
        if (res.status === 401) {
          throw new Error('Login required — Google 로그인 후 지갑을 등록하세요.');
        }
        throw new Error(data.message || `등록 실패 (HTTP ${res.status})`);
      }
      setWallets(data.data || []);
      setPrimaryWallet(data.primary || null);
    } catch (err: any) {
      setWalletError(err?.message || '지갑 등록 실패');
      throw err;
    } finally {
      setWalletBusy(false);
    }
  };

  const fetchSettlements = async () => {
    try {
      const res = await authFetch('/api/settlements');
      const data = await res.json();
      if (data.status === 'success') setSettlements(data.data || []);
    } catch (err) {
      console.error('settlements fetch failed', err);
    }
  };

  const setUserPrimaryWallet = async (id: string) => {
    setWalletBusy(true);
    setWalletError(null);
    try {
      const res = await authFetch(`/api/wallets/${id}/primary`, { method: 'POST' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '설정 실패');
      setWallets(data.data || []);
      setPrimaryWallet(data.primary || null);
    } catch (err: any) {
      setWalletError(err.message);
    } finally {
      setWalletBusy(false);
    }
  };

  const removeUserWallet = async (id: string) => {
    setWalletBusy(true);
    setWalletError(null);
    try {
      const res = await authFetch(`/api/wallets/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '삭제 실패');
      setWallets(data.data || []);
      setPrimaryWallet(data.primary || null);
    } catch (err: any) {
      setWalletError(err.message);
    } finally {
      setWalletBusy(false);
    }
  };

  const refreshAuthSession = async (_sessionId?: string) => {
    try {
      const data = await ensureAuth();
      if (data && applyAuthUser(data, data.sessionId || undefined)) {
        setView('studio');
        await loadDriveFolders(undefined);
        await fetchWallets();
        await fetchSettlements();
        return true;
      }
      return false;
    } catch (err) {
      console.error('Auth session refresh failed', err);
      return false;
    }
  };

  /** Google OAuth: login | signup | link(Drive). */
  const startGoogleOAuth = async (intent: 'login' | 'signup' | 'link' = 'login') => {
    setDriveBusy(true);
    setAuthError(null);
    try {
      const res = await authFetch(`/api/auth/google?intent=${intent}`);
      const data = await res.json();
      if (data.status !== 'success') {
        setAuthError(
          `${data.message || 'Google 인증 실패'}${data.hint ? `\n\n${data.hint}` : ''}`
        );
        return;
      }

      if (data.sessionId) {
        localStorage.setItem('solvamos_drive_session', data.sessionId);
        setDriveSessionId(data.sessionId);
      }

      if (data.mode === 'adc' || !data.authUrl) {
        applyAuthUser({ ...data, connected: true, user: data.user || data }, data.sessionId);
        navigateTab('studio');
        if (intent !== 'link') await loadDriveFolders(undefined);
        return;
      }

      window.location.href = data.authUrl;
    } catch (err) {
      console.error(err);
      setAuthError('Google OAuth를 시작하지 못했습니다.');
    } finally {
      setDriveBusy(false);
    }
  };

  const connectGoogleDrive = async () => {
    // Already logged in → link Drive; else login with Google
    const me = await ensureAuth();
    if (me?.user || me?.connected) {
      await startGoogleOAuth('link');
    } else {
      await startGoogleOAuth('login');
    }
  };

  const handleEmailAuth = async (payload: {
    mode: 'signin' | 'signup';
    email: string;
    password: string;
    name?: string;
    orgName?: string;
  }) => {
    setLandingBusy(true);
    setAuthError(null);
    try {
      const path = payload.mode === 'signup' ? '/api/auth/register' : '/api/auth/login';
      const res = await authFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: payload.email,
          password: payload.password,
          name: payload.name,
          orgName: payload.orgName,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        setAuthError(data.message || '인증에 실패했습니다');
        return;
      }
      applyAuthUser({ connected: true, ...data }, data.sessionId);
      navigateTab('studio');
      await fetchWallets();
      await fetchStatusAndAgents();
    } catch (err: any) {
      setAuthError(err.message || '요청 실패');
    } finally {
      setLandingBusy(false);
    }
  };

  const enterDevSkip = () => {
    localStorage.setItem('solvamos_entered', '1');
    navigateTab('studio');
  };

  const refreshDriveFolders = async () => {
    setDriveBusy(true);
    try {
      const data = await ensureAuth();
      if (!data || !applyAuthUser(data, data.sessionId || undefined)) {
        setDriveError('세션이 만료되었습니다. 다시 로그인하세요.');
        return;
      }
      await loadDriveFolders(undefined, driveParentId || 'root');
    } finally {
      setDriveBusy(false);
    }
  };

  const logout = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    localStorage.removeItem('solvamos_entered');
    localStorage.removeItem('solvamos_drive_session');
    setView('landing');
    writeLandingRoute({ replace: true });
    setDriveSessionId('');
    setDriveEmail(null);
    setUserName(null);
    setUserPicture(null);
    setDriveItems([]);
    setDrivePath([]);
    setDriveParentId('root');
    setSelectedFolderId('');
    setSelectedDriveName(null);
    setSelectedDriveKind(null);
    setDriveError(null);
    setAuthError(null);
  };

  useEffect(() => {
    const boot = async () => {
      if (window.location.pathname === '/catalog' || window.location.pathname.startsWith('/catalog/')) {
        window.location.replace(
          serverStatus?.catalogMarketplaceUrl ||
            serverStatus?.catalogPageUrl ||
            CATALOG_MARKETPLACE
        );
        return;
      }
      const entered = localStorage.getItem('solvamos_entered') === '1';
      const initialRoute = parseAppRoute();
      // Keep studio visible across refresh while we revalidate (no login flash)
      if (entered) {
        setView('studio');
      }

      await fetchStatusAndAgents();
      // After status load, redirect /catalog if still on that path
      if (window.location.pathname === '/catalog' || window.location.pathname.startsWith('/catalog/')) {
        try {
          const st = await fetch('/api/status').then((r) => r.json());
          window.location.replace(st.catalogMarketplaceUrl || st.catalogPageUrl || CATALOG_MARKETPLACE);
        } catch {
          window.location.replace(CATALOG_MARKETPLACE);
        }
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const loggedIn =
        params.get('logged_in') === '1' ||
        params.get('drive_connected') === '1' ||
        params.get('google_linked') === '1';
      const emailFromUrl = params.get('email');
      const authErr = params.get('auth_error');

      if (authErr) {
        setAuthError(authErr);
        writeLandingRoute({ replace: true });
        setView('landing');
        return;
      }

      if (loggedIn) {
        if (emailFromUrl) setDriveEmail(emailFromUrl);
        const linked = params.get('google_linked') === '1';
        localStorage.setItem('solvamos_entered', '1');
        writeLandingRoute({ replace: true });
        const ok = await refreshAuthSession();
        if (ok) {
          navigateTab(linked ? 'account' : 'studio');
          return;
        }
      }

      const ok = await refreshAuthSession();
      if (ok) {
        if (initialRoute.tab) {
          setActiveTab(initialRoute.tab);
          setView('studio');
        } else {
          writeLandingRoute({ replace: true });
          navigateTab('studio');
        }
        return;
      }

      // Only kick to landing if session truly dead
      localStorage.removeItem('solvamos_entered');
      setView('landing');
      writeLandingRoute({ replace: true });
    };
    void boot();
  }, []);

  useEffect(() => {
    const applyAgentFromRoute = (route: ReturnType<typeof parseAppRoute>, isPop: boolean) => {
      if (route.tab === 'studio' && route.agentId) {
        const agent = agents.find((candidate) => candidate.id === route.agentId);
        if (agent) {
          setActiveAgent(agent);
          setEditingAgentId(agent.id);
          setStudioView('builder');
          setDetailAgentId(null);
          if (hydratedEditIdRef.current !== agent.id) {
            hydrateEditForm(agent);
            hydratedEditIdRef.current = agent.id;
          }
        }
        return;
      }
      if (route.tab === 'list' && route.agentId) {
        const agent = agents.find((candidate) => candidate.id === route.agentId);
        if (agent) {
          setActiveAgent(agent);
          setDetailAgentId(agent.id);
          setEditingAgentId(null);
        }
        return;
      }
      if (!isPop) return;
      if (route.tab === 'studio') {
        setStudioView('landing');
        setEditingAgentId(null);
        setDetailAgentId(null);
      } else if (route.tab === 'list') {
        setDetailAgentId(null);
      }
    };

    applyAgentFromRoute(parseAppRoute(), false);

    const onPopState = () => {
      if (window.location.pathname === '/catalog' || window.location.pathname.startsWith('/catalog/')) {
        window.location.replace(
          serverStatus?.catalogMarketplaceUrl ||
            serverStatus?.catalogPageUrl ||
            CATALOG_MARKETPLACE
        );
        return;
      }
      const route = parseAppRoute();
      if (!route.tab) {
        setView('landing');
        return;
      }
      setView('studio');
      setActiveTab(route.tab);
      applyAgentFromRoute(route, true);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [agents, serverStatus?.catalogMarketplaceUrl, serverStatus?.catalogPageUrl]);

  useEffect(() => {
    const { role, tone, securityLevel, customRole, customInstructions } = options;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/agents/preview-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role,
            tone,
            securityLevel,
            customRole,
            customInstructions,
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!controller.signal.aborted) setLivePromptPreview(data.systemPrompt || '');
      } catch (err: any) {
        if (err?.name !== 'AbortError') console.error(err);
      }
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    options.role,
    options.tone,
    options.securityLevel,
    options.customRole,
    options.customInstructions,
  ]);

  useEffect(() => {
    const panel = chatScrollRef.current;
    if (!panel) return;
    // Keep document viewport stable — only scroll the chat panel.
    const windowY = window.scrollY;
    const windowX = window.scrollX;
    panel.scrollTop = panel.scrollHeight;
    window.scrollTo(windowX, windowY);
    requestAnimationFrame(() => {
      window.scrollTo(windowX, windowY);
    });
  }, [chatHistory, activeAgent, pendingPayment]);

  const beginEditAgent = (agent: Agent) => {
    setActiveAgent(agent);
    setEditingAgentId(agent.id);
    setDetailAgentId(null);
    setStudioView('builder');
    hydrateEditForm(agent);
    hydratedEditIdRef.current = agent.id;
    navigateTab('studio', { agentId: agent.id });
  };

  const openAgentDetail = (agent: Agent, tab: DetailTab = 'overview') => {
    setActiveAgent(agent);
    setDetailAgentId(agent.id);
    setDetailTab(tab);
    setEditingAgentId(null);
    setStudioView('landing');
    navigateTab('list', { agentId: agent.id, detailTab: tab });
  };

  const startNewAgent = () => {
    setEditingAgentId(null);
    hydratedEditIdRef.current = null;
    setEditBaselineFolderId('');
    setActiveAgent(null);
    setDetailAgentId(null);
    setCreationResult(null);
    setBuilderStep(1);
    setStudioView('builder');
    setOptions({
      role: 'custom',
      customRole: '사내 HR/복지 안내',
      tone: 'casual',
      securityLevel: 'strict',
      fee: 0,
      runtimeMode: 'specialized',
      description: '',
      customInstructions: '',
      a2aPeersEnabled: true,
      aiAppType: 'search_docs',
      dataSourceType: 'local_upload',
      websiteUri: undefined,
      gcsUri: undefined,
    });
    setAgentName('');
    setSelectedFolderId('');
    setSelectedDriveName(null);
    setLocalFiles([]);
    navigateTab('studio', { openBuilder: true });
  };

  const handleCreateAgent = async () => {
    // 편집 모드(연필 또는 생성 직후 유지된 editingAgentId)만 PATCH. 그 외는 신규 생성.
    const targetId = editingAgentId;
    const isEdit = !!targetId;
    setSavingAsEdit(isEdit);

    setIsLoading(true);
    setBuilderStep(2);
    setCreateStepIndex(0);
    setCreatePercent(6);
    setCreateDetail(isEdit ? '에이전트 업데이트 중…' : '요청 준비 중…');

    const stepsLen = isEdit ? EDIT_STEPS.length : CREATE_STEPS.length;
    const tick = window.setInterval(() => {
      setCreateStepIndex((i) => Math.min(i + 1, stepsLen - 1));
      setCreatePercent((p) => Math.min(p + (isEdit ? 28 : 14), 88));
    }, isEdit ? 500 : 1600);

    try {
      const folderChanged =
        isEdit && (selectedFolderId || '') !== (editBaselineFolderId || '');

      const roleText = String(options.customRole || '').trim();
      const toneText = String(options.tone || '').trim();
      const descriptionText = String(options.description || '').trim();
      const rolePreset = options.role || 'custom';
      if (!agentName.trim()) {
        window.clearInterval(tick);
        setIsLoading(false);
        setCreateDetail('에이전트 이름을 입력하세요.');
        return;
      }
      if (rolePreset === 'custom' && !roleText) {
        window.clearInterval(tick);
        setIsLoading(false);
        setCreateDetail('에이전트 주요 역할을 입력하거나 템플릿을 선택하세요.');
        return;
      }
      if (!toneText) {
        window.clearInterval(tick);
        setIsLoading(false);
        setCreateDetail('답변 톤앤매너 템플릿을 고르거나 직접 입력하세요.');
        return;
      }
      if (!descriptionText) {
        window.clearInterval(tick);
        setIsLoading(false);
        setCreateDetail('카탈로그용 description을 입력하세요.');
        return;
      }

      const payload: Record<string, unknown> = {
        ...options,
        role: rolePreset,
        customRole: roleText || undefined,
        tone: toneText,
        description: descriptionText,
        tenantId: tenantIdInput || undefined,
        agentName: agentName.trim(),
      };

      // 생성: 폴더 선택 시 포함. 편집: 폴더를 바꿨을 때만 포함(재수집 방지)
      if (!isEdit) {
        if (selectedFolderId) payload.googleDriveFolderId = selectedFolderId;
        if (localFiles.length) payload.localFiles = localFiles;
      } else if (folderChanged) {
        payload.googleDriveFolderId = selectedFolderId || '';
      } else if (localFiles.length) {
        payload.localFiles = localFiles;
      }

      setCreateDetail(
        isEdit
          ? folderChanged
            ? '메타 저장 · Drive 소스 변경 재수집'
            : localFiles.length
              ? `로컬 파일 ${localFiles.length}건 추가 · 메타 저장`
              : '메타·요금 저장 (vault/ID 유지)'
          : localFiles.length
            ? `로컬 파일 ${localFiles.length}건 · ${
                options.runtimeMode === 'autonomous' ? 'Gemini+DataStore' : 'AI Applications'
              } · 카탈로그…`
            : selectedFolderId
              ? `Drive ${selectedDriveName || selectedFolderId} · ${
                  options.runtimeMode === 'autonomous' ? 'Gemini+DataStore' : 'AI Applications'
                } · 카탈로그…`
              : options.runtimeMode === 'autonomous'
                ? `자율모드 (Gemini + Data Store / ${
                    options.dataSourceType || 'local_upload'
                  }) · 카탈로그…`
                : `특화모드 AI Applications (${options.aiAppType || 'search_docs'} / ${
                    options.dataSourceType || 'local_upload'
                  }) · 카탈로그…`
      );

      const res = await fetch(isEdit ? `/api/agents/${targetId}` : '/api/agents/create', {
        method: isEdit ? 'PATCH' : 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(driveSessionId ? { 'X-SolVamos-Session': driveSessionId } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      window.clearInterval(tick);
      setCreateStepIndex(stepsLen - 1);
      setCreatePercent(100);

      if (data.status === 'success') {
        const ingestNote =
          data.driveIngest?.docs != null
            ? `Drive 문서 ${data.driveIngest.docs}건 주입`
            : null;
        const engineNote = data.vertexEngineId
          ? `AI App ${data.vertexEngineId}`
          : data.agent?.vertexEngineId
            ? `AI App ${data.agent.vertexEngineId}`
            : null;
        setCreateDetail(
          [
            engineNote,
            ingestNote,
            data.payShCatalog?.catalogId &&
              (isEdit
                ? `catalog sync ${data.payShCatalog.catalogId}`
                : `catalog ${data.payShCatalog.catalogId}`),
          ]
            .filter(Boolean)
            .join(' · ') || data.message
        );
        setCreationResult({ ...data, _wasEdit: isEdit });
        const saved = data.agent as Agent;
        setAgents((prev) => {
          const without = prev.filter((a) => a.id !== saved.id);
          return [saved, ...without];
        });
        setActiveAgent(saved);
        setEditBaselineFolderId(saved.googleDriveFolderId || '');
        setLocalFiles([]);
        setBuilderStep(3);
        if (isEdit) {
          // 편집 저장 후에도 편집 모드 유지 → 다시 누르면 PATCH
          setEditingAgentId(saved.id);
          setStudioView('builder');
          navigateTab('studio', { replace: true, agentId: saved.id });
        } else {
          // 신규 생성 → 상세 페이지로 이동 (테스트 대화 탭 포함)
          setEditingAgentId(null);
          setStudioView('landing');
          setDetailAgentId(saved.id);
          setDetailTab('overview');
          navigateTab('list', { replace: true, agentId: saved.id });
        }
        await new Promise((r) => setTimeout(r, 450));
      } else {
        alert(`Error ${isEdit ? 'updating' : 'creating'} agent: ${data.message}`);
        setBuilderStep(1);
      }
    } catch (err) {
      window.clearInterval(tick);
      console.error(err);
      alert(isEdit ? 'Network failure updating agent' : 'Network failure compiling agent');
      setBuilderStep(1);
    } finally {
      setIsLoading(false);
      setSavingAsEdit(false);
      setCreatePercent(0);
      setCreateStepIndex(0);
      setCreateDetail(null);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputText.trim() && chatAttachments.length === 0) || !activeAgent) {
      return;
    }

    const userMessage: Message = {
      id: Math.random().toString(36).substr(2, 9),
      sender: 'user',
      text: inputText.trim() || '(첨부만 전송)',
      timestamp: new Date().toLocaleTimeString(),
      attachments: chatAttachments.length
        ? chatAttachments.map(({ name, mimeType, previewUrl }) => ({
            name,
            mimeType,
            dataBase64: '',
            previewUrl,
          }))
        : undefined,
    };

    const currentAgentId = activeAgent.id;
    const history = chatHistory[currentAgentId] || [];
    const pendingAtt = [...chatAttachments];
    const webSearch = enableWebSearch;
    setChatHistory({
      ...chatHistory,
      [currentAgentId]: [...history, userMessage],
    });
    setInputText('');
    setChatAttachments([]);
    await invokeAgent(currentAgentId, userMessage.text, null, {
      attachments: pendingAtt,
      webSearch,
    });
  };

  const invokeAgent = async (
    agentId: string,
    promptText: string,
    _signature: string | null,
    extras?: {
      attachments?: import('./types').ChatAttachment[];
      webSearch?: boolean;
    }
  ) => {
    const auth = await ensureAuth();
    if (!auth) {
      setChatHistory((prev) => ({
        ...prev,
        [agentId]: [
          ...(prev[agentId] || []).filter((m) => m.id !== 'loading-placeholder'),
          {
            id: `auth-${Date.now()}`,
            sender: 'system',
            text: '로그인 세션이 만료되었습니다. 다시 로그인한 뒤 메시지를 보내주세요.',
            timestamp: new Date().toLocaleTimeString(),
            paymentStatus: 'none',
          },
        ],
      }));
      setAuthError('로그인 세션이 만료되었습니다.');
      return;
    }

    if (_signature) {
      setChatHistory((prev) => ({
        ...prev,
        [agentId]: [
          ...(prev[agentId] || []).filter((m) => m.id !== 'loading-placeholder'),
          {
            id: `pay-${Date.now()}`,
            sender: 'system',
            text: '유료 호출은 Catalog invoke_url(pay-gateway)로만 결제됩니다. Studio 소유자 테스트는 결제 없이 진행됩니다.',
            timestamp: new Date().toLocaleTimeString(),
            paymentStatus: 'none',
          },
        ],
      }));
      setPendingPayment(null);
      setIsVerifyingPayment(false);
      return;
    }

    const agentRow = agents.find((a) => a.id === agentId) || activeAgent;
    const a2aPeersEnabled = agentRow?.a2aPeersEnabled !== false;

    setChatHistory((prev) => ({
      ...prev,
      [agentId]: [
        ...(prev[agentId] || []),
        {
          id: 'loading-placeholder',
          sender: 'system',
          text: a2aPeersEnabled
            ? '⏳ A2A + Vertex 응답 생성 중… (필요 시 카탈로그 피어 호출)'
            : extras?.webSearch
              ? '⏳ 웹 검색 + Engine/Vertex 응답 생성 중…'
              : extras?.attachments?.length
                ? '⏳ 첨부 파일 분석 + Engine/Vertex 응답 생성 중…'
                : '⏳ AI Applications Engine 응답 생성 중…',
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'none',
        },
      ],
    }));

    try {
      const res = await fetch(`/api/agents/${agentId}/invoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-SolVamos-Studio': '1',
        },
        body: JSON.stringify({
          prompt: promptText,
          studioTest: true,
          // Omit override → server uses agent.a2aPeersEnabled; send explicit for clarity
          enableA2A: a2aPeersEnabled,
          webSearch: extras?.webSearch === true,
          answerSession: answerSessions[agentId] || undefined,
          attachments: (extras?.attachments || []).map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            dataBase64: a.dataBase64,
          })),
          history: (chatHistory[agentId] || [])
            .filter((m) => m.sender === 'user' || m.sender === 'agent')
            .filter((m) => m.id !== 'loading-placeholder')
            .slice(-12)
            .map((m) => ({
              role: m.sender === 'agent' ? 'model' : 'user',
              text: m.text,
            })),
        }),
      });
      const data = await res.json();

      const withoutLoading = (msgs: Message[]) =>
        msgs.filter((m) => m.id !== 'loading-placeholder');

      if (res.status === 401 || res.status === 403) {
        const authMessage: Message = {
          id: `auth-${Date.now()}`,
          sender: 'system',
          text:
            res.status === 401
              ? '로그인 세션이 만료되었습니다. 다시 로그인해주세요.'
              : data.message || '이 에이전트를 테스트할 권한이 없습니다.',
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'none',
        };
        setChatHistory((prev) => ({
          ...prev,
          [agentId]: [...withoutLoading(prev[agentId] || []), authMessage],
        }));
      } else if (res.status === 402) {
        setPendingPayment({
          agentId,
          amount: data.amount,
          token: data.token || 'USDC',
          recipientWallet: data.recipientWallet,
          prompt: promptText,
          network: data.network,
          paymentNetwork: data.paymentNetwork,
          invokeUrl: data.invokeUrl || data.gatewayUrl,
          gatewayUrl: data.payGatewayUrl || data.gatewayUrl,
          message: data.message,
        });

        const paywallMessage: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'system',
          text: `🔒 유료 에이전트 — pay-gateway 경로만 지원\n\ninvokeUrl:\n${data.invokeUrl || data.gatewayUrl || '(gateway URL 없음)'}\n\n${data.message || 'pay CLI / 지갑으로 USDC 결제 후 gateway가 Studio로 proxy합니다.'}`,
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'pending_proof',
        };

        setChatHistory((prev) => ({
          ...prev,
          [agentId]: [...withoutLoading(prev[agentId] || []), paywallMessage],
        }));
      } else if (data.status === 'success') {
        if (typeof data.session === 'string' && data.session) {
          setAnswerSessions((prev) => ({ ...prev, [agentId]: data.session }));
        }
        const hops = (data.a2a?.peerHops || []).map((h: any) => ({
          toName: h.toName,
          toAgentId: h.toAgentId,
          feeUsdc: h.feeUsdc,
          paymentProof: h.paymentProof,
          ok: !h.error && h.paymentVerified !== false,
          error: h.error,
        }));
        const hopNote =
          hops.length > 0
            ? `\n\n---\n🔗 A2A pay.sh: ${hops.length} peer call(s)\n` +
              hops
                .map(
                  (h: any) =>
                    `• ${h.toName} · ${h.feeUsdc} USDC · ${h.ok ? 'paid ✓' : `fail: ${h.error}`}`
                )
                .join('\n')
            : '';
        const toolsNote =
          Array.isArray(data.toolsUsed) && data.toolsUsed.length
            ? `\n\n_tools: ${data.toolsUsed.join(', ')}_`
            : '';

        const agentResponse: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'agent',
          text: `${formatAgentChatMessage(String(data.data ?? data.answer ?? ''))}${hopNote}${toolsNote}`,
          timestamp: new Date().toLocaleTimeString(),
          confidence: data.confidence,
          paymentStatus: 'none',
          a2aHops: hops,
          relatedQuestions: Array.isArray(data.relatedQuestions)
            ? data.relatedQuestions
            : undefined,
          toolsUsed: data.toolsUsed,
        };

        setChatHistory((prev) => ({
          ...prev,
          [agentId]: [...withoutLoading(prev[agentId] || []), agentResponse],
        }));

        if (data.paymentLogs) setPaymentLogs(data.paymentLogs);
        setPendingPayment(null);
      } else {
        const errorMessage: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'system',
          text: `⚠️ Invocation Failed:\n\n${data.message || 'Unknown backend error'}`,
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'failed',
        };

        setChatHistory((prev) => ({
          ...prev,
          [agentId]: [...withoutLoading(prev[agentId] || []), errorMessage],
        }));
        if (data.logs) setPaymentLogs(data.logs);
      }
    } catch (err) {
      console.error(err);
      setChatHistory((prev) => ({
        ...prev,
        [agentId]: [
          ...(prev[agentId] || []).filter((m) => m.id !== 'loading-placeholder'),
          {
            id: Math.random().toString(36).substr(2, 9),
            sender: 'system',
            text: '⚠️ API Connection Error: Could not reach the agent endpoint.',
            timestamp: new Date().toLocaleTimeString(),
          },
        ],
      }));
    } finally {
      setIsVerifyingPayment(false);
    }
  };


  const handleAcknowledgeAndSign = async (_useRandomSig = true) => {
    if (!pendingPayment?.invokeUrl) {
      alert(
        '유료 호출은 Catalog의 pay-gateway invokeUrl로만 결제됩니다.\nStudio origin X-PAYMENT-PROOF는 더 이상 지원하지 않습니다.'
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(pendingPayment.invokeUrl);
      setPaymentLogs([
        '[Gateway-only] Copied invokeUrl to clipboard',
        pendingPayment.invokeUrl,
        pendingPayment.message || '',
        `Fee: ${pendingPayment.amount} ${pendingPayment.token}`,
      ]);
    } catch {
      setPaymentLogs([
        '[Gateway-only] Copy failed — select the invokeUrl from the chat message',
        pendingPayment.invokeUrl,
      ]);
    }
  };

  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const walletHint = primaryWallet?.address
    ? `${primaryWallet.label || 'Wallet'} · ${primaryWallet.address.slice(0, 4)}...${primaryWallet.address.slice(-4)}`
    : null;

  if (view === 'boot') {
    return (
      <div className="min-h-screen bg-[#0F172A] flex items-center justify-center text-on-surface-variant text-sm">
        세션 확인 중…
      </div>
    );
  }

  if (view === 'landing') {
    return (
      <Landing
        onEmailSubmit={handleEmailAuth}
        onGoogle={(intent) => startGoogleOAuth(intent)}
        onDevSkip={enterDevSkip}
        oauthConfigured={!!serverStatus?.oauthConfigured}
        busy={landingBusy || driveBusy}
        error={authError}
      />
    );
  }

  return (
    <>
    <CreateAgentProgress
      open={isLoading}
      activeIndex={createStepIndex}
      percent={createPercent}
      detail={createDetail}
      mode={savingAsEdit ? 'edit' : 'create'}
    />
    <AppShell
      activeTab={activeTab}
      onNavigate={navigateTab}
      userEmail={driveEmail}
      userName={userName}
      userPicture={userPicture}
      walletHint={walletHint}
      onWalletClick={() => {
        setWalletError(null);
        setWalletModalOpen(true);
        void fetchWallets();
      }}
      onLogout={logout}
      paymentNetwork={serverStatus?.paymentNetwork}
    >
      {activeTab === 'studio' && (
        <StudioPage
          studioView={studioView}
          agentCount={agents.length}
          options={options}
          setOptions={setOptions}
          agentName={agentName}
          setAgentName={setAgentName}
          isLoading={isLoading}
          builderStep={builderStep}
          creationResult={creationResult}
          editingAgentId={editingAgentId}
          onCreate={handleCreateAgent}
          onStartNewAgent={startNewAgent}
          onOpenAgentsList={() => navigateTab('list')}
          onBackToLanding={() => navigateTab('studio')}
          driveEmail={driveEmail}
          primaryWalletAddress={primaryWallet?.address || null}
          primaryWalletLabel={primaryWallet?.label || null}
          driveItems={driveItems}
          drivePath={drivePath}
          selectedFolderId={selectedFolderId}
          selectedDriveName={selectedDriveName}
          selectedDriveKind={selectedDriveKind}
          setSelectedFolderId={setSelectedFolderId}
          driveBusy={driveBusy}
          driveError={driveError}
          onConnectDrive={connectGoogleDrive}
          onRefreshDrive={refreshDriveFolders}
          onNavigateDrive={navigateDriveFolder}
          onNavigateDriveCrumb={navigateDriveCrumb}
          onSelectDriveItem={selectDriveItem}
          localFiles={localFiles}
          onLocalFilesChange={setLocalFiles}
          tenantIdInput={tenantIdInput}
          setTenantIdInput={setTenantIdInput}
          activeAgent={activeAgent}
          copiedId={copiedId}
          onCopy={handleCopyText}
          serverStatus={serverStatus}
        />
      )}
      {activeTab === 'list' && detailAgentId && activeAgent?.id === detailAgentId ? (
        <AgentDetailPage
          agent={activeAgent}
          initialTab={detailTab}
          marketplaceUrl={
            serverStatus?.catalogMarketplaceUrl ||
            serverStatus?.catalogPageUrl ||
            CATALOG_MARKETPLACE
          }
          onBack={() => navigateTab('list')}
          onEdit={beginEditAgent}
          chatHistory={chatHistory}
          inputText={inputText}
          setInputText={setInputText}
          onSendMessage={handleSendMessage}
          pendingPayment={pendingPayment}
          paymentLogs={paymentLogs}
          onAcknowledgeAndSign={handleAcknowledgeAndSign}
          chatScrollRef={chatScrollRef}
          onToggleA2APeers={async (enabled) => {
            if (!activeAgent) return;
            try {
              const res = await fetch(`/api/agents/${encodeURIComponent(activeAgent.id)}`, {
                method: 'PATCH',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  ...(driveSessionId ? { 'X-SolVamos-Session': driveSessionId } : {}),
                },
                body: JSON.stringify({ a2aPeersEnabled: enabled }),
              });
              const data = await res.json();
              if (data.status === 'success' && data.agent) {
                setAgents((prev) =>
                  prev.map((a) => (a.id === activeAgent.id ? { ...a, ...data.agent } : a))
                );
                setActiveAgent((prev) =>
                  prev && prev.id === activeAgent.id ? { ...prev, ...data.agent } : prev
                );
              }
            } catch {
              /* ignore */
            }
          }}
          chatAttachments={chatAttachments}
          onChatAttachmentsChange={setChatAttachments}
          enableWebSearch={enableWebSearch}
          setEnableWebSearch={setEnableWebSearch}
          paymentNetwork={serverStatus?.paymentNetwork}
          primaryWalletAddress={primaryWallet?.address || null}
          primaryWalletLabel={primaryWallet?.label || null}
          copiedId={copiedId}
          onCopy={handleCopyText}
        />
      ) : null}
      {activeTab === 'list' && !(detailAgentId && activeAgent?.id === detailAgentId) && (
        <AgentsPage
          agents={agents}
          marketplaceUrl={
            serverStatus?.catalogMarketplaceUrl ||
            serverStatus?.catalogPageUrl ||
            CATALOG_MARKETPLACE
          }
          onSelect={(agent) => openAgentDetail(agent, 'overview')}
          onEdit={beginEditAgent}
          deletingAgentId={deletingAgentId}
          onToggleStatus={async (agent) => {
            const next =
              agent.status === 'PAUSED' || agent.status === 'inactive' ? 'ACTIVE' : 'PAUSED';
            try {
              const res = await fetch(`/api/agents/${agent.id}`, {
                method: 'PATCH',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  ...(driveSessionId ? { 'X-SolVamos-Session': driveSessionId } : {}),
                },
                body: JSON.stringify({ status: next }),
              });
              const data = await res.json();
              if (data.status === 'success' && data.agent) {
                setAgents((prev) =>
                  prev.map((a) => (a.id === agent.id ? { ...a, ...data.agent } : a))
                );
                if (activeAgent?.id === agent.id) setActiveAgent(data.agent);
              } else {
                alert(data.message || '상태 변경 실패');
              }
            } catch (err) {
              console.error(err);
              alert('상태 변경 네트워크 오류');
            }
          }}
          onDelete={async (agent) => {
            const title = agent.agentName || agent.customRole || agent.role;
            const ok = window.confirm(
              `"${title}" 에이전트를 삭제할까요?\n\nAI Applications 앱·데이터스토어·카탈로그·vault까지 함께 제거됩니다.`
            );
            if (!ok) return;
            setDeletingAgentId(agent.id);
            try {
              const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: {
                  ...(driveSessionId ? { 'X-SolVamos-Session': driveSessionId } : {}),
                },
              });
              const data = await res.json();
              if (data.status === 'success') {
                setAgents((prev) => prev.filter((a) => a.id !== agent.id));
                if (activeAgent?.id === agent.id) {
                  setActiveAgent(null);
                  setEditingAgentId(null);
                }
                if (detailAgentId === agent.id) {
                  setDetailAgentId(null);
                  navigateTab('list', { replace: true });
                }
                const gcpNote = (data.aiApp?.details || []).slice(0, 2).join(' · ');
                alert(
                  gcpNote
                    ? `삭제 완료\n${gcpNote}`
                    : '에이전트가 삭제되었습니다.'
                );
              } else {
                alert(data.message || '삭제 실패');
              }
            } catch (err) {
              console.error(err);
              alert('삭제 네트워크 오류');
            } finally {
              setDeletingAgentId(null);
            }
          }}
        />
      )}
      {activeTab === 'lab' && (
        <DevAgentLabPage
          agents={agents}
          authFetch={authFetch}
          onBack={() => navigateTab('studio')}
        />
      )}
      {activeTab === 'evidence' && (
        <DevEvidencePage agents={agents} authFetch={authFetch} />
      )}
      {activeTab === 'logs' && <DevLogsPage authFetch={authFetch} />}
      {activeTab === 'settlements' && (
        <SettlementsPage settlements={settlements} agents={agents} />
      )}
      {activeTab === 'account' && (
        <MyPage
          authFetch={authFetch}
          onLinked={() => {
            void refreshAuthSession();
          }}
        />
      )}
    </AppShell>
    <WalletModal
      open={walletModalOpen}
      onClose={() => setWalletModalOpen(false)}
      wallets={wallets}
      busy={walletBusy}
      error={walletError}
      onAdd={addUserWallet}
      onSetPrimary={setUserPrimaryWallet}
      onRemove={removeUserWallet}
    />
    </>
  );
}
