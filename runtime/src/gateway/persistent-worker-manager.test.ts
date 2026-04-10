import { describe, expect, it, vi } from "vitest";
import type { MemoryBackend } from "../memory/types.js";
import { TaskStore } from "../tools/system/task-tracker.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type {
  IsolatedSessionContext,
  SubAgentSessionIdentity,
} from "./session-isolation.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import { SubAgentManager, type SubAgentManagerConfig } from "./sub-agent.js";
import {
  PersistentWorkerManager,
  WORKER_ASSIGNMENT_METADATA_KEY,
  buildWorkerAssignmentMetadata,
  type PreparedPersistentWorkerAssignment,
} from "./persistent-worker-manager.js";

function createMemoryBackendStub(): MemoryBackend {
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: async () => {
      throw new Error("not implemented");
    },
    getThread: async () => [],
    query: async () => [],
    deleteThread: async () => 0,
    listSessions: async () => [],
    set: async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    get: async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    },
    delete: async (key: string) => kv.delete(key),
    has: async (key: string) => kv.has(key),
    listKeys: async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    getDurability: () => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    }),
    flush: async () => {},
    clear: async () => {
      kv.clear();
    },
    close: async () => {},
    healthCheck: async () => true,
  };
}

function makeMockLLMProvider(
  outputs: readonly string[] = ["worker output"],
): LLMProvider {
  const queue = [...outputs];
  const nextResponse = async (
    _messages: LLMMessage[],
  ): Promise<LLMResponse> => ({
    content: queue.shift() ?? "worker output",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock",
    finishReason: "stop",
  });

  return {
    name: "mock-llm",
    chat: vi.fn(nextResponse),
    chatStream: vi.fn(
      async (
        messages: LLMMessage[],
        _cb: StreamProgressCallback,
      ): Promise<LLMResponse> => nextResponse(messages),
    ),
    healthCheck: vi.fn(async () => true),
  };
}

function makeMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(
      async (): Promise<ToolResult> => ({ content: "ok", isError: false }),
    ),
  };
}

function makeMockContext(workspaceId = "default"): IsolatedSessionContext {
  const toolRegistry = new ToolRegistry({});
  toolRegistry.register(makeMockTool("system.readFile"));
  toolRegistry.register(makeMockTool("system.writeFile"));

  return {
    workspaceId,
    memoryBackend: createMemoryBackendStub() as any,
    policyEngine: {} as any,
    toolRegistry,
    llmProvider: makeMockLLMProvider(),
    skills: [],
    authState: { authenticated: false, permissions: new Set() },
  };
}

function makeManagerConfig(
  overrides?: Partial<SubAgentManagerConfig>,
): SubAgentManagerConfig {
  return {
    createContext: vi.fn(async () => makeMockContext()),
    destroyContext: vi.fn(async () => {}),
    ...overrides,
  };
}

async function waitForTaskTerminal(
  store: TaskStore,
  listId: string,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await store.getTask(listId, taskId);
    if (
      task?.status === "completed" ||
      task?.status === "failed" ||
      task?.status === "cancelled"
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId} to finish`);
}

function buildPreparedAssignment(
  task = "Implement the next bounded step",
): PreparedPersistentWorkerAssignment {
  return {
    request: {
      task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
    },
    objective: task,
    admittedInput: {
      task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
      delegationAdmission: {
        isolationReason: "bounded phase ownership",
        ownedArtifacts: ["src/parser.ts"],
      },
    },
    allowedTools: ["system.readFile"],
    workingDirectory: "/tmp/project",
    executionContextFingerprint:
      '{"allowedReadRoots":["/tmp/project"],"allowedTools":["system.readFile"],"allowedWriteRoots":["/tmp/project"]}',
    executionEnvelopeFingerprint: "env-fingerprint-1",
  };
}

describe("PersistentWorkerManager", () => {
  it("creates named workers and runs queued worker_assignment tasks", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "builder",
    });
    const queued = await workerManager.assignToWorker({
      parentSessionId: "session-a",
      workerId: worker.workerId,
      assignment: buildPreparedAssignment(),
    });

    await waitForTaskTerminal(taskStore, "session-a", queued.task.id);

    const task = await taskStore.getTask("session-a", queued.task.id);
    const workers = await workerManager.listWorkers("session-a");
    expect(task).toMatchObject({
      id: queued.task.id,
      kind: "worker_assignment",
      status: "completed",
    });
    expect(workers).toEqual([
      expect.objectContaining({
        workerId: worker.workerId,
        workerName: "builder",
        state: "idle",
        lastTaskId: queued.task.id,
      }),
    ]);
    expect(workers[0]?.continuationSessionId).toMatch(/^subagent:/);
  });

  it("stops idle workers and releases queued targeted assignments", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });
    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "reviewer",
    });
    const assignment = buildPreparedAssignment("Review the current diff");
    const queuedTask = await taskStore.createRuntimeTask({
      listId: "session-a",
      kind: "worker_assignment",
      subject: assignment.objective,
      description: assignment.objective,
      status: "pending",
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
      },
    });

    const stopped = await workerManager.stopWorker({
      parentSessionId: "session-a",
      workerIdOrSessionId: worker.workerId,
    });
    const releasedTask = await taskStore.getTask("session-a", queuedTask.id);

    expect(stopped).toMatchObject({
      workerId: worker.workerId,
      state: "cancelled",
    });
    expect(releasedTask?.status).toBe("pending");
    expect(releasedTask?.owner).toBeUndefined();
    expect(
      (releasedTask?.metadata?.[WORKER_ASSIGNMENT_METADATA_KEY] as Record<string, unknown>)
        ?.targetWorkerId,
    ).toBeUndefined();
  });

  it("fails nonterminal workers and requeues claimed assignments during repair", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });
    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "executor",
    });
    const assignment = buildPreparedAssignment("Handle a recovered task");
    const queuedTask = await taskStore.createRuntimeTask({
      listId: "session-a",
      kind: "worker_assignment",
      subject: assignment.objective,
      description: assignment.objective,
      status: "in_progress",
      owner: worker.workerId,
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
      },
    });

    await workerManager.repairRuntimeState();

    const repairedTask = await taskStore.getTask("session-a", queuedTask.id);
    const workers = await workerManager.listWorkers("session-a");
    expect(repairedTask).toMatchObject({
      id: queuedTask.id,
      status: "pending",
    });
    expect(repairedTask?.owner).toBeUndefined();
    expect(workers).toEqual([
      expect.objectContaining({
        workerId: worker.workerId,
        state: "failed",
      }),
    ]);
  });
});
