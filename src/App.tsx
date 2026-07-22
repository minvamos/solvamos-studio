/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Agent, DriveItem, DrivePathCrumb, Message, PromptOptions, Settlement } from './types';
import Landing from './Landing';
import AppShell, { AppTab } from './AppShell';
import StudioPage from './pages/StudioPage';
import AgentsPage from './pages/AgentsPage';
import SettlementsPage from './pages/SettlementsPage';
import MyPage from './pages/MyPage';
import WalletModal, { type WalletRow } from './components/WalletModal';
import CreateAgentProgress, { CREATE_STEPS, EDIT_STEPS } from './components/CreateAgentProgress';
import { formatAgentChatMessage } from './lib/formatAgentMessage';

export default function App() {
  const [view, setView] = useState<'landing' | 'studio' | 'boot'>('boot');
  const [landingBusy, setLandingBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('studio');
  const [networkSwitchBusy, setNetworkSwitchBusy] = useState(false);
  const [catalogSwitchBusy, setCatalogSwitchBusy] = useState(false);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [serverStatus, setServerStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [createStepIndex, setCreateStepIndex] = useState(0);
  const [createPercent, setCreatePercent] = useState(0);
  const [createDetail, setCreateDetail] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [settlements, setSettlements] = useState<Settlement[]>([
    {
      id: '5kXfD91vU8A2bN9oM9pU8vS7nN9tU8vS7nN9tU8vS7nN9',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.01,
      status: 'success',
      timestamp: '2026-07-21 04:22:06',
      blockHeight: 28491024,
    },
    {
      id: '3zPfS71vA2bN9oM9pU8vS7nN9tU8vS7nN9tU8vS7nN8',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.01,
      status: 'success',
      timestamp: '2026-07-21 03:15:42',
      blockHeight: 28490611,
    },
    {
      id: '8yQfV92wR3cN0oM8pU9vS8nO0tV8vT8nO0tV8vT8nO0t',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.01,
      status: 'failed',
      timestamp: '2026-07-21 02:08:12',
      blockHeight: 28489950,
    },
  ]);

  const [builderStep, setBuilderStep] = useState<1 | 2 | 3>(1);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  /** Drive folder id when edit started — only send folder on PATCH if user changed it */
  const [editBaselineFolderId, setEditBaselineFolderId] = useState<string>('');
  const [savingAsEdit, setSavingAsEdit] = useState(false);
  const [options, setOptions] = useState<PromptOptions>({
    role: 'support',
    tone: 'professional',
    securityLevel: 'strict',
    fee: 0,
  });
  const [agentName, setAgentName] = useState('사내 복지 안내 AI 비서');
  const [livePromptPreview, setLivePromptPreview] = useState('');
  const [creationResult, setCreationResult] = useState<any>(null);

  const [inputText, setInputText] = useState('');
  const [chatHistory, setChatHistory] = useState<Record<string, Message[]>>({});
  const [pendingPayment, setPendingPayment] = useState<{
    agentId: string;
    amount: number;
    token: string;
    recipientWallet: string;
    prompt: string;
    network?: string;
    paymentNetwork?: string;
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
  const [tenantIdInput, setTenantIdInput] = useState('demo');

  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [primaryWallet, setPrimaryWallet] = useState<WalletRow | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

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
        if (agentsData.data.length > 0 && !activeAgent) {
          setActiveAgent(agentsData.data[0]);
        }
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
      const data = await res.json();
      if (data.status !== 'success') throw new Error(data.message || '등록 실패');
      setWallets(data.data || []);
      setPrimaryWallet(data.primary || null);
    } finally {
      setWalletBusy(false);
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
        setView('studio');
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
      setView('studio');
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
    setView('studio');
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
      const entered = localStorage.getItem('solvamos_entered') === '1';
      // Keep studio visible across refresh while we revalidate (no login flash)
      if (entered) {
        setView('studio');
      }

      await fetchStatusAndAgents();
      const params = new URLSearchParams(window.location.search);
      const loggedIn =
        params.get('logged_in') === '1' ||
        params.get('drive_connected') === '1' ||
        params.get('google_linked') === '1';
      const emailFromUrl = params.get('email');
      const authErr = params.get('auth_error');

      if (authErr) {
        setAuthError(authErr);
        window.history.replaceState({}, '', '/');
        setView('landing');
        return;
      }

      if (loggedIn) {
        if (emailFromUrl) setDriveEmail(emailFromUrl);
        const linked = params.get('google_linked') === '1';
        localStorage.setItem('solvamos_entered', '1');
        window.history.replaceState({}, '', '/');
        const ok = await refreshAuthSession();
        if (ok) {
          if (linked) setActiveTab('account');
          return;
        }
      }

      const ok = await refreshAuthSession();
      if (ok) return;

      // Only kick to landing if session truly dead
      localStorage.removeItem('solvamos_entered');
      setView('landing');
    };
    void boot();
  }, []);

  useEffect(() => {
    const fetchPreview = async () => {
      try {
        const res = await fetch('/api/agents/preview-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        });
        const data = await res.json();
        setLivePromptPreview(data.systemPrompt);
      } catch (err) {
        console.error(err);
      }
    };
    fetchPreview();
  }, [options]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, activeAgent, pendingPayment]);

  const beginEditAgent = (agent: Agent) => {
    setActiveAgent(agent);
    setEditingAgentId(agent.id);
    setEditBaselineFolderId(agent.googleDriveFolderId || '');
    setCreationResult(null);
    setBuilderStep(1);
    setOptions({
      role: (agent.role as PromptOptions['role']) || 'support',
      customRole: agent.customRole,
      tone: (agent.tone as PromptOptions['tone']) || 'professional',
      securityLevel: (agent.securityLevel as PromptOptions['securityLevel']) || 'strict',
      fee: agent.fee ?? agent.perCallPriceUsdc ?? 0,
    });
    setAgentName(agent.agentName || agent.customRole || '');
    setSelectedFolderId(agent.googleDriveFolderId || '');
    setActiveTab('studio');
  };

  const startNewAgent = () => {
    setEditingAgentId(null);
    setEditBaselineFolderId('');
    setActiveAgent(null);
    setCreationResult(null);
    setBuilderStep(1);
    setOptions({
      role: 'support',
      tone: 'professional',
      securityLevel: 'strict',
      fee: 0,
    });
    setAgentName('사내 복지 안내 AI 비서');
    setSelectedFolderId('');
    setSelectedDriveName(null);
    setActiveTab('studio');
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

      const payload: Record<string, unknown> = {
        ...options,
        customRole:
          options.role === 'custom'
            ? agentName || options.customRole || '사내 HR/복지 안내'
            : options.customRole,
        tenantId: tenantIdInput || undefined,
        agentName,
      };

      // 생성: 폴더 선택 시 포함. 편집: 폴더를 바꿨을 때만 포함(재수집 방지)
      if (!isEdit) {
        if (selectedFolderId) payload.googleDriveFolderId = selectedFolderId;
      } else if (folderChanged) {
        payload.googleDriveFolderId = selectedFolderId || '';
      }

      setCreateDetail(
        isEdit
          ? folderChanged
            ? '메타 저장 · Drive 소스 변경 재수집'
            : '메타·요금 저장 (vault/ID 유지)'
          : selectedFolderId
            ? `Drive 소스 ${selectedDriveName || selectedFolderId} 수집 · Vertex · 카탈로그…`
            : 'Drive 미선택 — 메타·카탈로그만 생성'
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
        setCreateDetail(
          [
            ingestNote,
            data.payShCatalog?.catalogId &&
              (isEdit
                ? `catalog sync ${data.payShCatalog.catalogId}`
                : `pay.sh ${data.payShCatalog.catalogId}`),
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
        // 저장 후에도 편집 모드 유지 → 다시 누르면 PATCH (신규 게시 방지)
        setEditingAgentId(saved.id);
        setEditBaselineFolderId(saved.googleDriveFolderId || '');
        setBuilderStep(3);
        setActiveTab('studio');
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
    if (!inputText.trim() || !activeAgent) return;

    const userMessage: Message = {
      id: Math.random().toString(36).substr(2, 9),
      sender: 'user',
      text: inputText,
      timestamp: new Date().toLocaleTimeString(),
    };

    const currentAgentId = activeAgent.id;
    const history = chatHistory[currentAgentId] || [];
    setChatHistory({
      ...chatHistory,
      [currentAgentId]: [...history, userMessage],
    });
    setInputText('');
    await invokeAgent(currentAgentId, userMessage.text, null);
  };

  const invokeAgent = async (
    agentId: string,
    promptText: string,
    signature: string | null
  ) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (signature) {
      headers['X-PAYMENT-PROOF'] = signature;
      setIsVerifyingPayment(true);
    } else {
      setChatHistory((prev) => ({
        ...prev,
        [agentId]: [
          ...(prev[agentId] || []),
          {
            id: 'loading-placeholder',
            sender: 'system',
            text: '⏳ Vertex AI Gemini 응답 생성 중… (GCP ADC)',
            timestamp: new Date().toLocaleTimeString(),
            paymentStatus: 'none',
          },
        ],
      }));
    }

    try {
      const res = await fetch(`/api/agents/${agentId}/invoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...headers,
          'X-SolVamos-Studio': '1',
        },
        body: JSON.stringify({
          prompt: promptText,
          studioTest: true,
          enableA2A: false,
        }),
      });
      const data = await res.json();

      const withoutLoading = (msgs: Message[]) =>
        msgs.filter((m) => m.id !== 'loading-placeholder');

      if (res.status === 402) {
        setPendingPayment({
          agentId,
          amount: data.amount,
          token: data.token || 'USDC',
          recipientWallet: data.recipientWallet,
          prompt: promptText,
          network: data.network,
          paymentNetwork: data.paymentNetwork,
        });

        const paywallMessage: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'system',
          text: `🔒 SOLVAMOS pay.sh SECURE PAYWALL\n\nNetwork: ${data.network || data.paymentNetwork || '—'}\nFee: ${data.amount} ${data.token || 'USDC'}\nAgent vault: ${data.recipientWallet}`,
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'pending_proof',
        };

        setChatHistory((prev) => ({
          ...prev,
          [agentId]: [...withoutLoading(prev[agentId] || []), paywallMessage],
        }));
      } else if (data.status === 'success') {
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

        const agentResponse: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'agent',
          text: `${formatAgentChatMessage(String(data.data ?? data.answer ?? ''))}${hopNote}`,
          timestamp: new Date().toLocaleTimeString(),
          confidence: data.confidence,
          paymentStatus: signature ? 'verified' : 'none',
          paymentTx: signature || undefined,
          a2aHops: hops,
        };

        if (signature) {
          setSettlements((prev) => [
            {
              id: signature,
              agentId,
              recipientWallet: activeAgent?.publicKey || '',
              amount: pendingPayment?.amount ?? 0.01,
              status: 'success',
              timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
              blockHeight: 28491200 + Math.floor(Math.random() * 500),
            },
            ...prev,
          ]);
        }

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

        if (signature) {
          setSettlements((prev) => [
            {
              id: signature,
              agentId,
              recipientWallet: activeAgent?.publicKey || '',
              amount: pendingPayment?.amount ?? 0.01,
              status: 'failed',
              timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
              blockHeight: 28491200 + Math.floor(Math.random() * 500),
            },
            ...prev,
          ]);
        }

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

  const switchPaymentNetwork = async (network: 'sandbox' | 'devnet') => {
    setNetworkSwitchBusy(true);
    try {
      const res = await fetch('/api/payment/network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        alert(data.message || '결제 네트워크 전환 실패');
        return;
      }
      await fetchStatusAndAgents();
      setPendingPayment(null);
      setPaymentLogs([
        `[Payment mode] → ${data.paymentNetwork} (${data.networkLabel})`,
        `RPC: ${data.solanaRpcUrl}`,
        `USDC mint: ${data.usdcMint}`,
        data.sandboxProofsAllowed
          ? 'Sandbox proofs (PAYSH_LOCAL_ / PAYSH_A2A_) allowed'
          : 'Devnet/product: paste a real USDC transfer signature',
      ]);
    } catch (err) {
      console.error(err);
      alert('결제 네트워크 전환 중 오류');
    } finally {
      setNetworkSwitchBusy(false);
    }
  };

  const switchCatalogPublishMode = async (mode: 'internal' | 'main' | 'both') => {
    setCatalogSwitchBusy(true);
    try {
      const res = await fetch('/api/paysh/catalog/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        alert(data.message || '카탈로그 게시 모드 전환 실패');
        return;
      }
      await fetchStatusAndAgents();
      setPaymentLogs((prev) => [
        ...prev,
        `[Catalog publish] → ${data.publishMode}` +
          (data.remoteUrlConfigured
            ? ` (remote ${data.remoteUrl})`
            : data.publishMode !== 'internal'
              ? ' (lab main mirror)'
              : ''),
      ]);
    } catch (err) {
      console.error(err);
      alert('카탈로그 모드 전환 중 오류');
    } finally {
      setCatalogSwitchBusy(false);
    }
  };

  const handleAcknowledgeAndSign = async (useRandomSig = true) => {
    if (!pendingPayment) return;
    const net =
      pendingPayment.paymentNetwork || serverStatus?.paymentNetwork || 'devnet';

    let signature: string;
    if (useRandomSig) {
      if (net !== 'sandbox' && !serverStatus?.allowPaymentBypass && !serverStatus?.sandboxProofsAllowed) {
        alert(
          'Devnet(제품) 모드에서는 샌드박스/Mock 증명을 쓸 수 없습니다.\n에이전트 vault로 USDC를 보낸 뒤 트랜잭션 서명을 붙여넣으세요.\n또는 사이드바에서 Sandbox로 전환하세요.'
        );
        return;
      }
      const prefix =
        net === 'sandbox' ? 'PAYSH_LOCAL_' : net === 'localnet' ? 'SANDBOX_TX_' : 'MOCK_TX_';
      signature = `${prefix}${Math.random().toString(36).substr(2, 10).toUpperCase()}_${Date.now().toString().slice(-4)}`;
    } else {
      signature = customSignature.trim();
    }

    if (!signature) {
      alert(
        net === 'devnet'
          ? 'Devnet USDC 트랜잭션 서명을 입력하세요.'
          : 'Solana / pay.sh 트랜잭션 서명을 입력하세요.'
      );
      return;
    }

    setPaymentLogs([
      `[Network] ${net}`,
      `[Proof] ${useRandomSig ? 'Generated sandbox-style proof' : 'Pasted on-chain signature'}`,
      `Signature: ${signature}`,
      `Fee: ${pendingPayment.amount} ${pendingPayment.token}`,
      `Recipient: ${pendingPayment.recipientWallet}`,
    ]);

    await invokeAgent(pendingPayment.agentId, pendingPayment.prompt, signature);
    setCustomSignature('');
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
      onNavigate={setActiveTab}
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
      onPaymentNetworkChange={switchPaymentNetwork}
      paymentSwitchBusy={networkSwitchBusy}
      catalogPublishMode={serverStatus?.catalogPublishMode || 'internal'}
      onCatalogPublishModeChange={switchCatalogPublishMode}
      catalogSwitchBusy={catalogSwitchBusy}
      catalogRemoteConfigured={!!serverStatus?.catalogRemoteConfigured}
    >
      {activeTab === 'studio' && (
        <StudioPage
          options={options}
          setOptions={setOptions}
          agentName={agentName}
          setAgentName={setAgentName}
          livePromptPreview={livePromptPreview}
          isLoading={isLoading}
          builderStep={builderStep}
          creationResult={creationResult}
          editingAgentId={editingAgentId}
          onCreate={handleCreateAgent}
          onStartNewAgent={startNewAgent}
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
          tenantIdInput={tenantIdInput}
          setTenantIdInput={setTenantIdInput}
          activeAgent={activeAgent}
          chatHistory={chatHistory}
          inputText={inputText}
          setInputText={setInputText}
          onSendMessage={handleSendMessage}
          pendingPayment={pendingPayment}
          paymentLogs={paymentLogs}
          isVerifyingPayment={isVerifyingPayment}
          customSignature={customSignature}
          setCustomSignature={setCustomSignature}
          onAcknowledgeAndSign={handleAcknowledgeAndSign}
          bottomRef={bottomRef}
          copiedId={copiedId}
          onCopy={handleCopyText}
          serverStatus={serverStatus}
        />
      )}
      {activeTab === 'list' && (
        <AgentsPage
          agents={agents}
          onSelect={(agent) => {
            beginEditAgent(agent);
          }}
          onEdit={beginEditAgent}
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
        />
      )}
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
