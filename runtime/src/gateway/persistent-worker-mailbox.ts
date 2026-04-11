import type { MemoryBackend } from "../memory/types.js";
import type {
  RuntimeMailboxDirection,
  RuntimeMailboxLayerSnapshot,
  RuntimeMailboxMessage,
  RuntimeMailboxStatus,
} from "../runtime-contract/types.js";
import { KeyedAsyncQueue } from "../utils/keyed-async-queue.js";
import { silentLogger, type Logger } from "../utils/logger.js";

const PERSISTENT_WORKER_MAILBOX_KEY_PREFIX =
  "persistent-worker-mailbox:session:";
const PERSISTENT_WORKER_MAILBOX_SCHEMA_VERSION = 1;

interface PersistentWorkerMailboxSession {
  readonly version: number;
  readonly parentSessionId: string;
  nextMessageNumber: number;
  messages: StoredRuntimeMailboxMessage[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type StoredRuntimeMailboxMessage = Mutable<RuntimeMailboxMessage>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type RuntimeMailboxMessageDraft = DistributiveOmit<
  RuntimeMailboxMessage,
  "messageId" | "status" | "createdAt" | "updatedAt"
>;

type ParentToWorkerDraft = DistributiveOmit<
  Extract<RuntimeMailboxMessage, { direction: "parent_to_worker" }>,
  "messageId" | "status" | "createdAt" | "updatedAt" |
  "direction"
>;
type WorkerToParentDraft = DistributiveOmit<
  Extract<RuntimeMailboxMessage, { direction: "worker_to_parent" }>,
  "messageId" | "status" | "createdAt" | "updatedAt" |
  "direction"
>;

interface PersistentWorkerMailboxOptions {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
  readonly now?: () => number;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRuntimeMailboxDirection(
  value: unknown,
): value is RuntimeMailboxDirection {
  return value === "parent_to_worker" || value === "worker_to_parent";
}

function isRuntimeMailboxStatus(
  value: unknown,
): value is RuntimeMailboxStatus {
  return (
    value === "pending" ||
    value === "acknowledged" ||
    value === "handled"
  );
}

function coerceRuntimeMailboxMessage(
  value: unknown,
) : StoredRuntimeMailboxMessage | undefined {
  const raw = asPlainObject(value);
  if (!raw) return undefined;
  const type = asNonEmptyString(raw?.type);
  const messageId = asNonEmptyString(raw?.messageId);
  const parentSessionId = asNonEmptyString(raw?.parentSessionId);
  const workerId = asNonEmptyString(raw?.workerId);
  const direction = raw?.direction;
  const status = raw?.status;
  const createdAt =
    typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : undefined;
  const updatedAt =
    typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : undefined;
  if (
    !type ||
    !messageId ||
    !parentSessionId ||
    !workerId ||
    !isRuntimeMailboxDirection(direction) ||
    !isRuntimeMailboxStatus(status) ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  const base = {
    type,
    messageId,
    parentSessionId,
    workerId,
    direction,
    status,
    createdAt,
    updatedAt,
    ...(asNonEmptyString(raw.taskId) ? { taskId: asNonEmptyString(raw.taskId) } : {}),
    ...(asNonEmptyString(raw.correlationId)
      ? { correlationId: asNonEmptyString(raw.correlationId) }
      : {}),
  } as const;

  switch (type) {
    case "idle_notification": {
      const summary = asNonEmptyString(raw.summary);
      if (!summary || direction !== "worker_to_parent") return undefined;
      return { ...base, type, direction, summary } as StoredRuntimeMailboxMessage;
    }
    case "permission_request": {
      const approvalRequestId = asNonEmptyString(raw.approvalRequestId);
      const message = asNonEmptyString(raw.message);
      if (!approvalRequestId || !message || direction !== "worker_to_parent") {
        return undefined;
      }
      return {
        ...base,
        type,
        direction,
        approvalRequestId,
        message,
        ...(asNonEmptyString(raw.toolName)
          ? { toolName: asNonEmptyString(raw.toolName) }
          : {}),
        ...(asNonEmptyString(raw.subagentSessionId)
          ? { subagentSessionId: asNonEmptyString(raw.subagentSessionId) }
          : {}),
        ...(asNonEmptyString(raw.approverGroup)
          ? { approverGroup: asNonEmptyString(raw.approverGroup) }
          : {}),
        ...(Array.isArray(raw.requiredApproverRoles)
          ? {
              requiredApproverRoles: raw.requiredApproverRoles.filter(
                (entry): entry is string => typeof entry === "string",
              ),
            }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "permission_response": {
      const approvalRequestId = asNonEmptyString(raw.approvalRequestId);
      const disposition =
        raw.disposition === "yes" ||
        raw.disposition === "no" ||
        raw.disposition === "always"
          ? raw.disposition
          : undefined;
      if (!approvalRequestId || !disposition || direction !== "parent_to_worker") {
        return undefined;
      }
      return {
        ...base,
        type,
        direction,
        approvalRequestId,
        disposition,
        ...(asNonEmptyString(raw.approvedBy)
          ? { approvedBy: asNonEmptyString(raw.approvedBy) }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "shutdown_request": {
      if (direction !== "parent_to_worker") return undefined;
      return {
        ...base,
        type,
        direction,
        ...(asNonEmptyString(raw.reason)
          ? { reason: asNonEmptyString(raw.reason) }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "task_assignment": {
      const taskId = asNonEmptyString(raw.taskId);
      const objective = asNonEmptyString(raw.objective);
      if (!taskId || !objective || direction !== "parent_to_worker") {
        return undefined;
      }
      return {
        ...base,
        type,
        direction,
        taskId,
        objective,
        ...(asNonEmptyString(raw.summary)
          ? { summary: asNonEmptyString(raw.summary) }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "mode_change": {
      const body = asNonEmptyString(raw.body);
      if (!body || direction !== "parent_to_worker") return undefined;
      return {
        ...base,
        type,
        direction,
        body,
        ...(asNonEmptyString(raw.subject)
          ? { subject: asNonEmptyString(raw.subject) }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "verifier_result": {
      const overall =
        raw.overall === "pass" ||
        raw.overall === "fail" ||
        raw.overall === "retry" ||
        raw.overall === "skipped"
          ? raw.overall
          : undefined;
      if (!overall || direction !== "worker_to_parent") return undefined;
      return {
        ...base,
        type,
        direction,
        overall,
        ...(asNonEmptyString(raw.summary)
          ? { summary: asNonEmptyString(raw.summary) }
          : {}),
      } as StoredRuntimeMailboxMessage;
    }
    case "worker_summary": {
      const state =
        raw.state === "starting" ||
        raw.state === "running" ||
        raw.state === "idle" ||
        raw.state === "waiting_for_permission" ||
        raw.state === "verifying" ||
        raw.state === "completed" ||
        raw.state === "failed" ||
        raw.state === "cancelled"
          ? raw.state
          : undefined;
      const summary = asNonEmptyString(raw.summary);
      if (!state || !summary || direction !== "worker_to_parent") {
        return undefined;
      }
      return {
        ...base,
        type,
        direction,
        state,
        summary,
      } as StoredRuntimeMailboxMessage;
    }
    default:
      return undefined;
  }
}

function cloneMessage(message: StoredRuntimeMailboxMessage): RuntimeMailboxMessage {
  return cloneJson(message);
}

function cloneSession(
  session: PersistentWorkerMailboxSession,
): PersistentWorkerMailboxSession {
  return {
    version: session.version,
    parentSessionId: session.parentSessionId,
    nextMessageNumber: session.nextMessageNumber,
    messages: session.messages.map(cloneMessage),
  };
}

function createEmptySession(
  parentSessionId: string,
): PersistentWorkerMailboxSession {
  return {
    version: PERSISTENT_WORKER_MAILBOX_SCHEMA_VERSION,
    parentSessionId,
    nextMessageNumber: 1,
    messages: [],
  };
}

function coerceSession(
  value: unknown,
  parentSessionId: string,
): PersistentWorkerMailboxSession {
  const raw = asPlainObject(value);
  if (!raw) {
    return createEmptySession(parentSessionId);
  }
  return {
    version: PERSISTENT_WORKER_MAILBOX_SCHEMA_VERSION,
    parentSessionId:
      asNonEmptyString(raw.parentSessionId) ?? parentSessionId,
    nextMessageNumber:
      typeof raw.nextMessageNumber === "number" &&
      Number.isInteger(raw.nextMessageNumber) &&
      raw.nextMessageNumber > 0
        ? raw.nextMessageNumber
        : 1,
    messages: Array.isArray(raw.messages)
      ? raw.messages
          .map((entry) => coerceRuntimeMailboxMessage(entry))
          .filter((entry): entry is RuntimeMailboxMessage => entry !== undefined)
      : [],
  };
}

export class PersistentWorkerMailbox {
  private readonly memoryBackend: MemoryBackend;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly queue: KeyedAsyncQueue;

  constructor(options: PersistentWorkerMailboxOptions) {
    this.memoryBackend = options.memoryBackend;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.queue = new KeyedAsyncQueue({
      logger: this.logger,
      label: "persistent worker mailbox",
    });
  }

  private sessionKey(parentSessionId: string): string {
    return `${PERSISTENT_WORKER_MAILBOX_KEY_PREFIX}${parentSessionId}`;
  }

  private async loadSession(
    parentSessionId: string,
  ): Promise<PersistentWorkerMailboxSession> {
    return coerceSession(
      await this.memoryBackend.get(this.sessionKey(parentSessionId)),
      parentSessionId,
    );
  }

  private async saveSession(
    session: PersistentWorkerMailboxSession,
  ): Promise<void> {
    await this.memoryBackend.set(
      this.sessionKey(session.parentSessionId),
      cloneSession(session),
    );
  }

  private async mutateSession<T>(
    parentSessionId: string,
    mutate: (session: PersistentWorkerMailboxSession) => Promise<T> | T,
  ): Promise<T> {
    return this.queue.run(this.sessionKey(parentSessionId), async () => {
      const session = await this.loadSession(parentSessionId);
      const result = await mutate(session);
      await this.saveSession(session);
      return result;
    });
  }

  private createMessage(
    session: PersistentWorkerMailboxSession,
    draft: RuntimeMailboxMessageDraft,
  ): StoredRuntimeMailboxMessage {
    const now = this.now();
    const message = {
      ...cloneJson(draft),
      messageId: `mail-${session.nextMessageNumber++}`,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    } as StoredRuntimeMailboxMessage;
    return message;
  }

  async sendToWorker(draft: ParentToWorkerDraft): Promise<RuntimeMailboxMessage> {
    return this.mutateSession(draft.parentSessionId, async (session) => {
      const message = this.createMessage(session, {
        ...draft,
        direction: "parent_to_worker",
      } as RuntimeMailboxMessageDraft);
      session.messages.push(message);
      return cloneMessage(message);
    });
  }

  async sendToParent(draft: WorkerToParentDraft): Promise<RuntimeMailboxMessage> {
    return this.mutateSession(draft.parentSessionId, async (session) => {
      const message = this.createMessage(session, {
        ...draft,
        direction: "worker_to_parent",
      } as RuntimeMailboxMessageDraft);
      session.messages.push(message);
      return cloneMessage(message);
    });
  }

  async listMessages(params: {
    readonly parentSessionId: string;
    readonly workerId?: string;
    readonly direction?: RuntimeMailboxDirection;
    readonly status?: RuntimeMailboxStatus;
    readonly limit?: number;
  }): Promise<readonly RuntimeMailboxMessage[]> {
    const session = await this.loadSession(params.parentSessionId);
    const messages = session.messages
      .filter((message) => {
        if (params.workerId && message.workerId !== params.workerId) return false;
        if (params.direction && message.direction !== params.direction) return false;
        if (params.status && message.status !== params.status) return false;
        return true;
      })
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt;
        }
        return left.messageId.localeCompare(right.messageId);
      });
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit))
        : undefined;
    return (limit ? messages.slice(-limit) : messages).map(cloneMessage);
  }

  async getMessage(params: {
    readonly parentSessionId: string;
    readonly messageId: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    const session = await this.loadSession(params.parentSessionId);
    const message = session.messages.find(
      (entry) => entry.messageId === params.messageId,
    );
    return message ? cloneMessage(message) : undefined;
  }

  async acknowledgeMessage(params: {
    readonly parentSessionId: string;
    readonly messageId: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    return this.mutateSession(params.parentSessionId, async (session) => {
      const message = session.messages.find(
        (entry) => entry.messageId === params.messageId,
      );
      if (!message) return undefined;
      if (message.status === "pending") {
        message.status = "acknowledged";
        message.updatedAt = this.now();
      }
      return cloneMessage(message);
    });
  }

  async markHandled(params: {
    readonly parentSessionId: string;
    readonly messageId: string;
  }): Promise<RuntimeMailboxMessage | undefined> {
    return this.mutateSession(params.parentSessionId, async (session) => {
      const message = session.messages.find(
        (entry) => entry.messageId === params.messageId,
      );
      if (!message) return undefined;
      if (message.status !== "handled") {
        message.status = "handled";
        message.updatedAt = this.now();
      }
      return cloneMessage(message);
    });
  }

  async claimNextWorkerMessage(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
    readonly types?: readonly RuntimeMailboxMessage["type"][];
  }): Promise<RuntimeMailboxMessage | undefined> {
    return this.mutateSession(params.parentSessionId, async (session) => {
      const matched = session.messages
        .filter((message) => {
          if (message.workerId !== params.workerId) return false;
          if (message.direction !== "parent_to_worker") return false;
          if (message.status !== "pending") return false;
          if (params.types && !params.types.includes(message.type)) return false;
          return true;
        })
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) {
            return left.createdAt - right.createdAt;
          }
          return left.messageId.localeCompare(right.messageId);
        })[0];
      if (!matched) return undefined;
      matched.status = "acknowledged";
      matched.updatedAt = this.now();
      return cloneMessage(matched);
    });
  }

  async getWorkerMailboxCounts(params: {
    readonly parentSessionId: string;
    readonly workerId: string;
  }): Promise<{
    readonly pendingInboxCount: number;
    readonly pendingOutboxCount: number;
    readonly lastMailboxActivityAt?: number;
  }> {
    const session = await this.loadSession(params.parentSessionId);
    const workerMessages = session.messages.filter(
      (message) => message.workerId === params.workerId,
    );
    const lastMailboxActivityAt =
      workerMessages.length > 0
        ? Math.max(...workerMessages.map((message) => message.updatedAt))
        : undefined;
    return {
      pendingInboxCount: workerMessages.filter(
        (message) =>
          message.direction === "parent_to_worker" &&
          message.status !== "handled",
      ).length,
      pendingOutboxCount: workerMessages.filter(
        (message) =>
          message.direction === "worker_to_parent" &&
          message.status !== "handled",
      ).length,
      ...(lastMailboxActivityAt !== undefined ? { lastMailboxActivityAt } : {}),
    };
  }

  async describeRuntimeMailboxLayer(params: {
    readonly configured: boolean;
    readonly parentSessionId: string;
  }): Promise<RuntimeMailboxLayerSnapshot> {
    if (!params.configured) {
      return {
        configured: false,
        effective: false,
        pendingParentToWorker: 0,
        pendingWorkerToParent: 0,
        unackedCount: 0,
        inactiveReason: "flag_disabled",
      };
    }
    const session = await this.loadSession(params.parentSessionId);
    return {
      configured: true,
      effective: true,
      pendingParentToWorker: session.messages.filter(
        (message) =>
          message.direction === "parent_to_worker" &&
          message.status !== "handled",
      ).length,
      pendingWorkerToParent: session.messages.filter(
        (message) =>
          message.direction === "worker_to_parent" &&
          message.status !== "handled",
      ).length,
      unackedCount: session.messages.filter(
        (message) => message.status === "pending",
      ).length,
    };
  }

  async repairRuntimeState(): Promise<void> {
    const keys = await this.memoryBackend.listKeys(
      PERSISTENT_WORKER_MAILBOX_KEY_PREFIX,
    );
    for (const key of keys) {
      const parentSessionId = key.slice(
        PERSISTENT_WORKER_MAILBOX_KEY_PREFIX.length,
      );
      await this.mutateSession(parentSessionId, async (session) => {
        const now = this.now();
        for (const message of session.messages) {
          if (
            message.direction === "parent_to_worker" &&
            message.status === "acknowledged"
          ) {
            message.status = "pending";
            message.updatedAt = now;
          }
        }
      });
    }
  }
}
