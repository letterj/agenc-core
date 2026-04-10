import type { MemoryBackend } from "../memory/types.js";
import type {
  RuntimeWorkerHandle,
  RuntimeWorkerLayerSnapshot,
  RuntimeVerifierVerdict,
} from "../runtime-contract/types.js";
import type { Task, TaskStore } from "../tools/system/task-tracker.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import type { ApprovalEngine } from "./approvals.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import {
  mapPlannerVerifierSnapshotToRuntimeVerdict,
  resolveDelegatedTerminalOutcome,
} from "./delegated-runtime-result.js";
import type { SubAgentManager } from "./sub-agent.js";
import { buildDelegatedChildPrompt } from "./tool-handler-factory-delegation.js";
import type { VerifierRequirement } from "./verifier-probes.js";
import { specRequiresSuccessfulToolEvidence } from "../utils/delegation-validation.js";

const PERSISTENT_WORKER_KEY_PREFIX = "persistent-worker:session:";
const PERSISTENT_WORKER_SCHEMA_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 75;

export const WORKER_ASSIGNMENT_METADATA_KEY = "workerAssignment";

export type PersistentWorkerState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_for_permission"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface PreparedPersistentWorkerAssignment {
  readonly request: ExecuteWithAgentInput;
  readonly objective: string;
  readonly admittedInput: ExecuteWithAgentInput;
  readonly allowedTools: readonly string[];
  readonly workingDirectory?: string;
  readonly executionContextFingerprint?: string;
  readonly executionEnvelopeFingerprint: string;
  readonly verifierRequirement?: VerifierRequirement;
  readonly ownedArtifacts?: readonly string[];
  readonly unsafeBenchmarkMode?: boolean;
}

export interface WorkerAssignmentMetadata {
  readonly targetWorkerId?: string;
  readonly targetWorkerName?: string;
  readonly assignment: PreparedPersistentWorkerAssignment;
}

interface PersistentWorkerRecord {
  readonly version: number;
  readonly workerId: string;
  readonly workerName: string;
  readonly parentSessionId: string;
  state: PersistentWorkerState;
  stopRequested: boolean;
  currentTaskId?: string;
  lastTaskId?: string;
  continuationSessionId?: string;
  activeSubagentSessionId?: string;
  workingDirectory?: string;
  allowedTools?: readonly string[];
  executionContextFingerprint?: string;
  executionEnvelopeFingerprint?: string;
  verifierRequirement?: VerifierRequirement;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

interface PersistentWorkerRegistry {
  readonly version: number;
  readonly parentSessionId: string;
  nextWorkerNumber: number;
  workers: PersistentWorkerRecord[];
}

interface PersistentWorkerManagerOptions {
  readonly memoryBackend: MemoryBackend;
  readonly taskStore: TaskStore;
  readonly subAgentManager: SubAgentManager;
  readonly approvalEngine?: ApprovalEngine | null;
  readonly logger?: Logger;
  readonly now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function asPlainObject(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneVerifierRequirement(
  requirement: VerifierRequirement | undefined,
): VerifierRequirement | undefined {
  if (!requirement) return undefined;
  return {
    required: requirement.required,
    profiles: [...requirement.profiles],
    probeCategories: [...requirement.probeCategories],
    mutationPolicy: requirement.mutationPolicy,
    allowTempArtifacts: requirement.allowTempArtifacts,
    bootstrapSource: requirement.bootstrapSource,
    rationale: [...requirement.rationale],
  };
}

function clonePreparedAssignment(
  assignment: PreparedPersistentWorkerAssignment,
): PreparedPersistentWorkerAssignment {
  return {
    request: cloneJson(assignment.request),
    objective: assignment.objective,
    admittedInput: cloneJson(assignment.admittedInput),
    allowedTools: [...assignment.allowedTools],
    ...(assignment.workingDirectory
      ? { workingDirectory: assignment.workingDirectory }
      : {}),
    ...(assignment.executionContextFingerprint
      ? { executionContextFingerprint: assignment.executionContextFingerprint }
      : {}),
    executionEnvelopeFingerprint: assignment.executionEnvelopeFingerprint,
    ...(assignment.verifierRequirement
      ? { verifierRequirement: cloneVerifierRequirement(assignment.verifierRequirement) }
      : {}),
    ...(assignment.ownedArtifacts
      ? { ownedArtifacts: [...assignment.ownedArtifacts] }
      : {}),
    ...(assignment.unsafeBenchmarkMode === true
      ? { unsafeBenchmarkMode: true }
      : {}),
  };
}

function cloneWorkerRecord(record: PersistentWorkerRecord): PersistentWorkerRecord {
  return {
    version: record.version,
    workerId: record.workerId,
    workerName: record.workerName,
    parentSessionId: record.parentSessionId,
    state: record.state,
    stopRequested: record.stopRequested,
    ...(record.currentTaskId ? { currentTaskId: record.currentTaskId } : {}),
    ...(record.lastTaskId ? { lastTaskId: record.lastTaskId } : {}),
    ...(record.continuationSessionId
      ? { continuationSessionId: record.continuationSessionId }
      : {}),
    ...(record.activeSubagentSessionId
      ? { activeSubagentSessionId: record.activeSubagentSessionId }
      : {}),
    ...(record.workingDirectory ? { workingDirectory: record.workingDirectory } : {}),
    ...(record.allowedTools ? { allowedTools: [...record.allowedTools] } : {}),
    ...(record.executionContextFingerprint
      ? { executionContextFingerprint: record.executionContextFingerprint }
      : {}),
    ...(record.executionEnvelopeFingerprint
      ? { executionEnvelopeFingerprint: record.executionEnvelopeFingerprint }
      : {}),
    ...(record.verifierRequirement
      ? { verifierRequirement: cloneVerifierRequirement(record.verifierRequirement) }
      : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function cloneRegistry(registry: PersistentWorkerRegistry): PersistentWorkerRegistry {
  return {
    version: registry.version,
    parentSessionId: registry.parentSessionId,
    nextWorkerNumber: registry.nextWorkerNumber,
    workers: registry.workers.map(cloneWorkerRecord),
  };
}

function createEmptyRegistry(parentSessionId: string): PersistentWorkerRegistry {
  return {
    version: PERSISTENT_WORKER_SCHEMA_VERSION,
    parentSessionId,
    nextWorkerNumber: 1,
    workers: [],
  };
}

function coerceVerifierRequirement(value: unknown): VerifierRequirement | undefined {
  const raw = asPlainObject(value);
  if (!raw || typeof raw.required !== "boolean") {
    return undefined;
  }
  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.filter((entry): entry is string => typeof entry === "string")
    : [];
  const probeCategories = Array.isArray(raw.probeCategories)
    ? raw.probeCategories.filter((entry): entry is string => typeof entry === "string")
    : [];
  const mutationPolicy =
    raw.mutationPolicy === "read_only_workspace"
      ? "read_only_workspace"
      : undefined;
  const bootstrapSource =
    raw.bootstrapSource === "disabled" ||
    raw.bootstrapSource === "derived" ||
    raw.bootstrapSource === "fallback"
      ? raw.bootstrapSource
      : undefined;
  if (!mutationPolicy || !bootstrapSource) {
    return undefined;
  }
  return {
    required: raw.required,
    profiles: profiles as VerifierRequirement["profiles"],
    probeCategories: probeCategories as VerifierRequirement["probeCategories"],
    mutationPolicy,
    allowTempArtifacts: raw.allowTempArtifacts === true,
    bootstrapSource,
    rationale: Array.isArray(raw.rationale)
      ? raw.rationale.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function coercePreparedAssignment(
  value: unknown,
): PreparedPersistentWorkerAssignment | undefined {
  const raw = asPlainObject(value);
  if (!raw) return undefined;
  const request = asPlainObject(raw.request);
  const admittedInput = asPlainObject(raw.admittedInput);
  const objective = asNonEmptyString(raw.objective);
  const executionEnvelopeFingerprint = asNonEmptyString(
    raw.executionEnvelopeFingerprint,
  );
  if (!request || !admittedInput || !objective || !executionEnvelopeFingerprint) {
    return undefined;
  }
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    request: cloneJson(request) as unknown as ExecuteWithAgentInput,
    objective,
    admittedInput: cloneJson(admittedInput) as unknown as ExecuteWithAgentInput,
    allowedTools,
    ...(asNonEmptyString(raw.workingDirectory)
      ? { workingDirectory: asNonEmptyString(raw.workingDirectory) }
      : {}),
    ...(asNonEmptyString(raw.executionContextFingerprint)
      ? {
          executionContextFingerprint: asNonEmptyString(
            raw.executionContextFingerprint,
          ),
        }
      : {}),
    executionEnvelopeFingerprint,
    ...(coerceVerifierRequirement(raw.verifierRequirement)
      ? { verifierRequirement: coerceVerifierRequirement(raw.verifierRequirement) }
      : {}),
    ...(Array.isArray(raw.ownedArtifacts)
      ? {
          ownedArtifacts: raw.ownedArtifacts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(raw.unsafeBenchmarkMode === true ? { unsafeBenchmarkMode: true } : {}),
  };
}

function coerceAssignmentMetadata(value: unknown): WorkerAssignmentMetadata | undefined {
  const raw = asPlainObject(value);
  const assignment = coercePreparedAssignment(raw?.assignment);
  if (!raw || !assignment) return undefined;
  return {
    ...(asNonEmptyString(raw.targetWorkerId)
      ? { targetWorkerId: asNonEmptyString(raw.targetWorkerId) }
      : {}),
    ...(asNonEmptyString(raw.targetWorkerName)
      ? { targetWorkerName: asNonEmptyString(raw.targetWorkerName) }
      : {}),
    assignment,
  };
}

function coerceWorkerRecord(value: unknown, parentSessionId: string): PersistentWorkerRecord | undefined {
  const raw = asPlainObject(value);
  const workerId = asNonEmptyString(raw?.workerId);
  const workerName = asNonEmptyString(raw?.workerName);
  const state = raw?.state;
  if (
    !raw ||
    !workerId ||
    !workerName ||
    (state !== "starting" &&
      state !== "running" &&
      state !== "idle" &&
      state !== "waiting_for_permission" &&
      state !== "verifying" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "cancelled")
  ) {
    return undefined;
  }
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt;
  return {
    version:
      typeof raw.version === "number" && Number.isInteger(raw.version)
        ? raw.version
        : PERSISTENT_WORKER_SCHEMA_VERSION,
    workerId,
    workerName,
    parentSessionId:
      asNonEmptyString(raw.parentSessionId) ?? parentSessionId,
    state,
    stopRequested: raw.stopRequested === true,
    ...(asNonEmptyString(raw.currentTaskId)
      ? { currentTaskId: asNonEmptyString(raw.currentTaskId) }
      : {}),
    ...(asNonEmptyString(raw.lastTaskId)
      ? { lastTaskId: asNonEmptyString(raw.lastTaskId) }
      : {}),
    ...(asNonEmptyString(raw.continuationSessionId)
      ? { continuationSessionId: asNonEmptyString(raw.continuationSessionId) }
      : {}),
    ...(asNonEmptyString(raw.activeSubagentSessionId)
      ? { activeSubagentSessionId: asNonEmptyString(raw.activeSubagentSessionId) }
      : {}),
    ...(asNonEmptyString(raw.workingDirectory)
      ? { workingDirectory: asNonEmptyString(raw.workingDirectory) }
      : {}),
    ...(Array.isArray(raw.allowedTools)
      ? {
          allowedTools: raw.allowedTools.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.executionContextFingerprint)
      ? {
          executionContextFingerprint: asNonEmptyString(
            raw.executionContextFingerprint,
          ),
        }
      : {}),
    ...(asNonEmptyString(raw.executionEnvelopeFingerprint)
      ? {
          executionEnvelopeFingerprint: asNonEmptyString(
            raw.executionEnvelopeFingerprint,
          ),
        }
      : {}),
    ...(coerceVerifierRequirement(raw.verifierRequirement)
      ? { verifierRequirement: coerceVerifierRequirement(raw.verifierRequirement) }
      : {}),
    ...(asNonEmptyString(raw.summary)
      ? { summary: asNonEmptyString(raw.summary) }
      : {}),
    createdAt,
    updatedAt,
  };
}

function coerceRegistry(
  value: unknown,
  parentSessionId: string,
): PersistentWorkerRegistry {
  const raw = asPlainObject(value);
  if (!raw) {
    return createEmptyRegistry(parentSessionId);
  }
  return {
    version: PERSISTENT_WORKER_SCHEMA_VERSION,
    parentSessionId:
      asNonEmptyString(raw.parentSessionId) ?? parentSessionId,
    nextWorkerNumber:
      typeof raw.nextWorkerNumber === "number" &&
        Number.isInteger(raw.nextWorkerNumber) &&
        raw.nextWorkerNumber > 0
        ? raw.nextWorkerNumber
        : 1,
    workers: Array.isArray(raw.workers)
      ? raw.workers
          .map((entry) => coerceWorkerRecord(entry, parentSessionId))
          .filter((entry): entry is PersistentWorkerRecord => entry !== undefined)
      : [],
  };
}

function isTerminalWorkerState(state: PersistentWorkerState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function normalizeVerifierRequirement(
  requirement: VerifierRequirement | undefined,
): string | undefined {
  if (!requirement) return undefined;
  return stableSerialize({
    required: requirement.required,
    profiles: normalizeStringList(requirement.profiles),
    probeCategories: normalizeStringList(requirement.probeCategories),
    mutationPolicy: requirement.mutationPolicy,
    allowTempArtifacts: requirement.allowTempArtifacts,
    bootstrapSource: requirement.bootstrapSource,
  });
}

function buildRuntimeWorkerHandle(params: {
  readonly worker: PersistentWorkerRecord;
  readonly pendingTaskCount: number;
}): RuntimeWorkerHandle {
  const continuationSessionId =
    params.worker.activeSubagentSessionId ?? params.worker.continuationSessionId;
  return {
    id: params.worker.workerId,
    kind: "persistent_worker",
    status: params.worker.state,
    workerId: params.worker.workerId,
    workerName: params.worker.workerName,
    state: params.worker.state,
    ...(params.worker.currentTaskId ? { taskId: params.worker.currentTaskId } : {}),
    ...(params.worker.currentTaskId
      ? { currentTaskId: params.worker.currentTaskId }
      : {}),
    ...(params.worker.lastTaskId ? { lastTaskId: params.worker.lastTaskId } : {}),
    pendingTaskCount: params.pendingTaskCount,
    ...(continuationSessionId ? { continuationSessionId } : {}),
    ...(params.worker.workingDirectory
      ? { workingDirectory: params.worker.workingDirectory }
      : {}),
    ...(params.worker.verifierRequirement
      ? { verifierRequirement: params.worker.verifierRequirement }
      : {}),
    stopRequested: params.worker.stopRequested,
    ...(params.worker.summary ? { summary: params.worker.summary } : {}),
  };
}

function workerSortPriority(state: PersistentWorkerState): number {
  switch (state) {
    case "idle":
      return 0;
    case "running":
      return 1;
    case "waiting_for_permission":
      return 2;
    case "verifying":
      return 3;
    case "starting":
      return 4;
    case "completed":
      return 5;
    case "failed":
      return 6;
    case "cancelled":
      return 7;
  }
}

export function buildWorkerAssignmentMetadata(params: {
  readonly assignment: PreparedPersistentWorkerAssignment;
  readonly targetWorkerId?: string;
  readonly targetWorkerName?: string;
}): WorkerAssignmentMetadata {
  return {
    ...(params.targetWorkerId ? { targetWorkerId: params.targetWorkerId } : {}),
    ...(params.targetWorkerName ? { targetWorkerName: params.targetWorkerName } : {}),
    assignment: clonePreparedAssignment(params.assignment),
  };
}

export function extractWorkerAssignmentMetadata(
  task: Pick<Task, "metadata">,
): WorkerAssignmentMetadata | undefined {
  return coerceAssignmentMetadata(task.metadata?.[WORKER_ASSIGNMENT_METADATA_KEY]);
}

export class PersistentWorkerManager {
  private readonly memoryBackend: MemoryBackend;
  private readonly taskStore: TaskStore;
  private subAgentManager: SubAgentManager;
  private readonly approvalEngine?: ApprovalEngine | null;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly queue: KeyedAsyncQueue;

  constructor(options: PersistentWorkerManagerOptions) {
    this.memoryBackend = options.memoryBackend;
    this.taskStore = options.taskStore;
    this.subAgentManager = options.subAgentManager;
    this.approvalEngine = options.approvalEngine;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.queue = new KeyedAsyncQueue({
      logger: this.logger,
      label: "persistent worker manager",
    });
  }

  updateRuntime(params: {
    readonly subAgentManager: SubAgentManager;
  }): void {
    this.subAgentManager = params.subAgentManager;
  }

  private registryKey(parentSessionId: string): string {
    return `${PERSISTENT_WORKER_KEY_PREFIX}${parentSessionId}`;
  }

  private async loadRegistry(parentSessionId: string): Promise<PersistentWorkerRegistry> {
    return coerceRegistry(
      await this.memoryBackend.get(this.registryKey(parentSessionId)),
      parentSessionId,
    );
  }

  private async saveRegistry(registry: PersistentWorkerRegistry): Promise<void> {
    await this.memoryBackend.set(
      this.registryKey(registry.parentSessionId),
      cloneRegistry(registry),
    );
  }

  private async mutateRegistry<T>(
    parentSessionId: string,
    mutate: (registry: PersistentWorkerRegistry) => Promise<T> | T,
  ): Promise<T> {
    return this.queue.run(this.registryKey(parentSessionId), async () => {
      const registry = await this.loadRegistry(parentSessionId);
      const result = await mutate(registry);
      await this.saveRegistry(registry);
      return result;
    });
  }

  private workerLoopKey(parentSessionId: string, workerId: string): string {
    return `${parentSessionId}:${workerId}`;
  }

  private async getWorkerRecord(
    parentSessionId: string,
    workerId: string,
  ): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(parentSessionId);
    return registry.workers.find((entry) => entry.workerId === workerId);
  }

  private async countPendingAssignments(
    parentSessionId: string,
    workerId: string,
  ): Promise<number> {
    const tasks = await this.taskStore.listTasks(parentSessionId, { status: "pending" });
    return tasks.filter((task) => {
      if (task.kind !== "worker_assignment") return false;
      const metadata = extractWorkerAssignmentMetadata(task);
      return metadata?.targetWorkerId === workerId;
    }).length;
  }

  private async listWorkerRecords(
    parentSessionId: string,
  ): Promise<readonly PersistentWorkerRecord[]> {
    const registry = await this.loadRegistry(parentSessionId);
    return registry.workers.map(cloneWorkerRecord);
  }

  async listWorkers(
    parentSessionId: string,
  ): Promise<readonly RuntimeWorkerHandle[]> {
    const workers = await this.listWorkerRecords(parentSessionId);
    const pendingCounts = await Promise.all(
      workers.map((worker) => this.countPendingAssignments(parentSessionId, worker.workerId)),
    );
    return workers
      .map((worker, index) =>
        buildRuntimeWorkerHandle({
          worker,
          pendingTaskCount: pendingCounts[index] ?? 0,
        }))
      .sort((left, right) => {
        const statePriority =
          workerSortPriority(left.state) - workerSortPriority(right.state);
        if (statePriority !== 0) return statePriority;
        return left.workerName.localeCompare(right.workerName);
      });
  }

  private isWorkerCompatible(
    worker: PersistentWorkerRecord,
    assignment: PreparedPersistentWorkerAssignment,
  ): boolean {
    if (worker.stopRequested || isTerminalWorkerState(worker.state)) {
      return false;
    }
    if ((worker.workingDirectory ?? undefined) !== assignment.workingDirectory) {
      return false;
    }
    if (
      (worker.executionContextFingerprint ?? undefined) !==
      assignment.executionContextFingerprint
    ) {
      return false;
    }
    const workerVerifier = normalizeVerifierRequirement(worker.verifierRequirement);
    const assignmentVerifier = normalizeVerifierRequirement(
      assignment.verifierRequirement,
    );
    if (workerVerifier !== assignmentVerifier) {
      return false;
    }
    if (
      worker.allowedTools &&
      assignment.allowedTools.some((toolName) => !worker.allowedTools?.includes(toolName))
    ) {
      return false;
    }
    return true;
  }

  private findReusableWorker(
    workers: readonly PersistentWorkerRecord[],
    assignment?: PreparedPersistentWorkerAssignment,
  ): PersistentWorkerRecord | undefined {
    return [...workers]
      .filter((worker) =>
        assignment ? this.isWorkerCompatible(worker, assignment) : !isTerminalWorkerState(worker.state) &&
          !worker.stopRequested
      )
      .sort((left, right) => {
        const statePriority =
          workerSortPriority(left.state) - workerSortPriority(right.state);
        if (statePriority !== 0) return statePriority;
        return right.updatedAt - left.updatedAt;
      })[0];
  }

  async getLatestReusableWorkerId(
    parentSessionId: string,
    assignment?: PreparedPersistentWorkerAssignment,
  ): Promise<string | undefined> {
    const registry = await this.loadRegistry(parentSessionId);
    return this.findReusableWorker(registry.workers, assignment)?.workerId;
  }

  async resolveWorkerByAlias(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId: string;
  }): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(params.parentSessionId);
    return registry.workers.find((worker) =>
      worker.workerId === params.workerIdOrSessionId ||
      worker.continuationSessionId === params.workerIdOrSessionId ||
      worker.activeSubagentSessionId === params.workerIdOrSessionId
    );
  }

  async createWorker(params: {
    readonly parentSessionId: string;
    readonly workerName?: string;
  }): Promise<RuntimeWorkerHandle> {
    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const workerNumber = registry.nextWorkerNumber++;
        const workerId = `worker-${workerNumber}`;
        const workerName = asNonEmptyString(params.workerName) ?? workerId;
        if (registry.workers.some((entry) => entry.workerName === workerName)) {
          throw new Error(`Worker name "${workerName}" is already in use`);
        }
        const now = this.now();
        const record: PersistentWorkerRecord = {
          version: PERSISTENT_WORKER_SCHEMA_VERSION,
          workerId,
          workerName,
          parentSessionId: params.parentSessionId,
          state: "idle",
          stopRequested: false,
          createdAt: now,
          updatedAt: now,
          summary: "Worker ready for assignments.",
        };
        registry.workers.push(record);
        return cloneWorkerRecord(record);
      },
    );
    return buildRuntimeWorkerHandle({
      worker,
      pendingTaskCount: 0,
    });
  }

  async assignToWorker(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
  }): Promise<{ readonly worker: RuntimeWorkerHandle; readonly task: Task }> {
    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const record = registry.workers.find((entry) => entry.workerId === params.workerId);
        if (!record) {
          throw new Error(`Worker "${params.workerId}" was not found`);
        }
        if (record.stopRequested || isTerminalWorkerState(record.state)) {
          throw new Error(`Worker "${params.workerId}" is not available`);
        }
        if (record.workingDirectory === undefined) {
          record.workingDirectory = params.assignment.workingDirectory;
          record.allowedTools = [...params.assignment.allowedTools];
          record.executionContextFingerprint =
            params.assignment.executionContextFingerprint;
          record.executionEnvelopeFingerprint =
            params.assignment.executionEnvelopeFingerprint;
          record.verifierRequirement = cloneVerifierRequirement(
            params.assignment.verifierRequirement,
          );
        } else if (!this.isWorkerCompatible(record, params.assignment)) {
          throw new Error(
            `Worker "${params.workerId}" cannot widen its delegated scope or verifier contract`,
          );
        }
        record.updatedAt = this.now();
        return cloneWorkerRecord(record);
      },
    );

    const task = await this.taskStore.createRuntimeTask({
      listId: params.parentSessionId,
      kind: "worker_assignment",
      subject: params.assignment.objective,
      description:
        params.assignment.request.objective &&
          params.assignment.request.objective !== params.assignment.request.task
          ? params.assignment.request.task
          : params.assignment.objective,
      activeForm: "Running worker assignment",
      status: "pending",
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment: params.assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
        ...(params.assignment.verifierRequirement
          ? {
              _runtime: {
                verification: params.assignment.verifierRequirement.required,
                verifierProfiles: params.assignment.verifierRequirement.profiles,
                verifierProbeCategories:
                  params.assignment.verifierRequirement.probeCategories,
              },
            }
          : {}),
      },
      summary: `Queued for ${worker.workerName}.`,
      ownedArtifacts: params.assignment.ownedArtifacts,
      workingDirectory: params.assignment.workingDirectory,
      isolation:
        params.assignment.admittedInput.delegationAdmission?.isolationReason,
    });

    void this.scheduleWorker(params.parentSessionId, worker.workerId);

    return {
      worker: buildRuntimeWorkerHandle({
        worker,
        pendingTaskCount: await this.countPendingAssignments(
          params.parentSessionId,
          worker.workerId,
        ) + 1,
      }),
      task,
    };
  }

  async pickWorkerForAssignment(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId?: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
  }): Promise<PersistentWorkerRecord | undefined> {
    const registry = await this.loadRegistry(params.parentSessionId);
    if (params.workerIdOrSessionId) {
      return registry.workers.find((worker) =>
        (worker.workerId === params.workerIdOrSessionId ||
          worker.continuationSessionId === params.workerIdOrSessionId ||
          worker.activeSubagentSessionId === params.workerIdOrSessionId) &&
        this.isWorkerCompatible(worker, params.assignment)
      );
    }
    return this.findReusableWorker(registry.workers, params.assignment);
  }

  async stopWorker(params: {
    readonly parentSessionId: string;
    readonly workerIdOrSessionId: string;
  }): Promise<RuntimeWorkerHandle | undefined> {
    const resolved = await this.resolveWorkerByAlias({
      parentSessionId: params.parentSessionId,
      workerIdOrSessionId: params.workerIdOrSessionId,
    });
    if (!resolved) {
      return undefined;
    }

    const worker = await this.mutateRegistry(
      params.parentSessionId,
      async (registry) => {
        const record = registry.workers.find((entry) => entry.workerId === resolved.workerId);
        if (!record) {
          return undefined;
        }
        record.stopRequested = true;
        record.summary = "Worker shutdown requested.";
        record.updatedAt = this.now();
        if (!record.currentTaskId) {
          record.state = "cancelled";
        }
        return cloneWorkerRecord(record);
      },
    );
    if (!worker) {
      return undefined;
    }

    const tasks = await this.taskStore.listTasks(params.parentSessionId);
    await Promise.all(
      tasks
        .filter((task) => task.kind === "worker_assignment")
        .map(async (task) => {
          const metadata = extractWorkerAssignmentMetadata(task);
          if (metadata?.targetWorkerId !== worker.workerId) {
            return;
          }
          if (task.id === worker.currentTaskId) {
            return;
          }
          await this.taskStore.updateTask(params.parentSessionId, task.id, {
            status: "pending",
            owner: null,
            metadata: {
              [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
                assignment: metadata.assignment,
              }),
            },
          });
        }),
    );

    if (worker.activeSubagentSessionId) {
      this.subAgentManager.cancel(worker.activeSubagentSessionId);
    }

    return buildRuntimeWorkerHandle({
      worker,
      pendingTaskCount: await this.countPendingAssignments(
        params.parentSessionId,
        worker.workerId,
      ),
    });
  }

  private async updateWorker(
    parentSessionId: string,
    workerId: string,
    mutate: (worker: PersistentWorkerRecord) => void,
  ): Promise<PersistentWorkerRecord | undefined> {
    return this.mutateRegistry(parentSessionId, async (registry) => {
      const record = registry.workers.find((entry) => entry.workerId === workerId);
      if (!record) return undefined;
      mutate(record);
      record.updatedAt = this.now();
      return cloneWorkerRecord(record);
    });
  }

  private hasPendingApproval(
    parentSessionId: string,
    childSessionId: string,
  ): boolean {
    return this.approvalEngine?.getPending().some((request) =>
      request.parentSessionId === parentSessionId &&
      request.subagentSessionId === childSessionId
    ) ?? false;
  }

  private async claimNextAssignment(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
  }): Promise<
    | {
        readonly task: Task;
        readonly metadata: WorkerAssignmentMetadata;
      }
    | undefined
  > {
    const pendingTasks = await this.taskStore.listTasks(params.parentSessionId, {
      status: "pending",
    });
    for (const task of pendingTasks) {
      if (task.kind !== "worker_assignment" || task.blockedBy.length > 0) {
        continue;
      }
      const metadata = extractWorkerAssignmentMetadata(task);
      if (!metadata) continue;
      if (
        metadata.targetWorkerId !== undefined &&
        metadata.targetWorkerId !== params.workerId
      ) {
        continue;
      }
      const claimed = await this.taskStore.claimTask({
        listId: params.parentSessionId,
        taskId: task.id,
        owner: params.workerId,
        summary: `Claimed by ${params.workerId}.`,
      });
      if (claimed) {
        return { task: claimed, metadata };
      }
    }
    return undefined;
  }

  private async finalizeAssignmentTask(params: {
    readonly parentSessionId: string;
    readonly taskId: string;
    readonly childSessionId: string;
    readonly assignment: PreparedPersistentWorkerAssignment;
    readonly childResult: import("./sub-agent.js").SubAgentResult;
  }): Promise<{
    readonly terminalStatus: "completed" | "failed" | "cancelled" | "timed_out";
    readonly failureReason?: string;
    readonly verifierVerdict?: RuntimeVerifierVerdict;
  }> {
    const verifierVerdict = mapPlannerVerifierSnapshotToRuntimeVerdict(
      params.childResult.verifierSnapshot,
    );
    const terminalOutcome = resolveDelegatedTerminalOutcome({
      surface: "direct_child",
      workerSessionId: params.childSessionId,
      taskId: params.taskId,
      completionState: params.childResult.completionState,
      completionProgress: params.childResult.completionProgress,
      stopReason: params.childResult.stopReason,
      stopReasonDetail: params.childResult.stopReasonDetail,
      validationCode: params.childResult.validationCode,
      reportedStatus: this.subAgentManager.getInfo(params.childSessionId)?.status,
      verifierRequirement: params.assignment.verifierRequirement,
      verifierVerdict,
      executionEnvelopeFingerprint:
        params.childResult.contractFingerprint ??
        params.assignment.executionEnvelopeFingerprint,
      continuationSessionId: params.childSessionId,
      ownedArtifacts: params.assignment.ownedArtifacts,
    });

    if (terminalOutcome.success) {
      await this.taskStore.finalizeRuntimeTask({
        listId: params.parentSessionId,
        taskId: params.taskId,
        status: "completed",
        summary: "Worker assignment completed successfully.",
        output: params.childResult.output,
        runtimeResult: terminalOutcome.runtimeResult,
        usage:
          params.childResult.tokenUsage as unknown as Record<string, unknown> | undefined,
        verifierVerdict,
        ownedArtifacts: params.assignment.ownedArtifacts,
        workingDirectory: params.assignment.workingDirectory,
        isolation:
          params.assignment.admittedInput.delegationAdmission?.isolationReason,
        externalRef: {
          kind: "subagent",
          id: params.childSessionId,
          sessionId: params.childSessionId,
        },
        eventData: {
          durationMs: params.childResult.durationMs,
          toolCalls: params.childResult.toolCalls.length,
          runtimeResult: terminalOutcome.runtimeResult,
        },
      });
      return {
        terminalStatus: "completed",
        verifierVerdict,
      };
    }

    const summary =
      terminalOutcome.failureReason ??
      params.childResult.output.split(/\r?\n/, 1)[0] ??
      "Worker assignment failed.";
    await this.taskStore.finalizeRuntimeTask({
      listId: params.parentSessionId,
      taskId: params.taskId,
      status:
        terminalOutcome.terminalStatus === "cancelled" ? "cancelled" : "failed",
      summary,
      output: params.childResult.output,
      runtimeResult: terminalOutcome.runtimeResult,
      usage:
        params.childResult.tokenUsage as unknown as Record<string, unknown> | undefined,
      verifierVerdict,
      ownedArtifacts: params.assignment.ownedArtifacts,
      workingDirectory: params.assignment.workingDirectory,
      isolation:
        params.assignment.admittedInput.delegationAdmission?.isolationReason,
      externalRef: {
        kind: "subagent",
        id: params.childSessionId,
        sessionId: params.childSessionId,
      },
      eventData: {
        durationMs: params.childResult.durationMs,
        toolCalls: params.childResult.toolCalls.length,
        runtimeResult: terminalOutcome.runtimeResult,
      },
    });
    return {
      terminalStatus: terminalOutcome.terminalStatus,
      failureReason: summary,
      verifierVerdict,
    };
  }

  private async executeClaimedAssignment(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly task: Task;
    readonly metadata: WorkerAssignmentMetadata;
  }): Promise<void> {
    const assignment = params.metadata.assignment;
    await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
      worker.currentTaskId = params.task.id;
      worker.state = assignment.verifierRequirement?.required === true
        ? "verifying"
        : "running";
      worker.summary = `Running ${assignment.objective}.`;
    });

    let childSessionId: string;
    const currentWorker = await this.getWorkerRecord(
      params.parentSessionId,
      params.workerId,
    );
    try {
      const childPrompt = buildDelegatedChildPrompt(assignment.admittedInput, {
        continuationAuthorized: Boolean(currentWorker?.continuationSessionId),
        workingDirectory: assignment.workingDirectory,
      });
      childSessionId = await this.subAgentManager.spawn({
        parentSessionId: params.parentSessionId,
        task: assignment.objective,
        prompt: childPrompt,
        ...(currentWorker?.continuationSessionId
          ? { continuationSessionId: currentWorker.continuationSessionId }
          : {}),
        ...(assignment.workingDirectory
          ? { workingDirectory: assignment.workingDirectory }
          : {}),
        ...(assignment.admittedInput.executionContext?.workspaceRoot
          ? { workingDirectorySource: "execution_envelope" as const }
          : {}),
        tools: assignment.allowedTools,
        ...(assignment.request.requiredToolCapabilities
          ? { requiredCapabilities: assignment.request.requiredToolCapabilities }
          : {}),
        delegationSpec: assignment.admittedInput,
        requireToolCall: specRequiresSuccessfulToolEvidence(
          assignment.admittedInput,
        ),
        ...(assignment.verifierRequirement
          ? { verifierRequirement: assignment.verifierRequirement }
          : {}),
        unsafeBenchmarkMode: assignment.unsafeBenchmarkMode === true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskStore.finalizeRuntimeTask({
        listId: params.parentSessionId,
        taskId: params.task.id,
        status: "failed",
        summary: `Worker assignment could not start: ${message}`,
        workingDirectory: assignment.workingDirectory,
        isolation:
          assignment.admittedInput.delegationAdmission?.isolationReason,
        eventData: { stage: "spawn" },
      });
      await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
        worker.currentTaskId = undefined;
        worker.lastTaskId = params.task.id;
        worker.state = "idle";
        worker.summary = `Assignment failed to start: ${message}`;
      });
      return;
    }

    await this.taskStore.attachExternalRef(
      params.parentSessionId,
      params.task.id,
      {
        kind: "subagent",
        id: childSessionId,
        sessionId: childSessionId,
      },
      "Worker assignment started.",
    );
    await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
      worker.activeSubagentSessionId = childSessionId;
      worker.continuationSessionId = childSessionId;
      worker.state = assignment.verifierRequirement?.required === true
        ? "verifying"
        : "running";
      worker.summary = `Running ${assignment.objective}.`;
    });

    while (true) {
      const childResult = this.subAgentManager.getResult(childSessionId);
      if (childResult) {
        const finalized = await this.finalizeAssignmentTask({
          parentSessionId: params.parentSessionId,
          taskId: params.task.id,
          childSessionId,
          assignment,
          childResult,
        });
        await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
          worker.currentTaskId = undefined;
          worker.lastTaskId = params.task.id;
          worker.activeSubagentSessionId = undefined;
          worker.continuationSessionId = childSessionId;
          if (worker.stopRequested) {
            worker.state = "cancelled";
            worker.summary = "Worker stopped.";
          } else {
            worker.state = "idle";
            worker.summary =
              finalized.terminalStatus === "completed"
                ? `Completed ${assignment.objective}.`
                : finalized.failureReason ?? `Assignment ${finalized.terminalStatus}.`;
          }
        });
        return;
      }

      const approvalPending = this.hasPendingApproval(
        params.parentSessionId,
        childSessionId,
      );
      const nextState: PersistentWorkerState = approvalPending
        ? "waiting_for_permission"
        : assignment.verifierRequirement?.required === true
          ? "verifying"
          : "running";
      await this.updateWorker(params.parentSessionId, params.workerId, (worker) => {
        worker.activeSubagentSessionId = childSessionId;
        worker.state = nextState;
        worker.summary = approvalPending
          ? `Waiting for approval on ${assignment.objective}.`
          : `Running ${assignment.objective}.`;
      });
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async runWorkerLoop(
    parentSessionId: string,
    workerId: string,
  ): Promise<void> {
    while (true) {
      const worker = await this.getWorkerRecord(parentSessionId, workerId);
      if (!worker || isTerminalWorkerState(worker.state)) {
        return;
      }
      if (worker.stopRequested && !worker.currentTaskId) {
        await this.updateWorker(parentSessionId, workerId, (record) => {
          record.state = "cancelled";
          record.summary = "Worker stopped.";
        });
        return;
      }

      const claim = await this.claimNextAssignment({
        parentSessionId,
        workerId,
      });
      if (!claim) {
        await this.updateWorker(parentSessionId, workerId, (record) => {
          if (!record.stopRequested) {
            record.state = "idle";
            record.summary = "Worker ready for assignments.";
          }
        });
        return;
      }

      await this.executeClaimedAssignment({
        parentSessionId,
        workerId,
        task: claim.task,
        metadata: claim.metadata,
      });
    }
  }

  async scheduleWorker(parentSessionId: string, workerId: string): Promise<void> {
    await this.queue.run(this.workerLoopKey(parentSessionId, workerId), async () => {
      await this.runWorkerLoop(parentSessionId, workerId);
    });
  }

  async repairRuntimeState(): Promise<void> {
    const keys = await this.memoryBackend.listKeys(PERSISTENT_WORKER_KEY_PREFIX);
    for (const key of keys) {
      const parentSessionId = key.slice(PERSISTENT_WORKER_KEY_PREFIX.length);
      const registry = await this.loadRegistry(parentSessionId);
      const affectedWorkerIds = registry.workers
        .filter((worker) => !isTerminalWorkerState(worker.state))
        .map((worker) => worker.workerId);
      if (affectedWorkerIds.length === 0) {
        continue;
      }
      await this.mutateRegistry(parentSessionId, async (mutableRegistry) => {
        for (const worker of mutableRegistry.workers) {
          if (affectedWorkerIds.includes(worker.workerId)) {
            worker.state = "failed";
            worker.stopRequested = true;
            worker.currentTaskId = undefined;
            worker.activeSubagentSessionId = undefined;
            worker.summary =
              "Worker runtime became unavailable before completion.";
            worker.updatedAt = this.now();
          }
        }
      });
      const tasks = await this.taskStore.listTasks(parentSessionId);
      for (const task of tasks) {
        if (task.kind !== "worker_assignment") continue;
        const metadata = extractWorkerAssignmentMetadata(task);
        if (!metadata) continue;
        const targetedWorkerId = metadata.targetWorkerId;
        if (
          (task.owner && affectedWorkerIds.includes(task.owner)) ||
          (targetedWorkerId && affectedWorkerIds.includes(targetedWorkerId))
        ) {
          await this.taskStore.updateTask(parentSessionId, task.id, {
            status: "pending",
            owner: null,
            metadata: {
              [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
                assignment: metadata.assignment,
              }),
            },
          });
        }
      }
    }
  }

  async describeRuntimeWorkerLayer(
    parentSessionId: string,
    configured: boolean,
  ): Promise<RuntimeWorkerLayerSnapshot> {
    if (!configured) {
      return {
        configured: false,
        effective: false,
        launchMode: "none",
        activePublicWorkers: 0,
        stateCounts: {},
        inactiveReason: "flag_disabled",
      };
    }
    const workers = await this.listWorkerRecords(parentSessionId);
    const stateCounts: Partial<Record<PersistentWorkerState, number>> = {};
    for (const worker of workers) {
      stateCounts[worker.state] = (stateCounts[worker.state] ?? 0) + 1;
    }
    return {
      configured: true,
      effective: true,
      launchMode: "persistent_worker_pool",
      activePublicWorkers: workers.filter((worker) => !isTerminalWorkerState(worker.state)).length,
      stateCounts,
      ...(await this.getLatestReusableWorkerId(parentSessionId)
        ? { latestReusableWorkerId: await this.getLatestReusableWorkerId(parentSessionId) }
        : {}),
    };
  }

  async handleRuntimeReset(reason: string): Promise<void> {
    await this.repairRuntimeState();
    this.logger.debug("Persistent worker runtime reset", { reason });
  }
}
