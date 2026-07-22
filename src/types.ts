/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Agent {
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
  status?: string;
  fee?: number;
  perCallPriceUsdc?: number;
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  kind?: 'folder' | 'file';
}

/** @deprecated use DriveItem */
export type DriveFolder = DriveItem;

export interface DrivePathCrumb {
  id: string;
  name: string;
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
  a2aHops?: {
    toName: string;
    toAgentId: string;
    feeUsdc: number;
    paymentProof: string;
    ok: boolean;
    error?: string;
  }[];
}

export interface PromptOptions {
  role: 'support' | 'academic' | 'weather' | 'custom';
  customRole?: string;
  tone: 'professional' | 'casual' | 'academic' | 'cyberpunk';
  securityLevel: 'strict' | 'balanced' | 'permissive';
  /** Per-call USDC fee; 0 = free */
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

