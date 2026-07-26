/**
 * Google A2A Protocol v1 surface via @a2a-js/sdk.
 *
 * Per-agent endpoints:
 *   GET  /a2a/:agentId/.well-known/agent-card.json
 *   POST /a2a/:agentId   (JSON-RPC message/send, tasks/*, …)
 *
 * Business logic reuses existing RAG / AI Applications path.
 * Payment (x402) is NOT part of A2A — keep using gateway invoke URLs for paid calls.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
  type Artifact,
  type TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { config } from './config.js';
import { getAgent, type AgentRecord } from './agents-store.js';
import { generateGroundedAnswer } from './rag.js';
import { getCatalogEntry } from './paysh-catalog.js';

type HandlerBundle = {
  requestHandler: DefaultRequestHandler;
  cardPath: string;
};

const handlers = new Map<string, HandlerBundle>();

function a2aBaseForAgent(agentId: string): string {
  return `${config.appUrl.replace(/\/$/, '')}/a2a/${encodeURIComponent(agentId)}`;
}

function extractText(message: Message): string {
  for (const part of message.parts || []) {
    if (part.content?.$case === 'text') {
      return String(part.content.value || '').trim();
    }
  }
  return '';
}

function buildProtocolAgentCard(agent: AgentRecord): AgentCard {
  const listing = getCatalogEntry(agent.id);
  const name = agent.agentName || agent.customRole || agent.role;
  const description =
    agent.description ||
    listing?.description ||
    `SolVamos RAG agent (${agent.customRole || agent.role}).`;
  const base = a2aBaseForAgent(agent.id);

  return {
    name: `SolVamos — ${name}`,
    description,
    supportedInterfaces: [
      {
        url: `${base}/`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: 'SolVamos',
      url: config.appUrl,
    },
    version: config.version || '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text', 'text/plain'],
    defaultOutputModes: ['text', 'text/plain', 'task-status'],
    skills: [
      {
        id: 'rag-answer',
        name: 'Grounded RAG answer',
        description:
          'Ask a natural-language question grounded in this agent AI Application / data store.',
        tags: ['rag', 'ai-applications', 'solvamos'],
        examples: [
          '이 문서에서 휴가 정책 요약해줘',
          'What does the handbook say about remote work?',
        ],
        inputModes: ['text', 'text/plain'],
        outputModes: ['text', 'text/plain', 'task-status'],
        securityRequirements: [],
      },
    ],
    documentationUrl: `${config.catalogSiteUrl || config.appUrl}/a/${encodeURIComponent(agent.id)}`,
    signatures: [],
  };
}

class SolvamosAgentExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

  constructor(private readonly agent: AgentRecord) {}

  cancelTask = async (taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelled.add(taskId);
  };

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const existingTask = requestContext.task;

    try {
      const taskSnapshot: Task =
        existingTask ??
        ({
          id: taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_SUBMITTED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          artifacts: [],
          history: [userMessage],
          metadata: userMessage.metadata,
        } as Task);
      eventBus.publish(AgentEvent.task(taskSnapshot));

      const working: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        metadata: {},
      };
      eventBus.publish(AgentEvent.statusUpdate(working));

      const prompt = extractText(userMessage);
      if (!prompt) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_FAILED,
              timestamp: new Date().toISOString(),
              message: {
                role: Role.ROLE_AGENT,
                messageId: crypto.randomUUID(),
                parts: [
                  {
                    content: { $case: 'text', value: 'Empty message — provide text content.' },
                    metadata: undefined,
                    filename: '',
                    mediaType: 'text/plain',
                  },
                ],
                taskId,
                contextId,
                extensions: [],
                metadata: {},
                referenceTaskIds: [],
              },
            },
            metadata: {},
          })
        );
        return;
      }

      if (this.cancelled.has(taskId)) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            metadata: {},
          })
        );
        return;
      }

      const rag = await generateGroundedAnswer({
        systemPrompt: this.agent.systemPrompt || '',
        userPrompt: prompt,
        dataStoreId: this.agent.vertexDataStoreId,
        engineId: this.agent.vertexEngineId,
        agentId: this.agent.id,
        geminiApiKey: config.geminiApiKey,
        runtimeMode: this.agent.runtimeMode || 'specialized',
      });

      const artifact: Artifact = {
        artifactId: crypto.randomUUID(),
        name: 'answer',
        description: 'Grounded agent answer',
        parts: [
          {
            content: { $case: 'text', value: rag.answer || '' },
            metadata: {
              confidence: rag.confidence,
              mode: rag.mode,
              citations: rag.citations,
            },
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
      };
      const artifactUpdate: TaskArtifactUpdateEvent = {
        taskId,
        contextId,
        artifact,
        lastChunk: true,
        append: false,
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate));

      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: {
            ragMode: rag.mode,
            confidence: rag.confidence,
          },
        })
      );
    } finally {
      this.cancelled.delete(taskId);
    }
  }
}

async function getHandler(agentId: string): Promise<DefaultRequestHandler> {
  const existing = handlers.get(agentId);
  if (existing) return existing.requestHandler;

  const agent = await getAgent(agentId);
  if (!agent) {
    throw Object.assign(new Error(`Agent not found: ${agentId}`), { status: 404 });
  }

  const card = buildProtocolAgentCard(agent);
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new SolvamosAgentExecutor(agent)
  );
  handlers.set(agentId, { requestHandler, cardPath: AGENT_CARD_PATH });
  return requestHandler;
}

/** Drop cached handler so card/executor pick up agent edits. */
export function invalidateA2AHandler(agentId: string) {
  handlers.delete(agentId);
}

export function registerA2ASdkRoutes(app: Express) {
  const cardPath = AGENT_CARD_PATH.replace(/^\//, '');

  app.get(`/a2a/:agentId/${cardPath}`, async (req, res, next) => {
    try {
      const handler = await getHandler(req.params.agentId);
      return agentCardHandler({ agentCardProvider: handler })(req, res, next);
    } catch (err: any) {
      res.status(err?.status || 500).json({ status: 'error', message: err?.message || 'A2A card failed' });
    }
  });

  app.post(
    '/a2a/:agentId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const handler = await getHandler(req.params.agentId);
        return jsonRpcHandler({
          requestHandler: handler,
          userBuilder: UserBuilder.noAuthentication,
          legacyCompat: { enabled: true },
        })(req, res, next);
      } catch (err: any) {
        res
          .status(err?.status || 500)
          .json({ status: 'error', message: err?.message || 'A2A JSON-RPC failed' });
      }
    }
  );

  console.log(
    `[a2a-sdk] mounted /a2a/:agentId/${cardPath} + POST /a2a/:agentId (protocol ${A2A_PROTOCOL_VERSION})`
  );
}
