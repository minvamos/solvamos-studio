/**
 * Agent metadata store (JSON file; swap for Firestore in customer project later).
 */

import fs from 'fs';
import path from 'path';
import { compileSystemPrompt } from './prompt.js';

export interface AgentRecord {
  id: string;
  tenantId?: string;
  agentName?: string;
  role: string;
  customRole?: string;
  tone: string;
  securityLevel: string;
  publicKey: string;
  systemPrompt: string;
  created: string;
  invokeCount: number;
  googleDriveFolderId?: string;
  vertexDataStoreId?: string;
  secretManagerPath?: string;
  status?: 'CREATING' | 'INDEXING' | 'ACTIVE' | 'PAUSED' | 'ERROR' | string;
  /** Per-call fee in USDC (0 = free / no paywall) */
  fee?: number;
  perCallPriceUsdc?: number;
}

const AGENTS_FILE = path.join(process.cwd(), 'agents_db.json');
let agents: Record<string, AgentRecord> = {};

export function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(agents).length} agents from file.`);
      return;
    }
    const defaultId = 'support-copilot-001';
    agents[defaultId] = {
      id: defaultId,
      role: 'support',
      tone: 'professional',
      securityLevel: 'strict',
      publicKey: '6xP7XpU6ZqUvS9uN8tV7nN8dM9pU8vS7nN9tU8vS7nN9',
      systemPrompt: compileSystemPrompt('support', 'professional', 'strict'),
      created: new Date().toISOString(),
      invokeCount: 24,
      status: 'ACTIVE',
      fee: 0.001,
      perCallPriceUsdc: 0.001,
    };
    saveAgents();
  } catch (err) {
    console.error('Error loading agents:', err);
  }
}

export function saveAgents() {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8');
}

export function listAgents(): AgentRecord[] {
  return Object.values(agents);
}

export function getAgent(id: string): AgentRecord | undefined {
  return agents[id];
}

export function putAgent(agent: AgentRecord): AgentRecord {
  agents[agent.id] = agent;
  saveAgents();
  return agent;
}

export function bumpInvoke(id: string) {
  const a = agents[id];
  if (!a) return;
  a.invokeCount += 1;
  saveAgents();
}
