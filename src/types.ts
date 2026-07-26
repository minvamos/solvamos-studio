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
  /** Raw DB counter before Studio-test correction (debug). */
  rawInvokeCount?: number;
  studioTestCount?: number;
  /** Verified PaymentSettlement rows for this agent. */
  paidCallCount?: number;
  /** Seller share of settled gross fees (after platform cut). */
  estSellerRevenueUsdc?: number;
  vaultSol?: number | null;
  vaultUsdc?: number | null;
  googleDriveFolderId?: string;
  vertexDataStoreId?: string;
  vertexEngineId?: string;
  aiAppType?: string;
  dataSourceType?: string;
  /** specialized = AI Applications Answer; autonomous = Gemini + Data Store RAG */
  runtimeMode?: 'specialized' | 'autonomous' | string;
  /** Free-form instructions appended into systemPrompt */
  customInstructions?: string;
  websiteUri?: string;
  gcsUri?: string;
  secretManagerPath?: string;
  status?: string;
  fee?: number;
  perCallPriceUsdc?: number;
  catalogPageUrl?: string;
  catalogApiUrl?: string;
  invokeUrl?: string;
  agentCardUrl?: string;
  payShCatalog?: {
    catalogId?: string;
    invokeUrl?: string;
    publicInvokeUrl?: string;
    catalogPageUrl?: string;
    catalogApiUrl?: string;
    agentCardUrl?: string;
    feeUsdc?: number;
    paymentProtocol?: string;
  } | null;
}

export interface PromptOptions {
  role: 'support' | 'academic' | 'weather' | 'custom';
  customRole?: string;
  tone: 'casual' | 'professional' | 'academic' | 'cyberpunk';
  securityLevel: 'strict' | 'balanced' | 'permissive';
  /** Per-call USDC fee; 0 = free */
  fee?: number;
  /** specialized = AI Applications; autonomous = Gemini + optional Data Store RAG */
  runtimeMode?: 'specialized' | 'autonomous';
  /** Free-form personality / policy instructions */
  customInstructions?: string;
  /** AI Applications app kind (specialized mode) */
  aiAppType?: 'search_docs' | 'chat_rag' | 'website' | 'structured' | 'media';
  /** Knowledge source for the app datastore */
  dataSourceType?:
    | 'none'
    | 'local_upload'
    | 'google_drive'
    | 'website_url'
    | 'cloud_storage'
    | 'api_import'
    | 'vertex_studio';
  websiteUri?: string;
  gcsUri?: string;
}

/** Files prepared client-side for RAG ingest (no GCP console). */
export type LocalUploadFile = {
  name: string;
  mimeType?: string;
  text?: string;
  contentBase64?: string;
};

/** Per-turn chat attachments (images / PDFs / text) for Engine multimodal. */
export type ChatAttachment = {
  name: string;
  mimeType: string;
  dataBase64: string;
  previewUrl?: string;
};

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
  attachments?: ChatAttachment[];
  relatedQuestions?: string[];
  toolsUsed?: string[];
  a2aHops?: {
    toName: string;
    toAgentId: string;
    feeUsdc: number;
    paymentProof: string;
    ok: boolean;
    error?: string;
  }[];
}

export interface Settlement {
  id: string;
  agentId: string;
  recipientWallet: string;
  amount: number;
  status: 'success' | 'failed';
  timestamp: string;
  blockHeight: number;
  network?: string;
  proofKind?: string;
  explorerUrl?: string;
}

