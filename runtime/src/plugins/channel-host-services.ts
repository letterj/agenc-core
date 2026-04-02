import { dirname, join } from "node:path";
import type { GatewayConfig } from "../gateway/types.js";
import { createMemoryBackend } from "../gateway/memory-backend-factory.js";
import { AgentIdentityManager } from "../memory/agent-identity.js";
import { MemoryGraph } from "../memory/graph.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import {
  MemoryIngestionEngine,
  type TurnIngestionMetadata,
} from "../memory/ingestion.js";
import { ProceduralMemory } from "../memory/procedural.js";
import { SemanticMemoryRetriever } from "../memory/retriever.js";
import { SharedMemoryBackend } from "../memory/shared-memory.js";
import { SocialMemoryManager } from "../memory/social-memory.js";
import { CuratedMemoryManager, DailyLogManager } from "../memory/structured.js";
import { SqliteVectorBackend } from "../memory/sqlite/vector-backend.js";
import { MemoryTraceLogger } from "../memory/trace-logger.js";
import { resolveWorldVectorDbPath } from "../memory/world-db-resolver.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";

const DEFAULT_CONCORDIA_GM_MODEL = "grok-4-1-fast-non-reasoning";

interface ConcordiaProcedureRecord {
  readonly name: string;
  readonly trigger: string;
  readonly steps: readonly string[];
  readonly workspaceId?: string;
}

interface ConcordiaProcedureResult {
  readonly name: string;
  readonly trigger: string;
  readonly steps: readonly string[];
  readonly confidence: number;
}

interface ConcordiaMemoryEntryLike {
  readonly id: string;
  readonly role?: string;
}

interface ConcordiaRetrieverResult {
  readonly content?: string;
  readonly estimatedTokens: number;
  readonly entries: readonly {
    readonly entry: ConcordiaMemoryEntryLike;
    readonly role: string;
  }[];
}

export interface ConcordiaWorldMemoryHostServices {
  readonly memoryBackend: MemoryBackend;
  readonly identityManager: AgentIdentityManager;
  readonly socialMemory: SocialMemoryManager;
  readonly proceduralMemory: {
    record(input: ConcordiaProcedureRecord): Promise<unknown>;
    retrieve(
      triggerText: string,
      workspaceId?: string,
    ): Promise<readonly ConcordiaProcedureResult[]>;
    formatForPrompt(
      procedures: ReadonlyArray<ConcordiaProcedureResult>,
    ): string;
  };
  readonly graph: {
    findByEntity(
      name: string,
      workspaceId?: string,
    ): Promise<Array<{
      id: string;
      content: string;
      entityName?: string;
      entityType?: string;
    }>>;
    getRelatedEntities(
      nodeId: string,
      depth?: number,
    ): Promise<Array<{
      id: string;
      content: string;
      entityName?: string;
    }>>;
    updateEdge(edgeId: string, update: { validUntil?: number }): Promise<void>;
    addEdge(params: {
      sourceId: string;
      targetId: string;
      type: string;
      content?: string;
      validFrom?: number;
      validUntil?: number;
    }): Promise<unknown>;
  };
  readonly sharedMemory: {
    writeFact(params: {
      scope: string;
      content: string;
      author: string;
      userId?: string;
    }): Promise<unknown>;
    getFacts(
      scope: string,
      userId?: string,
    ): Promise<Array<{
      content: string;
      author: string;
    }>>;
  };
  readonly traceLogger: MemoryTraceLogger;
  readonly dailyLogManager?: {
    append(sessionId: string, entry: {
      timestamp: number;
      type: string;
      step?: number;
      actingAgent?: string;
      content: string;
    }): Promise<void>;
  };
  readonly ingestionEngine?: {
    ingestTurn(
      sessionId: string,
      userMessage: string,
      agentResponse: string,
      metadata?: TurnIngestionMetadata,
    ): Promise<void>;
  };
  readonly retriever?: {
    retrieve(message: string, sessionId: string): Promise<string | undefined>;
    retrieveDetailed(
      message: string,
      sessionId: string,
    ): Promise<ConcordiaRetrieverResult>;
  };
  readonly vectorDbPath?: string;
}

export interface ConcordiaMemoryHostServices {
  resolveWorldContext(input: {
    worldId: string;
    workspaceId: string;
  }): Promise<ConcordiaWorldMemoryHostServices>;
}

export interface ConcordiaRuntimeHostServices {
  readonly llm: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
  readonly defaults?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly model?: string;
    readonly baseUrl?: string;
  };
}

export type ChannelHostServices = Readonly<Record<string, unknown>> & {
  readonly concordia_memory?: ConcordiaMemoryHostServices;
  readonly concordia_runtime?: ConcordiaRuntimeHostServices;
};

export function createChannelHostServices(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
}): ChannelHostServices | undefined {
  const services: Record<string, unknown> = {};

  if (params.config.llm) {
    services.concordia_runtime = {
      llm: {
        provider: params.config.llm.provider,
        apiKey: params.config.llm.apiKey,
        model: params.config.llm.model,
        baseUrl: params.config.llm.baseUrl,
      },
      defaults: {
        provider: params.config.llm.provider,
        apiKey: params.config.llm.apiKey,
        model: params.config.llm.provider === "grok"
          ? DEFAULT_CONCORDIA_GM_MODEL
          : params.config.llm.model,
        baseUrl: params.config.llm.baseUrl,
      },
    } satisfies ConcordiaRuntimeHostServices;
  }

  services.concordia_memory = createConcordiaMemoryHostServices(params);

  return services as ChannelHostServices;
}

function createConcordiaMemoryHostServices(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
}): ConcordiaMemoryHostServices {
  const worldContexts = new Map<string, Promise<ConcordiaWorldMemoryHostServices>>();
  let sharedBackendPromise: Promise<MemoryBackend> | null = null;

  const getSharedBackend = async (): Promise<MemoryBackend> => {
    if (!sharedBackendPromise) {
      sharedBackendPromise = createMemoryBackend({
        config: params.config,
        logger: params.logger,
      });
    }
    return sharedBackendPromise;
  };

  return {
    async resolveWorldContext(input) {
      const cacheKey = `${input.workspaceId}::${input.worldId}`;
      const existing = worldContexts.get(cacheKey);
      if (existing) {
        return existing;
      }

      const created = createConcordiaWorldContext({
        ...params,
        worldId: input.worldId,
        workspaceId: input.workspaceId,
        getSharedBackend,
      }).catch((error) => {
        worldContexts.delete(cacheKey);
        throw error;
      });
      worldContexts.set(cacheKey, created);
      return created;
    },
  };
}

async function createConcordiaWorldContext(params: {
  readonly config: GatewayConfig;
  readonly logger: Logger;
  readonly worldId: string;
  readonly workspaceId: string;
  readonly getSharedBackend: () => Promise<MemoryBackend>;
}): Promise<ConcordiaWorldMemoryHostServices> {
  const worldBackend = await createMemoryBackend({
    config: params.config,
    logger: params.logger,
    worldId: params.worldId,
  });
  const sharedBackend = await params.getSharedBackend();

  const identityManager = new AgentIdentityManager({
    memoryBackend: worldBackend,
    logger: params.logger,
  });
  const socialMemory = new SocialMemoryManager({
    memoryBackend: worldBackend,
    logger: params.logger,
  });
  const graph = new MemoryGraph(worldBackend);
  const traceLogger = new MemoryTraceLogger(params.logger);
  const sharedMemory = new SharedMemoryBackend({
    memoryBackend: sharedBackend,
    logger: params.logger,
  });
  const runtimeProceduralMemory = new ProceduralMemory({
    memoryBackend: worldBackend,
    logger: params.logger,
  });

  const vectorDbPath = resolveWorldVectorDbPath(params.worldId);
  const worldDir = dirname(vectorDbPath);
  const curatedMemory = new CuratedMemoryManager(join(worldDir, "MEMORY.md"));
  const runtimeDailyLogManager = new DailyLogManager(join(worldDir, "logs"));

  const embeddingProvider = await createEmbeddingProvider({
    preferred: params.config.memory?.embeddingProvider,
    apiKey: params.config.memory?.embeddingApiKey ?? params.config.llm?.apiKey,
    baseUrl: params.config.memory?.embeddingBaseUrl,
    model: params.config.memory?.embeddingModel,
  });

  let ingestionEngine:
    | ConcordiaWorldMemoryHostServices["ingestionEngine"]
    | undefined;
  let retriever: ConcordiaWorldMemoryHostServices["retriever"] | undefined;

  if (embeddingProvider.name !== "noop") {
    const vectorStore = new SqliteVectorBackend({
      dbPath: vectorDbPath,
      dimension: embeddingProvider.dimension,
    });
    const semanticRetriever = new SemanticMemoryRetriever({
      vectorBackend: vectorStore,
      embeddingProvider,
      curatedMemory,
      workspaceId: params.workspaceId,
      logger: params.logger,
    });
    const engine = new MemoryIngestionEngine({
      embeddingProvider,
      vectorStore,
      logManager: runtimeDailyLogManager,
      curatedMemory,
      generateSummaries: false,
      enableDailyLogs: true,
      enableEntityExtraction: false,
      logger: params.logger,
    });

    ingestionEngine = {
      ingestTurn(sessionId, userMessage, agentResponse, metadata) {
        return engine.ingestTurn(
          sessionId,
          userMessage,
          agentResponse,
          metadata,
        );
      },
    };

    retriever = {
      retrieve(message, sessionId) {
        return semanticRetriever.retrieve(message, sessionId);
      },
      async retrieveDetailed(message, sessionId) {
        const result = await semanticRetriever.retrieveDetailed(message, sessionId);
        return {
          content: result.content,
          estimatedTokens: result.estimatedTokens,
          entries: result.entries.map((entry) => ({
            entry: {
              id: entry.entry.id,
              role: entry.entry.role,
            },
            role: entry.role,
          })),
        };
      },
    };
  }

  return {
    memoryBackend: worldBackend,
    identityManager,
    socialMemory,
    proceduralMemory: createProceduralMemoryAdapter(runtimeProceduralMemory),
    graph: createGraphAdapter(graph),
    sharedMemory: {
      writeFact(input) {
        return sharedMemory.writeFact({
          scope: toSharedScope(input.scope),
          content: input.content,
          author: input.author,
          userId: input.userId,
          sourceWorldId: params.worldId,
        });
      },
      async getFacts(scope, userId) {
        const facts = await sharedMemory.getFacts(toSharedScope(scope), userId);
        return facts.map((fact) => ({
          content: fact.content,
          author: fact.author,
        }));
      },
    },
    traceLogger,
    dailyLogManager: {
      append(sessionId, entry) {
        return runtimeDailyLogManager.append(
          sessionId,
          "assistant",
          formatSimulationDailyLogEntry(entry),
        );
      },
    },
    ingestionEngine,
    retriever,
    vectorDbPath,
  };
}

function createProceduralMemoryAdapter(
  runtimeProceduralMemory: ProceduralMemory,
): ConcordiaWorldMemoryHostServices["proceduralMemory"] {
  return {
    record(input) {
      return runtimeProceduralMemory.record({
        name: input.name,
        trigger: input.trigger,
        workspaceId: input.workspaceId,
        toolCalls: input.steps.map((step, index) => ({
          name: `simulation_step_${index + 1}`,
          args: { step },
          result: step,
        })),
      });
    },
    async retrieve(triggerText, workspaceId) {
      const entries = await runtimeProceduralMemory.retrieve(
        triggerText,
        workspaceId,
      );
      return entries.map((entry) => ({
        name: entry.name,
        trigger: entry.trigger,
        steps: entry.steps.map((step) => step.description),
        confidence: entry.confidence,
      }));
    },
    formatForPrompt(procedures) {
      return runtimeProceduralMemory.formatForPrompt(
        procedures.map((procedure) => ({
          id: procedure.name,
          name: procedure.name,
          trigger: procedure.trigger,
          steps: procedure.steps.map((step, index) => ({
            toolName: `simulation_step_${index + 1}`,
            argsPattern: JSON.stringify({ step }),
            description: step,
          })),
          successCount: 1,
          failureCount: 0,
          confidence: procedure.confidence,
          lastUsed: Date.now(),
          createdAt: Date.now(),
        })),
      );
    },
  };
}

function createGraphAdapter(
  graph: MemoryGraph,
): ConcordiaWorldMemoryHostServices["graph"] {
  return {
    async findByEntity(name, workspaceId) {
      const result = await graph.findByEntity(name, workspaceId);
      return result.nodes.map((node) => ({
        id: node.id,
        content: node.content,
        entityName: node.entityName,
        entityType: node.entityType,
      }));
    },
    async getRelatedEntities(nodeId, depth) {
      const related = await graph.getRelatedEntities(nodeId, depth);
      return related.map((node) => ({
        id: node.id,
        content: node.content,
        entityName: node.entityName,
      }));
    },
    async updateEdge(edgeId, update) {
      await graph.updateEdge(edgeId, update);
    },
    addEdge(params) {
      return graph.addEdge({
        fromId: params.sourceId,
        toId: params.targetId,
        type: params.type as Parameters<MemoryGraph["addEdge"]>[0]["type"],
        metadata: params.content ? { content: params.content } : undefined,
        validFrom: params.validFrom,
        validUntil: params.validUntil,
      });
    },
  };
}

function formatSimulationDailyLogEntry(entry: {
  timestamp: number;
  type: string;
  step?: number;
  actingAgent?: string;
  content: string;
}): string {
  const parts = [`[simulation:${entry.type}]`];
  if (typeof entry.step === "number") {
    parts.push(`step=${entry.step}`);
  }
  if (entry.actingAgent) {
    parts.push(`agent=${entry.actingAgent}`);
  }
  return `${parts.join(" ")} ${entry.content}`.trim();
}

function toSharedScope(scope: string): "user" | "organization" | "capability" {
  if (scope === "organization" || scope === "capability" || scope === "user") {
    return scope;
  }
  return "user";
}
