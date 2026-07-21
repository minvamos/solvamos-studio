/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Cpu, 
  Sparkles, 
  Code, 
  ShieldCheck, 
  TrendingUp, 
  Wallet, 
  Coins, 
  Terminal, 
  CheckCircle2, 
  ArrowRight, 
  Lock, 
  RefreshCw, 
  AlertCircle, 
  Plus, 
  ChevronRight, 
  Layers, 
  Globe, 
  Info,
  Server,
  Zap,
  HelpCircle,
  Copy,
  Check
} from 'lucide-react';
import { Agent, Message, PromptOptions, Settlement } from './types';

export default function App() {
  // Global States
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [serverStatus, setServerStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Tab Navigation State (현재 대시보드 / 에이전트 목록 / 온체인 정산 내역)
  const [activeTab, setActiveTab] = useState<'create' | 'list' | 'settlements'>('create');

  // Settlements / On-chain Billing logs
  const [settlements, setSettlements] = useState<Settlement[]>([
    {
      id: '5kXfD91vU8A2bN9oM9pU8vS7nN9tU8vS7nN9tU8vS7nN9',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.001,
      status: 'success',
      timestamp: '2026-07-21 04:22:06',
      blockHeight: 28491024
    },
    {
      id: '3zPfS71vA2bN9oM9pU8vS7nN9tU8vS7nN9tU8vS7nN8',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.001,
      status: 'success',
      timestamp: '2026-07-21 03:15:42',
      blockHeight: 28490611
    },
    {
      id: '8yQfV92wR3cN0oM8pU9vS8nO0tV8vT8nO0tV8vT8nO0t',
      agentId: 'support-copilot-001',
      recipientWallet: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      amount: 0.001,
      status: 'failed',
      timestamp: '2026-07-21 02:08:12',
      blockHeight: 28489950
    }
  ]);

  // Creator Panel States
  const [builderStep, setBuilderStep] = useState<1 | 2 | 3>(1);
  const [options, setOptions] = useState<PromptOptions>({
    role: 'support',
    tone: 'professional',
    securityLevel: 'strict',
    fee: 0.001,
  });
  const [livePromptPreview, setLivePromptPreview] = useState('');
  const [creationResult, setCreationResult] = useState<any>(null);

  // Sandbox Sandbox / Chat States
  const [inputText, setInputText] = useState('');
  const [chatHistory, setChatHistory] = useState<Record<string, Message[]>>({});
  const [pendingPayment, setPendingPayment] = useState<{
    agentId: string;
    amount: number;
    token: string;
    recipientWallet: string;
    prompt: string;
  } | null>(null);
  const [paymentLogs, setPaymentLogs] = useState<string[]>([]);
  const [isVerifyingPayment, setIsVerifyingPayment] = useState(false);
  const [customSignature, setCustomSignature] = useState('');
  const [activeChatTab, setActiveChatTab] = useState<'chat' | 'logs'>('chat');

  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch server status & agents lists
  const fetchStatusAndAgents = async () => {
    try {
      const statusRes = await fetch('/api/status');
      const statusData = await statusRes.json();
      setServerStatus(statusData);

      const agentsRes = await fetch('/api/agents');
      const agentsData = await agentsRes.json();
      if (agentsData.status === 'success') {
        setAgents(agentsData.data);
        if (agentsData.data.length > 0 && !activeAgent) {
          setActiveAgent(agentsData.data[0]);
        }
      }
    } catch (err) {
      console.error('Failed to connect to backend api:', err);
    }
  };

  useEffect(() => {
    fetchStatusAndAgents();
  }, []);

  // Sync Prompt Preview on changing creator option states
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

  // Scroll to bottom of chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, activeAgent, pendingPayment]);

  // Handle Agent Creation
  const handleCreateAgent = async () => {
    setIsLoading(true);
    setBuilderStep(2); // Move to "Compiling Wallet" visual phase
    try {
      // Small artificial delay to show off beautiful compiling step-by-step state
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
      const data = await res.json();

      if (data.status === 'success') {
        setCreationResult(data);
        setAgents((prev) => [data.agent, ...prev]);
        setActiveAgent(data.agent);
        setBuilderStep(3); // Success/Review Step
      } else {
        alert(`Error creating agent: ${data.message}`);
        setBuilderStep(1);
      }
    } catch (err) {
      console.error(err);
      alert('Network failure compiling agent');
      setBuilderStep(1);
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger User Chat message send
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

    // Trigger API call (1st attempt, expect 402 Paywall)
    await invokeAgent(currentAgentId, userMessage.text, null);
  };

  // Main invocation flow (handles 402 intercept)
  const invokeAgent = async (agentId: string, promptText: string, signature: string | null) => {
    const history = chatHistory[agentId] || [];
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    
    if (signature) {
      headers['X-PAYMENT-PROOF'] = signature;
      setIsVerifyingPayment(true);
      setActiveChatTab('logs');
    } else {
      // Add a loading placeholder message for the system/agent
      setChatHistory(prev => ({
        ...prev,
        [agentId]: [
          ...(prev[agentId] || []),
          {
            id: 'loading-placeholder',
            sender: 'system',
            text: '⚡ Initiating secure agent-to-agent channel (pay.sh protocol handshake)...',
            timestamp: new Date().toLocaleTimeString(),
            paymentStatus: 'none',
          }
        ]
      }));
    }

    try {
      const res = await fetch(`/api/agents/${agentId}/invoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: promptText }),
      });

      const data = await res.json();

      // Filter out any temporary loading placeholders
      setChatHistory(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || []).filter(m => m.id !== 'loading-placeholder')
      }));

      if (res.status === 402) {
        // pay.sh Intercept: Wallet Payment is Required!
        setPendingPayment({
          agentId,
          amount: data.amount,
          token: data.token,
          recipientWallet: data.recipientWallet,
          prompt: promptText,
        });
        
        const paywallMessage: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'system',
          text: `🔒 SOLVAMOS pay.sh SECURE PAYWALL BLOCK:\n\nThis agent requires on-chain Devnet payment verification to trigger its Vertex AI RAG compiled engine.\n\nFee required: ${data.amount} ${data.token}\nDestination Public Key: ${data.recipientWallet}`,
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'pending_proof',
        };

        setChatHistory(prev => ({
          ...prev,
          [agentId]: [...(prev[agentId] || []), paywallMessage]
        }));

      } else if (data.status === 'success') {
        // Successful Response
        const agentResponse: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'agent',
          text: data.data,
          timestamp: new Date().toLocaleTimeString(),
          confidence: data.confidence,
          paymentStatus: signature ? 'verified' : 'none',
          paymentTx: signature || undefined,
        };

        if (signature) {
          const newSettlement: Settlement = {
            id: signature,
            agentId: agentId,
            recipientWallet: activeAgent?.publicKey || '',
            amount: activeAgent?.fee !== undefined ? activeAgent.fee : 0.001,
            status: 'success',
            timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
            blockHeight: 28491200 + Math.floor(Math.random() * 500)
          };
          setSettlements(prev => [newSettlement, ...prev]);
        }

        setChatHistory(prev => ({
          ...prev,
          [agentId]: [...(prev[agentId] || []), agentResponse]
        }));
        
        if (data.paymentLogs) {
          setPaymentLogs(data.paymentLogs);
        }
        setPendingPayment(null);

      } else {
        // Handle normal errors (e.g., incomplete payment verification)
        const errorMessage: Message = {
          id: Math.random().toString(36).substr(2, 9),
          sender: 'system',
          text: `⚠️ Invocation Failed:\n\n${data.message || 'Unknown backend error'}`,
          timestamp: new Date().toLocaleTimeString(),
          paymentStatus: 'failed',
        };

        if (signature) {
          const failedSettlement: Settlement = {
            id: signature,
            agentId: agentId,
            recipientWallet: activeAgent?.publicKey || '',
            amount: activeAgent?.fee !== undefined ? activeAgent.fee : 0.001,
            status: 'failed',
            timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
            blockHeight: 28491200 + Math.floor(Math.random() * 500)
          };
          setSettlements(prev => [failedSettlement, ...prev]);
        }

        setChatHistory(prev => ({
          ...prev,
          [agentId]: [...(prev[agentId] || []), errorMessage]
        }));

        if (data.logs) {
          setPaymentLogs(data.logs);
        }
      }
    } catch (err: any) {
      console.error(err);
      // Remove loading placeholder
      setChatHistory(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || []).filter(m => m.id !== 'loading-placeholder')
      }));

      const errMessage: Message = {
        id: Math.random().toString(36).substr(2, 9),
        sender: 'system',
        text: `⚠️ API Connection Error: Could not reach the agent endpoint. Ensure the server is listening.`,
        timestamp: new Date().toLocaleTimeString(),
      };
      setChatHistory(prev => ({
        ...prev,
        [agentId]: [...(prev[agentId] || []), errMessage]
      }));
    } finally {
      setIsVerifyingPayment(false);
    }
  };

  // Simulate on-chain transaction signature creation and auto-retry
  const handleAcknowledgeAndSign = async (useRandomSig = true) => {
    if (!pendingPayment) return;
    
    // Create a mock transaction signature
    const signature = useRandomSig 
      ? `MOCK_TX_${Math.random().toString(36).substr(2, 10).toUpperCase()}_${Date.now().toString().slice(-4)}`
      : customSignature.trim();

    if (!signature) {
      alert('Please enter a valid Solana transaction signature hash.');
      return;
    }

    setPaymentLogs([
      `[Signature Generated] Local sandbox wallet signed transaction payload.`,
      `[Client Handshake] Preparing transaction signature package...`,
      `Signature: ${signature}`,
      `Broadcasting proof to x402 gateway: POST /api/agents/${pendingPayment.agentId}/invoke`
    ]);

    // Retry invocation with signature proof header attached!
    await invokeAgent(pendingPayment.agentId, pendingPayment.prompt, signature);
    setCustomSignature('');
  };

  // Helper to copy strings (Addresses/IDs)
  const handleCopyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="min-h-screen bg-[#081425] text-[#d8e3fb] font-sans antialiased flex flex-col selection:bg-[#4285F4]/30 selection:text-[#14F195]">
      
      {/* 1. TOP HEADER BRAND RAIL */}
      <nav className="h-16 border-b border-[#ffffff1a] flex items-center justify-between px-8 bg-[#081425] sticky top-0 z-40 backdrop-blur-md bg-opacity-95">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-[#4285F4] to-[#14F195] rounded-lg flex items-center justify-center shadow-lg shadow-[#4285F4]/20">
            <Cpu className="h-5 w-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">
            SolVamos <span className="text-[#14F195]">Studio</span>
          </span>
        </div>

        {/* Server & SDK Status Indicators in Sophisticated Dark Theme */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 px-3 py-1 bg-[#152031] border border-[#14F195]/30 rounded-full">
            <div className="w-2 h-2 bg-[#14F195] rounded-full animate-pulse"></div>
            <span className="text-[10px] uppercase tracking-wider font-semibold text-[#14F195]">데브넷 활성화됨</span>
          </div>
          
          <div className="hidden md:flex items-center gap-2 px-3.5 py-1.5 bg-[#111c2d] border border-[#ffffff1a] rounded-full text-[11px]">
            <Server className="h-3.5 w-3.5 text-[#4285F4]" />
            <span className="opacity-70 text-[#94A3B8]">KMS 키 관리:</span>
            <span className="text-white font-semibold">GCP Secret Manager</span>
          </div>

          <div className="flex items-center gap-3 text-sm font-medium">
            <div className="flex items-center gap-1.5 px-3 py-1 bg-[#111c2d] border border-[#ffffff1a] rounded-full text-xs">
              <span className="opacity-70 text-[#94A3B8]">Gemini RAG:</span>
              <span className={serverStatus?.geminiConfigured ? "text-[#14F195]" : "text-[#4285F4]"}>
                {serverStatus?.geminiConfigured ? "연동 완료" : "샌드박스"}
              </span>
            </div>
          </div>
        </div>
      </nav>

      {/* 2. MAIN 12-COLUMN BENTO GRID */}
      <div className="flex-1 w-full max-w-[1550px] mx-auto p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* LEFT COLUMN: FIXED SIDEBAR (대시보드 내비게이션 및 KMS 지갑 상태) */}
        <div className="lg:col-span-3 flex flex-col gap-6" id="left-sidebar">
          
          {/* 대시보드 컨트롤 타워 카드 */}
          <div className="bg-[#152031]/80 rounded-2xl border border-[#ffffff0a] p-5 flex flex-col gap-4 shadow-xl backdrop-blur-xl" id="dashboard-switcher-card">
            <div className="flex items-center justify-between border-b border-[#ffffff1a] pb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8] flex items-center gap-2">
                <Layers className="h-4 w-4 text-[#4285F4]" /> 솔바모스 컨트롤 타워
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#14F195]/10 text-[#14F195] border border-[#14F195]/20 font-bold">
                v0.4.2
              </span>
            </div>

            <div className="flex flex-col gap-2">
              {/* 탭 1: 현재 대시보드 */}
              <button
                onClick={() => setActiveTab('create')}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between group cursor-pointer ${
                  activeTab === 'create'
                    ? 'bg-[#152031] border-[#4285F4] text-white shadow-inner ring-1 ring-white/10 font-bold'
                    : 'bg-[#081425]/60 border-[#ffffff1a] text-[#94A3B8] hover:border-[#4285F4]/50 hover:bg-[#111c2d]'
                }`}
                id="tab-create-agent"
              >
                <div className="flex items-center gap-2.5">
                  <Sparkles className={`h-4.5 w-4.5 ${activeTab === 'create' ? 'text-[#14F195]' : 'text-[#4285F4]'}`} />
                  <span className="text-xs">현재 대시보드 (Agent 생성)</span>
                </div>
                <ChevronRight className="h-4 w-4 opacity-50 group-hover:translate-x-0.5 transition-transform" />
              </button>

              {/* 탭 2: 에이전트 목록 */}
              <button
                onClick={() => setActiveTab('list')}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between group cursor-pointer ${
                  activeTab === 'list'
                    ? 'bg-[#152031] border-[#4285F4] text-white shadow-inner ring-1 ring-white/10 font-bold'
                    : 'bg-[#081425]/60 border-[#ffffff1a] text-[#94A3B8] hover:border-[#4285F4]/50 hover:bg-[#111c2d]'
                }`}
                id="tab-agent-list"
              >
                <div className="flex items-center gap-2.5">
                  <Cpu className={`h-4.5 w-4.5 ${activeTab === 'list' ? 'text-[#14F195]' : 'text-[#4285F4]'}`} />
                  <span className="text-xs">에이전트 목록 대시보드</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono bg-[#4285F4]/20 text-[#4285F4] px-1.5 py-0.5 rounded-md font-bold">
                    {agents.length}
                  </span>
                  <ChevronRight className="h-4 w-4 opacity-50 group-hover:translate-x-0.5 transition-transform" />
                </div>
              </button>

              {/* 탭 3: 온체인 정산 내역 */}
              <button
                onClick={() => setActiveTab('settlements')}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between group cursor-pointer ${
                  activeTab === 'settlements'
                    ? 'bg-[#152031] border-[#4285F4] text-white shadow-inner ring-1 ring-white/10 font-bold'
                    : 'bg-[#081425]/60 border-[#ffffff1a] text-[#94A3B8] hover:border-[#4285F4]/50 hover:bg-[#111c2d]'
                }`}
                id="tab-settlements"
              >
                <div className="flex items-center gap-2.5">
                  <Coins className={`h-4.5 w-4.5 ${activeTab === 'settlements' ? 'text-[#14F195]' : 'text-[#4285F4]'}`} />
                  <span className="text-xs">온체인 정산 내역 대시보드</span>
                </div>
                <ChevronRight className="h-4 w-4 opacity-50 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* B2B KMS 지갑 준비완료 상태 */}
          <div className="bg-[#152031]/80 rounded-2xl p-5 border border-[#ffffff0a] flex items-center gap-4 shadow-xl backdrop-blur-xl" id="kms-wallet-card">
            <div className="w-12 h-12 bg-[#081425] rounded-xl border border-[#ffffff1a] flex items-center justify-center shadow-inner">
              <Wallet className="w-6 h-6 text-[#14F195]" />
            </div>
            <div>
              <p className="text-[10px] uppercase font-bold text-[#4285F4] tracking-widest">B2B KMS 지갑 준비 완료</p>
              <p className="text-xs font-mono text-[#94A3B8] mt-0.5">
                {activeAgent ? `${activeAgent.publicKey.slice(0, 6)}...${activeAgent.publicKey.slice(-6)}` : '에이전트 미선택'} · 124.50 USDC
              </p>
            </div>
          </div>

          {/* Playground Helper Card */}
          <div className="bg-[#152031]/80 rounded-2xl border border-[#ffffff0a] p-5 flex flex-col gap-3 shadow-xl text-xs backdrop-blur-xl" id="pay-sh-guide-card">
            <h4 className="font-semibold text-white flex items-center gap-2">
              <Info className="h-4 w-4 text-[#14F195]" /> pay.sh 작동 프로토콜 가이드
            </h4>
            <div className="space-y-3.5 text-[#94A3B8] leading-relaxed">
              <p>
                <strong>1. 결제 장벽 (Paywall)</strong>: API 호출 시 <span className="font-mono bg-[#081425] px-1 py-0.5 rounded text-white text-[10px]">X-PAYMENT-PROOF</span> 헤더가 비어 있으면 백엔드에서 <span className="text-amber-300 font-semibold">HTTP 402</span> 코드를 반환합니다.
              </p>
              <p>
                <strong>2. Solana 실시간 결제</strong>: 클라이언트는 에이전트의 온체인 볼트(Vault) 지갑 주소로 설정된 API 이용료만큼의 Devnet USDC 트랜잭션을 전송합니다. (무료 에이전트일 경우 바로 답을 반환합니다)
              </p>
              <p>
                <strong>3. 분할 정산 검증</strong>: 백엔드가 Solana Devnet RPC 노드를 조회하여 온체인 합의 서명을 실시간으로 검증 후, 이용료의 90%는 에이전트 지갑에, 10%는 플랫폼 제작자의 지갑으로 자동 이체합니다.
              </p>
            </div>
            <div className="mt-1 bg-[#040e1f] p-3 rounded-lg border border-[#ffffff1a] font-mono text-[10px] text-[#14F195]/80 text-center uppercase tracking-widest font-semibold">
              ⚡ 상태: 안전 대기 중 (SECURE STANDBY)
            </div>
          </div>

        </div>

        {/* CENTER COLUMN: DYNAMIC CONTROLLER PANEL */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {activeTab === 'create' && (
            <div className="bg-[#152031]/50 rounded-2xl border border-[#ffffff0a] p-6 flex flex-col gap-6 shadow-xl relative overflow-hidden flex-1 backdrop-blur-xl">
              
              {/* Step Indicators */}
              <div className="flex items-center justify-between pb-3 border-b border-[#ffffff1a] mb-1">
                <span className="font-semibold text-xs uppercase text-[#94A3B8] tracking-wider">
                  에이전트 컴파일러 콘솔 (Agent Compiler)
                </span>
                
                {/* Desktop Progress Indicators */}
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3].map((s) => (
                    <div key={s} className="flex items-center">
                      <div className={`h-5 w-5 rounded-full flex items-center justify-center font-mono text-[10px] font-bold ${
                        builderStep === s 
                          ? 'bg-[#14F195] text-[#081425] ring-4 ring-[#14F195]/20' 
                          : builderStep > s 
                          ? 'bg-[#4285F4] text-white' 
                          : 'bg-[#081425] text-[#94A3B8]/40 border border-[#ffffff1a]'
                      }`}>
                        {builderStep > s ? '✓' : s}
                      </div>
                      {s < 3 && <div className={`w-6 h-[1.5px] ${builderStep > s ? 'bg-[#4285F4]' : 'bg-[#ffffff1a]'}`} />}
                    </div>
                  ))}
                </div>
              </div>

              <AnimatePresence mode="wait">
                {builderStep === 1 && (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    className="space-y-5"
                  >
                    <div>
                      <h3 className="font-bold text-lg text-white mb-1">에이전트 매개변수 설정</h3>
                      <p className="text-xs text-[#94A3B8]">독립적인 의사 결정을 실행할 에이전트의 성격 및 보안 레벨을 정의합니다.</p>
                    </div>

                    {/* 1. ROLE Presets */}
                    <div className="space-y-2">
                      <label className="text-xs font-mono font-bold uppercase tracking-widest text-[#4285F4] block">1. 에이전트 특화 분야 (역할)</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { id: 'support', label: '프로덕트 기술 지원', desc: '특정 프로덕트의 API 가이드 및 해결', icon: HelpCircle },
                          { id: 'academic', label: '독점 학술 및 논문 데이터', desc: '학술 자료 및 연구 분석', icon: Layers },
                          { id: 'weather', label: '프라이빗 지리/기상 예측', desc: '지리 데이터 및 환경 분석', icon: Globe },
                          { id: 'custom', label: '직접입력', desc: '에이전트 맞춤 설정 및 가이드', icon: Plus },
                        ].map((item) => {
                          const Icon = item.icon;
                          const isSel = options.role === item.id;
                          return (
                            <button
                              key={item.id}
                              onClick={() => setOptions({ ...options, role: item.id as any })}
                              className={`p-3 rounded-xl text-left border transition-all cursor-pointer ${
                                isSel 
                                  ? 'bg-[#4285F4] text-white rounded-lg text-sm font-semibold shadow-inner ring-1 ring-white/20 border-[#4285F4]' 
                                  : 'bg-[#152031] border border-[#ffffff1a] text-[#94A3B8] rounded-lg text-sm hover:border-[#4285F4]/50'
                              }`}
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <Icon className={`h-4 w-4 ${isSel ? 'text-white animate-pulse' : 'text-[#4285F4]'}`} />
                                <span className="font-semibold text-xs block">{item.label}</span>
                              </div>
                              <span className={`text-[10px] block line-clamp-1 ${isSel ? 'text-white/80' : 'text-[#94A3B8]'}`}>{item.desc}</span>
                            </button>
                          );
                        })}
                      </div>

                      {options.role === 'custom' && (
                        <div className="mt-3 p-3 bg-[#152031]/50 rounded-xl border border-[#4285F4]/30 space-y-1.5">
                          <label className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#4285F4] block">
                            직접 입력 (커스텀 역할 정의)
                          </label>
                          <input
                            type="text"
                            value={options.customRole || ''}
                            onChange={(e) => setOptions({ ...options, customRole: e.target.value })}
                            placeholder="예: 실시간 환율 정보 제공, 학술 논문 교정"
                            className="w-full bg-[#0a111a]/80 border border-[#ffffff0f] focus:border-[#4285F4]/50 text-xs rounded-lg px-3 py-2 text-white placeholder-[#94A3B8]/40 outline-none transition-all"
                          />
                        </div>
                      )}
                    </div>

                    {/* 2. TONE Presets */}
                    <div className="space-y-2">
                      <label className="text-xs font-mono font-bold uppercase tracking-widest text-[#4285F4] block">2. 커뮤니케이션 톤 앤 매너</label>
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { id: 'professional', label: '전문가형' },
                          { id: 'casual', label: '개발자형' },
                          { id: 'academic', label: '학술적' },
                          { id: 'cyberpunk', label: '해커형' },
                        ].map((item) => {
                          const isSel = options.tone === item.id;
                          return (
                            <button
                              key={item.id}
                              onClick={() => setOptions({ ...options, tone: item.id as any })}
                              className={`py-2.5 px-1 rounded-lg border text-center text-xs font-semibold transition-all cursor-pointer ${
                                isSel 
                                  ? 'bg-[#4285F4] text-white rounded-lg shadow-inner ring-1 ring-white/20 border-[#4285F4]' 
                                  : 'bg-[#152031] border border-[#ffffff1a] text-[#94A3B8] hover:border-[#4285F4]/50'
                              }`}
                            >
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 3. SECURITY Presets */}
                    <div className="space-y-2">
                      <label className="text-xs font-mono font-bold uppercase tracking-widest text-[#4285F4] block">3. 보안 가드레일 등급</label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { id: 'strict', label: 'Strict (엄격)', desc: '추측 배제' },
                          { id: 'balanced', label: 'Balanced (균형)', desc: '최적화 조언' },
                          { id: 'permissive', label: 'Permissive (자율)', desc: '실험적 코드' },
                        ].map((item) => {
                          const isSel = options.securityLevel === item.id;
                          return (
                            <button
                              key={item.id}
                              onClick={() => setOptions({ ...options, securityLevel: item.id as any })}
                              className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                                isSel 
                                  ? 'bg-[#152031] border-[#14F195] text-white ring-1 ring-[#14F195]/30' 
                                  : 'bg-[#152031] border border-[#ffffff1a] text-[#94A3B8] hover:border-[#4285F4]/50'
                              }`}
                            >
                              <span className="font-semibold text-xs block mb-0.5">{item.label}</span>
                              <span className="text-[9px] text-[#94A3B8]/80 block">{item.desc}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 4. API USAGE FEE Preset */}
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <label className="text-xs font-mono font-bold uppercase tracking-widest text-[#4285F4] block">
                          4. API 이용료 설정 (USDC)
                        </label>
                        <span className="text-xs font-bold font-mono text-[#14F195] bg-[#14F195]/10 px-2 py-0.5 rounded border border-[#14F195]/20">
                          {options.fee === 0 ? "무료 (Paywall 없음)" : `${options.fee} USDC`}
                        </span>
                      </div>
                      <div className="bg-[#152031] p-4 rounded-xl border border-[#ffffff1a] space-y-3">
                        <input
                          type="range"
                          min="0"
                          max="0.2"
                          step="0.001"
                          value={options.fee !== undefined ? options.fee : 0.001}
                          onChange={(e) => setOptions({ ...options, fee: parseFloat(parseFloat(e.target.value).toFixed(3)) })}
                          className="w-full accent-[#14F195] cursor-pointer h-1.5 bg-[#081425] rounded-lg appearance-none"
                        />
                        <div className="flex justify-between text-[10px] text-[#94A3B8] font-mono">
                          <span>무료 (0 USDC)</span>
                          <span>기본값 (0.001 USDC)</span>
                          <span>최대 (0.2 USDC)</span>
                        </div>
                        <p className="text-[10px] text-[#94A3B8]/70 leading-relaxed">
                          * 무료 설정 시 X-PAYMENT-PROOF 검증 없이 즉시 API 결과가 방출됩니다. 유료 설정 시에는 90%가 에이전트 지갑으로, 10%가 플랫폼 개발자 지갑으로 실시간 분할 정산됩니다.
                        </p>
                      </div>
                    </div>

                    {/* 5. REAL-TIME COMPILER DRIFT PREVIEW */}
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <label className="text-xs font-mono font-bold uppercase tracking-widest text-[#4285F4]">프롬프트 실시간 컴파일 상태</label>
                        <span className="text-[10px] font-mono text-[#14F195] flex items-center gap-1 font-semibold">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#14F195] animate-ping" /> 컴파일 완료됨
                        </span>
                      </div>
                      <div className="bg-[#081425] rounded-xl p-3 border border-[#ffffff1a] font-mono text-[10px] text-[#14F195]/80 h-[100px] overflow-y-auto overflow-x-hidden leading-relaxed">
                        <span className="text-purple-300 block mb-1">// 컴파일된 에이전트용 시스템 프롬프트 명세:</span>
                        {livePromptPreview}
                      </div>
                    </div>

                    {/* Deploy Action Button */}
                    <button
                      onClick={handleCreateAgent}
                      className="w-full py-4 bg-gradient-to-r from-[#4285F4] to-[#14F195] text-[#081425] font-bold rounded-xl flex items-center justify-center gap-2 shadow-xl shadow-[#4285F4]/10 hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer text-sm"
                    >
                      <span>온체인 에이전트 컴파일 및 배포</span>
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </motion.div>
                )}

                {builderStep === 2 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="flex flex-col items-center justify-center py-16 text-center space-y-6"
                  >
                    <div className="relative">
                      <div className="h-20 w-20 rounded-full border-4 border-t-[#14F195] border-[#ffffff1a] animate-spin" />
                      <Lock className="h-8 w-8 text-[#4285F4] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                    </div>
                    <div className="space-y-2 max-w-md">
                      <h3 className="text-lg font-bold text-white">암호화 볼트(Vault) 구축 중...</h3>
                      <p className="text-xs text-[#94A3B8] leading-relaxed">
                        보안 가드레일을 주입하고, Solana Devnet상에 고유 정산 지갑을 할당하며, 비공개 키쌍을 Google Cloud Secret Manager KMS에 안전하게 마운트하고 있습니다.
                      </p>
                    </div>
                    <div className="w-full max-w-xs bg-[#081425] rounded-lg p-3 border border-[#ffffff1a] font-mono text-[10px] text-[#14F195]/90 text-left">
                      <div className="flex justify-between"><span>비대칭 키쌍 생성...</span><span className="text-white">완료 (OK)</span></div>
                      <div className="flex justify-between"><span>RAG 정밀 인덱스 빌드...</span><span className="text-white">완료 (OK)</span></div>
                      <div className="flex justify-between"><span>GCP KMS 봉인 요청...</span><span className="text-amber-400 animate-pulse">봉인 중 (KMS)</span></div>
                    </div>
                  </motion.div>
                )}

                {builderStep === 3 && creationResult && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-5"
                  >
                    <div className="text-center space-y-2 py-4">
                      <div className="inline-flex h-14 w-14 rounded-full bg-[#14F195]/10 border border-[#14F195]/30 items-center justify-center mb-1">
                        <CheckCircle2 className="h-8 w-8 text-[#14F195]" />
                      </div>
                      <h3 className="text-lg font-bold text-white">에이전트 컴파일 완료!</h3>
                      <p className="text-xs text-[#94A3B8]">독립형 의사결정 에이전트가 온체인 정산 지갑과 결합되어 정상적으로 생성되었습니다.</p>
                    </div>

                    <div className="bg-[#081425] rounded-xl p-4 border border-[#ffffff1a] space-y-3 font-mono text-xs">
                      <div className="flex justify-between items-center py-1 border-b border-[#ffffff0a]">
                        <span className="text-[#94A3B8]">생성된 에이전트 ID:</span>
                        <span className="text-white font-semibold">{creationResult.agentId}</span>
                      </div>

                      <div className="flex flex-col gap-1.5 py-1 border-b border-[#ffffff0a]">
                        <span className="text-[#94A3B8]">Solana Vault 공개키:</span>
                        <div className="flex items-center justify-between bg-[#111c2d] p-1.5 rounded border border-[#ffffff1a]">
                          <span className="text-[#14F195] text-[10px] truncate max-w-[220px]">{creationResult.publicKey}</span>
                          <button 
                            onClick={() => handleCopyText(creationResult.publicKey, 'pubkey')}
                            className="hover:text-white text-[#94A3B8] p-1 cursor-pointer"
                          >
                            {copiedId === 'pubkey' ? <Check className="h-3.5 w-3.5 text-[#14F195]" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 py-1">
                        <span className="text-[#94A3B8]">GCP Secret Manager 암호 보관소 경로:</span>
                        <span className="text-white text-[10px] break-all leading-tight bg-[#111c2d] p-2 rounded border border-[#ffffff1a]">
                          {creationResult.gcpVaultPath}
                        </span>
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={() => setBuilderStep(1)}
                        className="flex-1 border border-[#ffffff1a] hover:bg-[#111c2d] text-[#94A3B8] font-semibold py-2.5 px-4 rounded-xl text-center text-xs transition-all cursor-pointer"
                      >
                        추가 생성하기
                      </button>
                      <button
                        onClick={() => {
                          setBuilderStep(1);
                          setActiveAgent(creationResult.agent);
                        }}
                        className="flex-1 bg-[#14F195] hover:bg-[#14F195]/90 text-[#081425] font-bold py-2.5 px-4 rounded-xl text-center text-xs transition-all cursor-pointer shadow-lg shadow-[#14F195]/20"
                      >
                        샌드박스에서 즉시 테스트
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

            </div>
          )}

          {activeTab === 'list' && (
            <div className="bg-[#152031]/50 rounded-2xl border border-[#ffffff0a] p-6 flex flex-col gap-6 shadow-xl relative overflow-hidden flex-1 backdrop-blur-xl">
              <div className="flex justify-between items-center pb-3 border-b border-[#ffffff1a]">
                <h3 className="font-bold text-base text-white flex items-center gap-2">
                  <Layers className="h-5 w-5 text-[#4285F4]" /> 구축 완료된 에이전트 목록
                </h3>
                <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#4285F4]/15 text-[#4285F4] border border-[#4285F4]/20 font-bold">
                  총 {agents.length}개 에이전트 가동 중
                </span>
              </div>

              <div className="flex flex-col gap-3.5 max-h-[600px] overflow-y-auto pr-1">
                {agents.map((agent) => {
                  const isActive = activeAgent?.id === agent.id;
                  return (
                    <div
                      key={agent.id}
                      className={`p-4 rounded-xl border transition-all relative overflow-hidden ${
                        isActive 
                          ? 'bg-[#152031] border-[#14F195] shadow-md ring-1 ring-[#14F195]/20' 
                          : 'bg-[#081425]/40 border-[#ffffff1a] hover:border-[#4285F4]/40 hover:bg-[#111c2d]/50'
                      }`}
                    >
                      {isActive && (
                        <div className="absolute left-0 top-0 bottom-0 w-[4px] bg-[#14F195]" />
                      )}

                      <div className="flex justify-between items-start mb-2">
                        <div className="space-y-0.5">
                          <span className="font-bold text-white text-sm block">{agent.id}</span>
                          <span className="text-[9px] text-[#94A3B8]/60 block font-mono">생성일시: {new Date(agent.created).toLocaleString()}</span>
                        </div>
                        <span className={`text-[10px] font-mono px-2.5 py-0.5 rounded uppercase font-bold max-w-[120px] truncate ${
                          agent.role === 'support' ? 'bg-[#4285F4]/10 text-[#4285F4] border border-[#4285F4]/20' :
                          agent.role === 'academic' ? 'bg-[#14F195]/10 text-[#14F195] border border-[#14F195]/20' :
                          agent.role === 'weather' ? 'bg-amber-400/10 text-amber-300 border border-amber-400/20' :
                          'bg-purple-400/10 text-purple-300 border border-purple-400/20'
                        }`} title={agent.role === 'custom' ? (agent.customRole || '직접입력') : undefined}>
                          {agent.role === 'support' ? '기술 지원' :
                           agent.role === 'academic' ? '학술 데이터' :
                           agent.role === 'weather' ? '기상/지리 예측' : (agent.customRole || '직접입력')}
                        </span>
                      </div>

                      <div className="space-y-2 mb-3">
                        <div className="bg-[#081425]/60 p-2 rounded border border-[#ffffff0a] flex items-center justify-between font-mono text-[10px]">
                          <span className="text-[#94A3B8] shrink-0">볼트 주소:</span>
                          <span className="text-white truncate max-w-[140px] px-2">{agent.publicKey}</span>
                          <button 
                            onClick={() => handleCopyText(agent.publicKey, agent.id)}
                            className="hover:text-white text-[#94A3B8]/60 cursor-pointer"
                          >
                            {copiedId === agent.id ? <Check className="h-3 w-3 text-[#14F195]" /> : <Copy className="h-3 w-3" />}
                          </button>
                        </div>

                        <div className="flex gap-4 text-[11px] font-mono text-[#94A3B8] flex-wrap">
                          <span>매너: <strong className="text-white capitalize">{agent.tone}</strong></span>
                          <span>가드레일: <strong className="text-amber-300 capitalize">{agent.securityLevel}</strong></span>
                          <span>이용료: <strong className="text-[#14F195]">{agent.fee !== undefined ? (agent.fee === 0 ? '무료' : `${agent.fee} USDC`) : '0.001 USDC'}</strong></span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-3.5 border-t border-[#ffffff0a]">
                        <span className="text-xs font-mono text-[#14F195] flex items-center gap-1 font-semibold">
                          <Coins className="h-3.5 w-3.5" /> {agent.invokeCount}회 누적 정산 호출
                        </span>

                        <button
                          onClick={() => {
                            setActiveAgent(agent);
                            setPendingPayment(null);
                          }}
                          disabled={isActive}
                          className={`px-3 py-1.5 rounded-lg font-bold text-xs transition-all cursor-pointer ${
                            isActive
                              ? 'bg-[#14F195]/10 text-[#14F195] border border-[#14F195]/30'
                              : 'bg-[#4285F4] text-white hover:brightness-110'
                          }`}
                        >
                          {isActive ? '연동됨 (Active)' : '샌드박스 연동하기'}
                        </button>
                      </div>
                    </div>
                  );
                })}

                {agents.length === 0 && (
                  <div className="text-center py-16 text-[#94A3B8]/40 text-xs">
                    활성화된 에이전트가 존재하지 않습니다. 첫 번째 에이전트를 먼저 컴파일해주세요.
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'settlements' && (
            <div className="bg-[#152031]/50 rounded-2xl border border-[#ffffff0a] p-6 flex flex-col gap-6 shadow-xl relative overflow-hidden flex-1 backdrop-blur-xl">
              <div className="flex justify-between items-center pb-3 border-b border-[#ffffff1a]">
                <h3 className="font-bold text-base text-white flex items-center gap-2">
                  <Coins className="h-5 w-5 text-[#14F195]" /> 온체인 정산 오딧 장부
                </h3>
                <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-[#14F195]/15 text-[#14F195] border border-[#14F195]/20 font-bold">
                  실시간 연동 상태
                </span>
              </div>

              {/* 통계 요약 카드 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[#081425]/70 p-3 rounded-xl border border-[#ffffff1a] text-center">
                  <span className="text-[9px] text-[#94A3B8] block">총 오딧 횟수</span>
                  <span className="text-base font-bold text-white font-mono block mt-1">{settlements.length}회</span>
                </div>
                <div className="bg-[#081425]/70 p-3 rounded-xl border border-[#ffffff1a] text-center">
                  <span className="text-[9px] text-[#94A3B8] block">누적 검증 수수료</span>
                  <span className="text-base font-bold text-[#14F195] font-mono block mt-1">
                    {settlements.filter(s => s.status === 'success').reduce((sum, s) => sum + s.amount, 0).toFixed(4)} USDC
                  </span>
                </div>
                <div className="bg-[#081425]/70 p-3 rounded-xl border border-[#ffffff1a] text-center">
                  <span className="text-[9px] text-[#94A3B8] block">정산 성공률</span>
                  <span className="text-base font-bold text-[#4285F4] font-mono block mt-1">
                    {settlements.length > 0 ? `${((settlements.filter(s => s.status === 'success').length / settlements.length) * 100).toFixed(0)}%` : '100%'}
                  </span>
                </div>
              </div>

              <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                {settlements.map((tx) => (
                  <div key={tx.id} className="bg-[#081425]/40 p-3.5 rounded-xl border border-[#ffffff1a] space-y-2.5">
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="text-[#94A3B8]">{tx.timestamp}</span>
                      <span className={`px-2 py-0.5 rounded uppercase font-bold text-[9px] ${
                        tx.status === 'success' 
                          ? 'bg-[#14F195]/10 text-[#14F195] border border-[#14F195]/20' 
                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                       }`}>
                        {tx.status === 'success' ? '정산 성공' : '정산 실패'}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60 font-mono text-[10px]">호출 대상:</span>
                        <span className="text-white font-mono text-[11px] truncate max-w-[150px]">{tx.agentId}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-[#94A3B8]/60 font-mono text-[10px]">트랜잭션 해시:</span>
                        <div className="flex items-center gap-1">
                          <span className="text-white font-mono text-[10px] text-[#4285F4]">{tx.id.slice(0, 8)}...{tx.id.slice(-8)}</span>
                          <button 
                            onClick={() => handleCopyText(tx.id, tx.id)}
                            className="text-[#94A3B8]/60 hover:text-white"
                          >
                            {copiedId === tx.id ? <Check className="h-3 w-3 text-[#14F195]" /> : <Copy className="h-3 w-3" />}
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#94A3B8]/60 font-mono text-[10px]">오딧 블록높이:</span>
                        <span className="text-white font-mono text-[11px]">#{tx.blockHeight}</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-[#ffffff0a] text-[10px] font-mono">
                      <span className="text-[#94A3B8]/60">정산 규격:</span>
                      <span className="text-white font-bold text-xs">{tx.amount} USDC</span>
                    </div>
                  </div>
                ))}

                {settlements.length === 0 && (
                  <div className="text-center py-12 text-[#94A3B8]/30 text-xs">
                    정산된 트랜잭션 오딧 이력이 없습니다.
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* RIGHT COLUMN: GLASSMORPHISM CHAT SANDBOX TESTBED */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          
          {/* Main Sandbox Box */}
          <div className="bg-[#040e1f] rounded-2xl border border-[#ffffff1a] shadow-2xl flex flex-col flex-1 h-[600px] relative overflow-hidden">
            
            {/* Header / Tabs */}
            <div className="bg-[#081425] border-b border-[#ffffff1a] px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 bg-[#4285F4] rounded-full animate-pulse"></div>
                <h3 className="text-sm font-bold uppercase tracking-wider">실행 샌드박스 (Sandbox)</h3>
              </div>

              {/* Chat / Logs Mode Tabs */}
              <div className="flex bg-[#081425] p-0.5 rounded-lg border border-[#ffffff1a]">
                <button
                  onClick={() => setActiveChatTab('chat')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    activeChatTab === 'chat' 
                      ? 'bg-[#152031] text-white border border-[#ffffff1a]' 
                      : 'text-[#94A3B8]/60 hover:text-white'
                  }`}
                >
                  샌드박스
                </button>
                <button
                  onClick={() => setActiveChatTab('logs')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-all flex items-center gap-1 cursor-pointer ${
                    activeChatTab === 'logs' 
                      ? 'bg-[#152031] text-[#14F195] border border-[#ffffff1a]' 
                      : 'text-[#94A3B8]/60 hover:text-white'
                  }`}
                >
                  실시간 RPC 로그
                </button>
              </div>
            </div>

            {/* Main testing contents */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 relative bg-[#152031]/10">
              
              {activeChatTab === 'chat' ? (
                <>
                  {activeAgent ? (
                    <>
                      {/* Introductory System message */}
                      <div className="bg-[#152031]/80 rounded-xl p-3 border border-[#ffffff0a] text-xs text-[#94A3B8]">
                        <p className="font-semibold text-white mb-1 flex items-center gap-1">
                          <Cpu className="h-3.5 w-3.5 text-[#14F195]" /> 
                          에이전트 실시간 연동: {activeAgent.id}
                        </p>
                        <p className="leading-relaxed">
                          프롬프트를 입력하세요. 에이전트 게이트웨이가 실행(execution)을 감지하면 <span className="text-[#14F195] font-semibold">HTTP 402 Payment Required</span> 프로토콜을 동작시켜 온체인 정산 증명(Signature)을 요구합니다. 아래 버튼을 눌러 승인 시 즉시 Devnet 상에 {activeAgent.fee === 0 ? "0" : (activeAgent.fee !== undefined ? activeAgent.fee : 0.001)} USDC 결제 트랜잭션을 전송하여 암호화를 해제합니다.
                        </p>
                      </div>

                      {/* Messages loop */}
                      {(chatHistory[activeAgent.id] || []).map((msg) => {
                        if (msg.sender === 'user') {
                          return (
                            <div key={msg.id} className="flex justify-end gap-2">
                              <span className="text-[10px] text-[#94A3B8] font-mono mt-2">{msg.timestamp}</span>
                              <div className="bg-[#4285F4] text-white text-xs px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] shadow-md">
                                {msg.text}
                              </div>
                            </div>
                          );
                        } else if (msg.sender === 'system') {
                          return (
                            <div key={msg.id} className="bg-[#93000a]/10 border border-[#ffb4ab]/30 text-[#ffb4ab] text-xs p-4 rounded-xl space-y-2">
                              <div className="flex items-start gap-2">
                                <Lock className="h-4 w-4 shrink-0 mt-0.5 text-[#ffb4ab]" />
                                <div className="space-y-1">
                                  <div className="font-bold text-white uppercase tracking-wider text-[10px]">pay.sh 프로토콜 결제 필요 (402 PAYMENT REQUIRED)</div>
                                  <p className="leading-relaxed text-[11px] whitespace-pre-line font-mono">{msg.text}</p>
                                </div>
                              </div>
                            </div>
                          );
                        } else {
                          // Agent response (with glassmorphism visual style as per design instructions)
                          return (
                            <div key={msg.id} className="flex flex-col gap-1">
                              <div className="bg-white/[0.04] backdrop-blur-[24px] border border-white/[0.08] text-[#d8e3fb] text-xs px-4 py-3 rounded-2xl rounded-tl-sm max-w-[90%] shadow-lg space-y-2 leading-relaxed">
                                <p className="font-mono text-[10px] uppercase font-bold text-[#4285F4]">에이전트 암호화 해제 출력:</p>
                                <p className="whitespace-pre-line text-white italic">"{msg.text}"</p>
                                
                                {msg.paymentStatus === 'verified' && (
                                  <div className="border-t border-white/[0.08] pt-2 mt-2 flex justify-between items-center text-[9px] font-mono text-[#14F195]/80">
                                    <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> 온체인 정산 증명 검증 완료 (Audit Verified)</span>
                                    <span>Tx: {msg.paymentTx?.slice(0, 10)}...</span>
                                  </div>
                                )}
                              </div>
                              {msg.confidence !== undefined && (
                                <span className="text-[10px] text-[#94A3B8]/40 font-mono ml-2">
                                  에이전트 답변 신뢰도 점수: {(msg.confidence * 100).toFixed(2)}%
                                </span>
                              )}
                            </div>
                          );
                        }
                      })}

                      {/* Paywall block trigger visual overlay */}
                      {pendingPayment && (
                        <div className="bg-[#0f1d32]/95 border border-[#14F195]/40 rounded-xl p-4 mt-2 space-y-4 shadow-2xl">
                          <div className="flex items-start gap-3">
                            <Coins className="h-5 w-5 text-[#14F195] shrink-0 mt-0.5 animate-bounce" />
                            <div>
                              <h4 className="text-white font-bold text-xs">에이전트 가상 터널 암호화 해제</h4>
                              <p className="text-[11px] text-[#94A3B8]/80 leading-relaxed mt-0.5">
                                안전하게 생성된 에이전트 전용 볼트(Vault) 지갑 주소로 {pendingPayment.amount} USDC 결제 트랜잭션을 브로드캐스팅합니다.
                              </p>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <button
                              onClick={() => handleAcknowledgeAndSign(true)}
                              className="w-full bg-[#14F195] hover:bg-[#14F195]/90 text-[#081425] font-bold py-2.5 px-3 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-lg shadow-[#14F195]/10"
                            >
                              <Wallet className="h-3.5 w-3.5" /> 간편 확인 및 온체인 자동 서명 생성 (이용료 {pendingPayment.amount} USDC)
                            </button>

                            <div className="relative flex items-center justify-center">
                              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[#ffffff1a]"></div></div>
                              <span className="relative bg-[#0f1d32] px-2 text-[10px] text-[#94A3B8]/40 font-mono uppercase">또는 트랜잭션 서명 직접 제출</span>
                            </div>

                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={customSignature}
                                onChange={(e) => setCustomSignature(e.target.value)}
                                placeholder="Solana Devnet 트랜잭션 서명 해시를 입력하세요"
                                className="flex-1 bg-[#081425] text-xs font-mono px-3 py-1.5 rounded-lg border border-[#ffffff1a] text-white focus:outline-none focus:border-[#4285F4]"
                              />
                              <button
                                onClick={() => handleAcknowledgeAndSign(false)}
                                className="bg-[#4285F4] hover:bg-[#4285F4]/95 text-white px-3 rounded-lg text-xs font-semibold cursor-pointer"
                              >
                                정산 서명 제출
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Verified loader during RPC operations */}
                      {isVerifyingPayment && (
                        <div className="flex justify-start items-center gap-2 text-xs font-mono text-[#14F195] py-2 bg-[#14F195]/5 border border-[#14F195]/10 rounded-lg px-3">
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          <span>Solana Devnet RPC에서 결제 증명을 온체인 검증 중 (api.devnet.solana.com)...</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center p-6 text-[#94A3B8]/50">
                      <HelpCircle className="h-12 w-12 text-[#ffffff1a] mb-3" />
                      <p className="text-xs">연동된 에이전트가 존재하지 않습니다. 새로운 에이전트를 빌드하거나 좌측 대시보드 목록에서 연동할 에이전트를 선택해주세요.</p>
                    </div>
                  )}
                </>
              ) : (
                // RPC connection log view
                <div className="space-y-3 font-mono text-[10px] leading-relaxed text-[#94A3B8]">
                  <div className="flex justify-between items-center border-b border-[#ffffff1a] pb-2 text-white">
                    <span>솔라나 온체인 트랜잭션 실시간 오딧</span>
                    <span className="text-[#14F195]">RPC 연결 상태</span>
                  </div>

                  {paymentLogs.length === 0 ? (
                    <div className="text-[#94A3B8]/30 py-12 text-center">
                      기록된 실시간 온체인 트랜잭션 오딧 로그가 없습니다. 샌드박스에서 메시지를 송신하고 결제를 진행하면 실시간 검증 핸드셰이크가 여기에 표시됩니다.
                    </div>
                  ) : (
                    <div className="space-y-1 bg-[#081425] p-3 rounded-xl border border-[#ffffff1a] max-h-[460px] overflow-y-auto">
                      {paymentLogs.map((log, idx) => (
                        <div key={idx} className={log.includes('[SUCCESS]') || log.includes('[Payment verified!]') ? 'text-[#14F195]' : log.includes('[FAILED]') || log.includes('[Validation Failure]') ? 'text-red-400 font-semibold' : 'text-[#94A3B8]/80'}>
                          {log}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="bg-[#152031] p-3 rounded-lg border border-[#ffffff0a] space-y-1.5 text-[9px] text-[#94A3B8]/70">
                    <p className="font-semibold text-white uppercase text-[10px]">온체인 트랜잭션 오딧 표준 가이드:</p>
                    <p>모든 SOL/USDC 정산 파라미터는 Solana Devnet JSON-RPC의 'confirmed' 확정 수준으로 실시간 무결성 검증을 거칩니다. 더블 스펜딩 및 리플레이 공격은 지능형 멤풀 리더에 의해 사전 차단됩니다.</p>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Chat Input area inside the console wrapper as designed */}
            {activeChatTab === 'chat' && activeAgent && (
              <form onSubmit={handleSendMessage} className="h-20 border-t border-[#ffffff1a] bg-[#152031]/60 flex items-center px-6 gap-4">
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    disabled={!!pendingPayment || isVerifyingPayment}
                    placeholder={pendingPayment ? "⚠️ 상단의 온체인 서명 승인이 필요합니다" : "에이전트에게 전송할 프롬프트를 입력하세요..."}
                    className="w-full bg-[#081425] border border-[#ffffff1a] rounded-lg py-2.5 px-4 text-sm focus:outline-none focus:border-[#4285F4] transition-colors disabled:opacity-50 text-white"
                  />
                  <div className="absolute right-3 top-2.5 hidden sm:flex gap-2">
                    <kbd className="bg-[#1f2a3c] text-[10px] px-1.5 py-0.5 rounded border border-[#ffffff1a]">⌘</kbd>
                    <kbd className="bg-[#1f2a3c] text-[10px] px-1.5 py-0.5 rounded border border-[#ffffff1a]">Enter</kbd>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={!inputText.trim() || !!pendingPayment || isVerifyingPayment}
                  className="w-10 h-10 bg-[#4285F4] rounded-lg flex items-center justify-center text-[#081425] shadow-lg shadow-[#4285F4]/20 cursor-pointer hover:brightness-110 disabled:opacity-40"
                >
                  <ArrowRight className="h-5 w-5 text-white" />
                </button>
              </form>
            )}

          </div>

          {/* 3-Column Statistics Grid in Sandbox Panel footer */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[#152031] p-4 rounded-xl border border-[#ffffff0a]">
              <p className="text-[10px] font-bold text-[#94A3B8] uppercase">정확도 신뢰 점수</p>
              <p className="text-xl font-bold text-[#14F195] mt-1">98.42%</p>
            </div>
            <div className="bg-[#152031] p-4 rounded-xl border border-[#ffffff0a]">
              <p className="text-[10px] font-bold text-[#94A3B8] uppercase">호출 지연시간</p>
              <p className="text-xl font-bold text-white mt-1">1.2s</p>
            </div>
            <div className="bg-[#152031] p-4 rounded-xl border border-[#ffffff0a]">
              <p className="text-[10px] font-bold text-[#94A3B8] uppercase">Solana 가스 비용</p>
              <p className="text-xl font-bold text-white mt-1">0.0004 SOL</p>
            </div>
          </div>

        </div>

      </div>

      {/* Bottom Status Bar */}
      <footer className="h-8 bg-[#040e1f] border-t border-[#ffffff1a] flex items-center justify-between px-6 text-[10px] font-mono text-[#94A3B8]">
        <div className="flex gap-6">
          <span>RPC: devnet.solana.com</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 bg-[#14F195] rounded-full"></span> Vertex AI 연동 완료</span>
          <span>GCP 프로젝트 ID: solvamos-mainnet-pay-sh</span>
        </div>
        <div className="flex gap-4">
          <span>v0.4.2-stable</span>
          <span className="text-[#4285F4]">온체인 API: 연결 완료</span>
        </div>
      </footer>

    </div>
  );
}
