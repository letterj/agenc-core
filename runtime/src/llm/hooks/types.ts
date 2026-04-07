/**
 * Hook system types (Cut 5.2).
 *
 * Mirrors `claude_code/utils/hooks.ts` and the schemas under
 * `claude_code/schemas/hooks.ts`.
 *
 * The runtime today has a partial hook surface in
 * `gateway/hook-dispatcher.ts` (PreToolUse / PostToolUse only). This
 * module ships the full claude_code-shaped event taxonomy so the
 * gateway dispatcher can be widened in a follow-up commit.
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "../types.js";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "PermissionDenied"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "FileChanged"
  | "ConfigChange";

export type HookKind = "command" | "callback" | "function" | "http";

export interface HookDefinition {
  readonly event: HookEvent;
  readonly kind: HookKind;
  /** Glob / regex / pipe-separated alternatives the matcher resolves. */
  readonly matcher?: string;
  /** Shell command or HTTP URL or callback id. */
  readonly target: string;
  /** Per-hook timeout. */
  readonly timeoutMs?: number;
}

export interface HookContextBase {
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly chainId?: string;
  readonly depth?: number;
}

export interface PreToolUseContext extends HookContextBase {
  readonly event: "PreToolUse";
  readonly toolCall: LLMToolCall;
}

export interface PostToolUseContext extends HookContextBase {
  readonly event: "PostToolUse";
  readonly toolCall: LLMToolCall;
  readonly result: string;
  readonly isError?: boolean;
}

export interface PostToolUseFailureContext extends HookContextBase {
  readonly event: "PostToolUseFailure";
  readonly toolCall: LLMToolCall;
  readonly errorMessage: string;
}

export interface SessionLifecycleContext extends HookContextBase {
  readonly event: "SessionStart" | "Stop" | "StopFailure";
  readonly messages: readonly LLMMessage[];
}

export interface CompactContext extends HookContextBase {
  readonly event: "PreCompact" | "PostCompact";
  readonly layer: "snip" | "microcompact" | "autocompact" | "reactive-compact";
}

export type HookContext =
  | PreToolUseContext
  | PostToolUseContext
  | PostToolUseFailureContext
  | SessionLifecycleContext
  | CompactContext
  | (HookContextBase & {
      readonly event: Exclude<
        HookEvent,
        | "PreToolUse"
        | "PostToolUse"
        | "PostToolUseFailure"
        | "SessionStart"
        | "Stop"
        | "StopFailure"
        | "PreCompact"
        | "PostCompact"
      >;
    });

export interface HookOutcome {
  readonly action: "allow" | "deny" | "noop";
  readonly message?: string;
  /** Optional input override (e.g. PreToolUse rewriting tool args). */
  readonly updatedInput?: Record<string, unknown>;
  /** Async hook elapsed time for diagnostics. */
  readonly durationMs?: number;
}
