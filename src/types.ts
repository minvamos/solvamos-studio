/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Agent {
  id: string;
  role: string;
  customRole?: string;
  tone: string;
  securityLevel: string;
  publicKey: string;
  systemPrompt: string;
  created: string;
  invokeCount: number;
  fee?: number;
}

export interface Message {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  timestamp: string;
  confidence?: number;
  paymentStatus?: 'none' | 'pending_proof' | 'verified' | 'failed';
  paymentTx?: string;
  details?: string;
}

export interface PromptOptions {
  role: 'support' | 'academic' | 'weather' | 'custom';
  customRole?: string;
  tone: 'professional' | 'casual' | 'academic' | 'cyberpunk';
  securityLevel: 'strict' | 'balanced' | 'permissive';
  fee?: number;
}

export interface Settlement {
  id: string;
  agentId: string;
  recipientWallet: string;
  amount: number;
  status: 'success' | 'failed';
  timestamp: string;
  blockHeight: number;
}

