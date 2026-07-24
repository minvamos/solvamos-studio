/**
 * Minimal Google A2A–style Agent Card for discovery.
 * Paid invoke settles via x402/MPP on the pay.sh-compatible gateway URL.
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
      `SolVamos RAG agent (${agent.role}). Paid invoke via x402/MPP gateway.`,
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
        tags: ['rag', 'ai-applications', 'solvamos', 'x402', 'mpp'],
        examples: ['Summarize our leave policy', 'What does the handbook say about remote work?'],
        // Commercial endpoint = payment gateway (x402/MPP), not free JSON-RPC
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    // SolVamos extensions — discovery + paid invoke
    extensions: {
      'solvamos.pay': {
        invokeUrl,
        feeUsdc: fee,
        token: 'USDC',
        network: config.paymentNetwork,
        recipientWallet: agent.publicKey,
        catalogId: listing?.catalogId,
        protocol: fee > 0 ? 'x402 / MPP' : 'free',
        gateway: 'pay.sh-compatible',
      },
    },
  };
}
