/**
 * SolVamos discovery Agent Card (A2A-shaped JSON for machines).
 *
 * Commerce always goes through extensions.solvamos.pay.invokeUrl
 * (gateway x402/MPP when paid). We do NOT expose Google A2A JSON-RPC
 * message/send — that path conflicts with the payment model.
 *
 * See docs/A2A.md
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
    fee > 0 || config.usePayGateway
      ? listing?.invokeUrl || gatewayInvokeUrl(agent.id)
      : listing?.invokeUrl || `${config.appUrl}/api/agents/${agent.id}/invoke`;

  return {
    name: `SolVamos — ${name}`,
    description:
      listing?.description ||
      agent.description ||
      `SolVamos RAG agent (${agent.role}). Call via invokeUrl (x402/MPP when paid).`,
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
        description:
          'Ask a question via HTTP invoke (JSON { prompt } or ?prompt=). Paid agents require x402/MPP on invokeUrl.',
        tags: ['rag', 'ai-applications', 'solvamos', 'x402', 'mpp'],
        examples: ['Summarize our leave policy', 'What does the handbook say about remote work?'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    extensions: {
      'solvamos.pay': {
        invokeUrl,
        feeUsdc: fee,
        token: 'USDC',
        network: config.paymentNetwork,
        usdcMint: config.usdcMint,
        recipientWallet: agent.publicKey,
        catalogId: listing?.catalogId,
        protocol: fee > 0 ? 'x402 / MPP' : 'free',
        gateway: 'pay.sh-compatible',
        settlement:
          fee > 0
            ? {
                sellerShare: 1 - config.platformFeeShare,
                platformShare: config.platformFeeShare,
                sellerWallet: agent.publicKey,
                treasuryWallet: config.platformTreasuryPubkey,
              }
            : undefined,
      },
    },
  };
}
