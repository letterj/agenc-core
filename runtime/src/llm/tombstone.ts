/**
 * Tombstone message support (Cut 5.9).
 *
 * Mirrors `claude_code/types/message.ts:TombstoneMessage` and the
 * orphaned-thinking-block recovery in
 * `claude_code/query.ts:queryLoop`.
 *
 * When streaming fallback or a credential change leaves orphaned
 * assistant content (e.g. thinking blocks bound to a now-stale API
 * key), the runtime should yield a tombstone marking the prior
 * message for UI removal. Tombstones are ephemeral — they're not
 * persisted to the session JSONL.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";

export interface TombstoneMessage {
  readonly type: "tombstone";
  /** UUID of the message being tombstoned. */
  readonly targetUuid: string;
  /** Diagnostic reason for the tombstone. */
  readonly reason: TombstoneReason;
  readonly createdAt: number;
}

export type TombstoneReason =
  | "streaming_fallback"
  | "credential_changed"
  | "model_swap"
  | "validation_error";

export function createTombstone(
  targetUuid: string,
  reason: TombstoneReason,
): TombstoneMessage {
  return {
    type: "tombstone",
    targetUuid,
    reason,
    createdAt: Date.now(),
  };
}

/**
 * Strip messages whose UUID appears in the tombstone set. Mirrors the
 * post-streaming-fallback message rebuild in claude_code's queryLoop.
 */
export function applyTombstones(
  messages: readonly LLMMessage[],
  tombstones: readonly TombstoneMessage[],
): readonly LLMMessage[] {
  if (tombstones.length === 0) return messages;
  const targets = new Set(tombstones.map((t) => t.targetUuid));
  return messages.filter((message) => {
    const uuid = (message as { uuid?: string }).uuid;
    if (!uuid) return true;
    return !targets.has(uuid);
  });
}
