/**
 * Minimal Google A2A–style Agent Card for discovery.
 * Payments stay on pay.sh gateway URLs (not a substitute for x402).
 */
import { config } from './config.js';
import type { AgentRecord } from './agents-store.js';
import { getCatalogEntry } from './paysh-catalog.js';
import { gatewayInvokeUrl } from './pay-client.js';

export function buildAgentCard(agent: AgentRecord) {
  const listing = getCatalogEntry(agent.id);
  const fee =
    listing?.feeUsdc ??
    (typeof agent.fee === 'number'
      ? agent.fee
      : typeof agent.perCallPriceUsdc === 'number'
        ? agent.perCallPriceUsdc
        : config.defaultAgentFeeUsdc);
  const name = agent.agentName || agent.customRole || `${agent.role} / ${agent.tone}`;
  const invokeUrl =
    listing?.invokeUrl ||
    (config.usePayGateway ? gatewayInvokeUrl(agent.id) : `${config.appUrl}/api/agents/${agent.id}/invoke`);

  return {
    name: `SolVamos — ${name}`,
    description:
      listing?.description ||
      `SolVamos RAG agent (${agent.role}). Paid invoke via pay.sh gateway.`,
    url: config.usePayGateway ? config.payGatewayUrl : config.appUrl,
    provider: {
      organization: 'SolVamos',
      url: config.appUrl,
    },
    version: config.version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'rag-invoke',
        name: 'Grounded RAG answer',
        description: 'Ask a question; answer is grounded in the agent AI Application / data store.',
        tags: ['rag', 'ai-applications', 'solvamos', 'pay.sh'],
        examples: ['Summarize our leave policy', 'What does the handbook say about remote work?'],
        // Commercial endpoint = pay gateway (x402), not free JSON-RPC
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    // SolVamos extensions (non-standard) — clients that know pay.sh
    extensions: {
      'solvamos.pay': {
        invokeUrl,
        feeUsdc: fee,
        token: 'USDC',
        network: config.paymentNetwork,
        recipientWallet: agent.publicKey,
        catalogId: listing?.catalogId,
        protocol: 'pay.sh-gateway',
      },
    },
  };
}
