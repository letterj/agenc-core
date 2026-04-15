import { randomUUID } from "node:crypto";
import type { LLMMessage } from "../llm/types.js";
import type {
  MemoryBackend,
  TranscriptCapableMemoryBackend,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptMessagePayload,
  TranscriptMetadataProjectionPayload,
  TranscriptCustomPayload,
} from "../memory/types.js";

const TRANSCRIPT_KV_PREFIX = "transcript:v1:";

export type SessionTranscriptEvent =
  | SessionTranscriptMessageEvent
  | SessionTranscriptHistorySnapshotEvent
  | SessionTranscriptMetadataProjectionEvent;

export interface SessionTranscriptBaseEvent {
  readonly version: 1;
  readonly seq?: number;
  readonly eventId: string;
  readonly dedupeKey?: string;
  readonly timestamp: number;
  readonly surface:
    | "webchat"
    | "text"
    | "voice"
    | "subagent"
    | "background"
    | "system";
}

export interface SessionTranscriptMessageEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "message";
  readonly message: LLMMessage;
}

export interface SessionTranscriptHistorySnapshotEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "history_snapshot";
  readonly reason: "migration" | "compaction" | "fork";
  readonly history: readonly LLMMessage[];
  readonly boundaryId?: string;
}

export interface SessionTranscriptMetadataProjectionEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "metadata_projection";
  readonly key: string;
  readonly value: unknown;
}

export interface SessionTranscriptDocument {
  readonly version: 1;
  readonly streamId: string;
  readonly nextSeq: number;
  readonly events: readonly SessionTranscriptEvent[];
}

function transcriptKey(streamId: string): string {
  return `${TRANSCRIPT_KV_PREFIX}${streamId}`;
}

function cloneMessage(message: LLMMessage): LLMMessage {
  return JSON.parse(JSON.stringify(message)) as LLMMessage;
}

function cloneEvent(event: SessionTranscriptEvent): SessionTranscriptEvent {
  return JSON.parse(JSON.stringify(event)) as SessionTranscriptEvent;
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSurface(
  value: unknown,
): SessionTranscriptBaseEvent["surface"] {
  switch (value) {
    case "webchat":
    case "text":
    case "voice":
    case "subagent":
    case "background":
    case "system":
      return value;
    default:
      return "system";
  }
}

function normalizeDocument(
  streamId: string,
  value: unknown,
): SessionTranscriptDocument {
  if (
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { events?: unknown }).events)
  ) {
    const candidate = value as SessionTranscriptDocument;
    return {
      version: 1,
      streamId,
      nextSeq:
        typeof candidate.nextSeq === "number" && Number.isFinite(candidate.nextSeq)
          ? candidate.nextSeq
          : candidate.events.length + 1,
      events: candidate.events.map((event) => cloneEvent(event)),
    };
  }
  return {
    version: 1,
    streamId,
    nextSeq: 1,
    events: [],
  };
}

function toStoredTranscriptInput(
  event: SessionTranscriptEvent,
): TranscriptEventInput {
  const metadata = { surface: event.surface } satisfies Record<string, unknown>;
  switch (event.kind) {
    case "message":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "message",
        payload: {
          role: event.message.role,
          content: cloneUnknown(event.message.content),
          ...(event.message.phase ? { phase: event.message.phase } : {}),
          ...(event.message.toolCalls
            ? { toolCalls: cloneUnknown(event.message.toolCalls) }
            : {}),
          ...(event.message.toolCallId
            ? { toolCallId: event.message.toolCallId }
            : {}),
          ...(event.message.toolName ? { toolName: event.message.toolName } : {}),
        },
      };
    case "metadata_projection":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "metadata_projection",
        payload: {
          key: event.key,
          value: cloneUnknown(event.value),
        },
      };
    case "history_snapshot":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "custom",
        payload: {
          name: "history_snapshot",
          data: {
            reason: event.reason,
            ...(event.boundaryId ? { boundaryId: event.boundaryId } : {}),
            history: event.history.map((message) => cloneMessage(message)),
          },
        },
      };
  }
}

function fromStoredTranscriptEvent(
  event: TranscriptEvent,
): SessionTranscriptEvent | undefined {
  const surface = normalizeSurface(event.metadata?.surface);
  switch (event.kind) {
    case "message": {
      const payload = event.payload as TranscriptMessagePayload;
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "message",
        message: {
          role: payload.role,
          content: cloneUnknown(payload.content),
          ...(payload.phase ? { phase: payload.phase } : {}),
          ...(payload.toolCalls
            ? { toolCalls: cloneUnknown(payload.toolCalls) }
            : {}),
          ...(payload.toolCallId
            ? { toolCallId: payload.toolCallId }
            : {}),
          ...(payload.toolName ? { toolName: payload.toolName } : {}),
        },
      };
    }
    case "metadata_projection": {
      const payload = event.payload as TranscriptMetadataProjectionPayload;
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "metadata_projection",
        key: payload.key,
        value: cloneUnknown(payload.value),
      };
    }
    case "custom": {
      const payload = event.payload as TranscriptCustomPayload;
      if (payload.name !== "history_snapshot") {
        return undefined;
      }
      if (
        !payload.data ||
        typeof payload.data !== "object" ||
        !Array.isArray((payload.data as { history?: unknown }).history)
      ) {
        return undefined;
      }
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "history_snapshot",
        reason:
          (payload.data as { reason?: unknown }).reason === "migration" ||
          (payload.data as { reason?: unknown }).reason === "fork"
            ? ((payload.data as { reason: "migration" | "fork" }).reason)
            : "compaction",
        history: (payload.data as { history: readonly LLMMessage[] }).history.map(
          (message) => cloneMessage(message),
        ),
        ...((payload.data as { boundaryId?: unknown }).boundaryId &&
        typeof (payload.data as { boundaryId?: unknown }).boundaryId ===
          "string"
          ? {
              boundaryId: (payload.data as { boundaryId: string }).boundaryId,
            }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

async function appendTranscriptBatchFallback(
  memoryBackend: MemoryBackend,
  streamId: string,
  events: readonly SessionTranscriptEvent[],
): Promise<SessionTranscriptEvent[]> {
  const key = transcriptKey(streamId);
  const current = normalizeDocument(
    streamId,
    await memoryBackend.get<SessionTranscriptDocument>(key),
  );
  const existingEventIds = new Set(current.events.map((event) => event.eventId));
  const existingDedupeKeys = new Set(
    current.events
      .map((event) => event.dedupeKey)
      .filter((value): value is string => typeof value === "string"),
  );

  let nextSeq = current.nextSeq;
  const appended: SessionTranscriptEvent[] = [];
  const mergedEvents = [...current.events];
  for (const event of events) {
    if (existingEventIds.has(event.eventId)) {
      continue;
    }
    if (event.dedupeKey && existingDedupeKeys.has(event.dedupeKey)) {
      continue;
    }
    const normalized: SessionTranscriptEvent = {
      ...cloneEvent(event),
      seq: nextSeq++,
    };
    mergedEvents.push(normalized);
    appended.push(normalized);
    existingEventIds.add(normalized.eventId);
    if (normalized.dedupeKey) {
      existingDedupeKeys.add(normalized.dedupeKey);
    }
  }

  await memoryBackend.set(key, {
    version: 1,
    streamId,
    nextSeq,
    events: mergedEvents,
  } satisfies SessionTranscriptDocument);
  return appended;
}

export async function appendTranscriptBatch(
  memoryBackend: MemoryBackend,
  streamId: string,
  events: readonly SessionTranscriptEvent[],
): Promise<SessionTranscriptEvent[]> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.appendTranscript === "function") {
    const stored = await capable.appendTranscript(
      streamId,
      events.map((event) => toStoredTranscriptInput(event)),
    );
    return stored
      .map((event) => fromStoredTranscriptEvent(event))
      .filter((event): event is SessionTranscriptEvent => event !== undefined);
  }
  return appendTranscriptBatchFallback(memoryBackend, streamId, events);
}

export async function loadTranscript(
  memoryBackend: MemoryBackend,
  streamId: string,
  afterSeq?: number,
): Promise<SessionTranscriptDocument | undefined> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.loadTranscript === "function") {
    const stored = await capable.loadTranscript(streamId, {
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    if (stored.length === 0) {
      return undefined;
    }
    return {
      version: 1,
      streamId,
      nextSeq: stored[stored.length - 1]!.seq + 1,
      events: stored
        .map((event) => fromStoredTranscriptEvent(event))
        .filter((event): event is SessionTranscriptEvent => event !== undefined),
    };
  }

  const document = normalizeDocument(
    streamId,
    await memoryBackend.get<SessionTranscriptDocument>(transcriptKey(streamId)),
  );
  if (document.events.length === 0) {
    return undefined;
  }
  if (afterSeq === undefined) {
    return document;
  }
  return {
    ...document,
    events: document.events.filter((event) => (event.seq ?? 0) > afterSeq),
  };
}

export async function deleteTranscript(
  memoryBackend: MemoryBackend,
  streamId: string,
): Promise<boolean> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.deleteTranscript === "function") {
    return (await capable.deleteTranscript(streamId)) > 0;
  }
  return memoryBackend.delete(transcriptKey(streamId));
}

export async function listTranscriptStreams(
  memoryBackend: MemoryBackend,
  prefix?: string,
): Promise<string[]> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.listTranscriptStreams === "function") {
    return capable.listTranscriptStreams(prefix);
  }
  const keys = await memoryBackend.listKeys(
    `${TRANSCRIPT_KV_PREFIX}${prefix ?? ""}`,
  );
  return keys.map((key) => key.slice(TRANSCRIPT_KV_PREFIX.length));
}

export function historyFromTranscript(
  document: SessionTranscriptDocument | undefined,
): readonly LLMMessage[] {
  if (!document) return [];
  let history: LLMMessage[] = [];
  for (const event of document.events) {
    if (event.kind === "history_snapshot") {
      history = event.history.map((message) => cloneMessage(message));
      continue;
    }
    if (event.kind === "message") {
      history.push(cloneMessage(event.message));
    }
  }
  return history;
}

export function createTranscriptMessageEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly message: LLMMessage;
  readonly dedupeKey?: string;
  readonly timestamp?: number;
}): SessionTranscriptMessageEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "message",
    message: cloneMessage(params.message),
  };
}

export function createTranscriptHistorySnapshotEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly history: readonly LLMMessage[];
  readonly reason: SessionTranscriptHistorySnapshotEvent["reason"];
  readonly dedupeKey?: string;
  readonly timestamp?: number;
  readonly boundaryId?: string;
}): SessionTranscriptHistorySnapshotEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "history_snapshot",
    reason: params.reason,
    history: params.history.map((message) => cloneMessage(message)),
    ...(params.boundaryId ? { boundaryId: params.boundaryId } : {}),
  };
}

export function createTranscriptMetadataProjectionEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly key: string;
  readonly value: unknown;
  readonly dedupeKey?: string;
  readonly timestamp?: number;
}): SessionTranscriptMetadataProjectionEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "metadata_projection",
    key: params.key,
    value: cloneUnknown(params.value),
  };
}

export async function forkTranscript(
  memoryBackend: MemoryBackend,
  sourceStreamId: string,
  targetStreamId: string,
): Promise<boolean> {
  const loaded = await loadTranscript(memoryBackend, sourceStreamId);
  if (!loaded || loaded.events.length === 0) {
    return false;
  }
  await appendTranscriptBatch(
    memoryBackend,
    targetStreamId,
    loaded.events.map((event) => ({
      ...cloneEvent(event),
      eventId: randomUUID(),
      seq: undefined,
      dedupeKey: undefined,
    })),
  );
  return true;
}
