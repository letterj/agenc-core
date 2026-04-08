# TODO: Make AgenC runtime BEHAVE like claude_code (without becoming the claude CLI)

**Goal.** The AgenC runtime daemon should feel as reliable as claude_code's
agent loop — deep streaming, layered compaction that actually runs, parallel
tool dispatch, recursive sub-agents, reactive recovery — while **keeping every
AgenC-only surface** (WebSocket channels, daemon control plane, background
runs, Concordia bridge, skills marketplace, Solana protocol integration,
Watch TUI, memory/consolidation, observability/replay, desktop automation,
eval/chaos suite, autonomous lane).

**Non-goal.** We are NOT becoming the claude CLI. No Ink TUI, no print/repl
modes, no @anthropic-ai/sdk direct dependency on claude_code packages, no CLI
entrypoints beyond the existing `agenc-runtime`/`agenc`/`agenc-watch` bins.

**Source of this plan.** Parallel audit of
`/home/tetsuo/git/claude_code` and `/home/tetsuo/git/AgenC/agenc-core/runtime`
by 10 focused subagents covering: query.ts shape, tool orchestration, dead
code, subagent stack, Message types, AgenC extensions, hooks/permissions,
compaction, chatExecutor caller migration, and daemon residuals.

**What the previous continuation sprint actually did** (PRs #178–#258, ~-35K
LOC): deleted planner-era cruft, un-exported every symbol with zero external
consumers, ported individual claude_code patterns (hooks, canUseTool, layered
compact modules, tool-result-budget, message normalization, agent loader,
permission glob) as **disconnected files**, and removed ~23K LOC of dead tests
and stubs. What it did **not** do: wire those ported patterns into the live
loop, convert the ChatExecutor class to an async generator, implement real
tool parallelism, or add reactive 413 recovery.

**The honest scorecard.**

| Subsystem | Claude parity | Status |
|---|---|---|
| Hooks registry | ✓ defined, ✓ partially wired | PreToolUse/PostToolUse fire; 8 other events declared but never fired |
| canUseTool seam | ✓ wired at chat-executor-tool-loop.ts:610 | Live |
| Permission evaluator | ✓ unified class exists at policy/tool-permission-evaluator.ts | Not wired to WebSocket approvals |
| Tool result budget | ✓ wired at chat-executor-tool-loop.ts:733 | Live |
| Message normalization | ✓ ported at llm/messages.ts | Partial (no cache_control, no tombstones) |
| Layered compaction | ✗ **SKELETON ONLY** | Files exist at llm/compact/* but **never imported from chat-executor** |
| Parallel tool dispatch | ✗ **TELEMETRY ONLY** | `isConcurrencySafe` predicate is inventory; dispatch loop is serial |
| Reactive 413 compaction | ✗ not implemented | No context_window_exceeded handling |
| cache_control breakpoints | ✗ not implemented | Zero `cache_control` references in runtime/src/llm |
| Async generator loop | ✗ class-based | `ChatExecutor.execute() → Promise<ChatExecutorResult>` |
| TombstoneMessage | ✗ type doesn't exist | Needed for compaction boundaries |
| ToolUseSummaryMessage | ✗ type doesn't exist | Needed for subagent summaries |
| RequestStartEvent / StreamEvent | ✗ no yielded event types | LLMStreamChunk callback only |
| Subagent stack | ✗ 13,657 LOC vs claude's 6,072 | Has legitimate extensions but 5K+ bloat |

**This plan finishes the job in 16 ordered phases.** No partial work. Each
phase has concrete acceptance criteria, precise file targets, and a PR name.
The plan removes ~15,000 more LOC of dead code and adds ~2,000 LOC of real
wiring.

---

## Table of Contents

- [Phase A — Wire the layered compaction into the live loop](#phase-a)
- [Phase B — Implement real parallel tool dispatch](#phase-b)
- [Phase C — Introduce `executeChat()` async generator alongside the class](#phase-c)
- [Phase D — Add streaming event types](#phase-d)
- [Phase E — Migrate all `chatExecutor.execute()` callers to `for await`](#phase-e)
- [Phase F — Delete the old `ChatExecutor` class](#phase-f)
- [Phase G — Unify tool permission evaluator with WebSocket approval flow](#phase-g)
- [Phase H — Delete dead hook event types + fire the real ones](#phase-h)
- [Phase I — Wire reactive compaction on 413 / context_window_exceeded](#phase-i)
- [Phase J — Add cache_control breakpoints on stable prefixes](#phase-j)
- [Phase K — Collapse subagent stack to claude_code-shaped recursive executeChat()](#phase-k)
- [Phase L — Delete runtime-wide dead files (bridges, proof, browser, operator-events)](#phase-l)
- [Phase M — Delete residual planner stub methods from daemon.ts](#phase-m)
- [Phase N — Wire memory/consolidation into the compaction chain](#phase-n)
- [Phase O — Final `tsc --noUnusedLocals` cascade sweep](#phase-o)
- [Phase P — Ship it: rebuild, repack, restart, validate](#phase-p)
- [Appendix A — Deletion manifest](#appendix-a)
- [Appendix B — PR sequence and branch names](#appendix-b)
- [Appendix C — What explicitly stays (AgenC-only surfaces)](#appendix-c)

---

## <a id="phase-a"></a>Phase A — Wire the layered compaction into the live loop

**Goal.** Stop lying about having layered compaction. The files at
`runtime/src/llm/compact/*.ts` (snip, microcompact, autocompact, reactive-compact,
token-count, constants) are structurally correct ports of claude_code's
`services/compact/*`, but **zero of them are imported from chat-executor.ts**.
The runtime currently calls `compactHistoryIntoArtifactContext()` (an older
monolithic path) and the whole `snip → microcompact → autocompact` chain
never runs. This phase wires the chain into the iteration loop in the exact
order claude_code uses.

**Files to modify.**

- `runtime/src/llm/chat-executor.ts` — import the four layers, thread state
  between iterations, invoke in order before every provider call.
- `runtime/src/llm/chat-executor-types.ts` — add `CompactionState` field to
  the iteration context type.
- `runtime/src/llm/prompt-budget.ts` (832 LOC) — remove the ad-hoc
  `compactHistoryIntoArtifactContext()` path once layered chain proves it
  covers the same cases. **Target: delete ~600 LOC, keep the 200 LOC of
  actual budget math that the layered chain reuses.**
- `runtime/src/llm/compact/index.ts` — restore the `applyPerIterationCompaction()`
  orchestrator that I deleted in PR #258 (I deleted it before realizing it was
  the intended wire-up point).

**Concrete wire-up (mirror claude_code/query.ts:395–426):**

```typescript
// At the top of each loop iteration, before the provider call:

let snipTokensFreed = 0;
const snipResult = applySnip({ messages, state: state.snip, nowMs });
if (snipResult.action === "snipped") {
  messages = snipResult.messages;
  state = { ...state, snip: snipResult.state };
  snipTokensFreed = snipResult.tokensFreed;
  yield snipResult.boundaryMessage;
}

const microResult = await applyMicrocompact({ messages, state: state.microcompact, nowMs });
if (microResult.action === "microcompacted") {
  messages = microResult.messages;
  state = { ...state, microcompact: microResult.state };
  yield microResult.boundaryMessage;
}

const autoResult = applyAutocompact({
  messages,
  state: state.autocompact,
  thresholdTokens: autocompactThresholdTokens,
  lastResponseUsage: lastUsage,
  snipTokensFreed,
});
if (autoResult.action === "autocompacted") {
  messages = autoResult.messages;
  state = { ...state, autocompact: autoResult.state };
  yield autoResult.boundaryMessage;
}
```

**Note.** Per-iteration `yield` statements assume Phase C has landed. If
Phase A lands first (it should, so we can validate the chain before the
generator rewrite), the `yield` calls become `emitTrace()` calls and return
through the existing callback surface.

**Acceptance.**

- Every `await provider.chat()` in `chat-executor.ts` is preceded by
  `applySnip → applyMicrocompact → applyAutocompact` on the per-session state.
- `runtime/src/llm/compact/index.ts` re-exports a working
  `applyPerIterationCompaction()`.
- `tsc --noEmit -p runtime/tsconfig.json` clean.
- Unit test `runtime/src/llm/compact/autocompact.test.ts` still passes.
- **New test:** `runtime/src/llm/chat-executor-compaction.test.ts` driving a
  multi-turn session where a snip boundary fires mid-iteration and the
  subsequent provider call sees the pruned tail.

**PR:** `refactor/phase-a-wire-layered-compaction`

---

## <a id="phase-b"></a>Phase B — Implement real parallel tool dispatch

**Goal.** Replace the serial tool dispatch loop in
`chat-executor-tool-loop.ts:973–982` with a real concurrency-safe batch
dispatcher that matches `claude_code/services/tools/toolOrchestration.ts:152–177`.
Currently the `isConcurrencySafe` predicate at line 164 is **telemetry
inventory only** — the tool loop still iterates `for (const toolCall of ctx.response.toolCalls)`.

**Files to modify.**

- `runtime/src/llm/chat-executor-tool-loop.ts` — replace the serial
  `for` loop (lines 973–982) with batch-partitioning + `Promise.all()`
  on the concurrency-safe batches.
- `runtime/src/llm/tool-orchestration.ts` (60 LOC) — expand from predicate
  to real `runTools()` dispatcher mirroring claude_code's 188-LOC version.
- `runtime/src/llm/chat-executor-types.ts` — add `maxConcurrency?: number`
  to the executor config (default 10, matching claude_code).

**Concrete change:**

```typescript
// Before (runtime/src/llm/chat-executor-tool-loop.ts:973–982):
for (const toolCall of ctx.response.toolCalls) {
  const action = await executeSingleToolCall(ctx, toolCall, loopState, config, callbacks);
  if (action === "stop") break;
}

// After:
const batches = partitionToolCalls(
  ctx.response.toolCalls,
  config.isConcurrencySafe ?? (() => false),
);
for (const batch of batches) {
  if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
    const results = await Promise.all(
      batch.toolCalls.map((call) =>
        executeSingleToolCall(ctx, call, loopState, config, callbacks),
      ),
    );
    if (results.some((r) => r === "stop")) break;
  } else {
    for (const call of batch.toolCalls) {
      const action = await executeSingleToolCall(ctx, call, loopState, config, callbacks);
      if (action === "stop") break;
    }
  }
}
```

**Risk.** Tools that mutate shared state (the workspace, the session file,
running desktop handles) must keep `isConcurrencySafe === false`. Default
all tools to `false`; opt-in to `true` only for read-only tools
(`system.readFile`, `system.listDir`, `agenc.*` read queries).

**Acceptance.**

- `chat-executor-tool-loop.ts` uses `Promise.all()` for concurrency-safe
  batches.
- `partitionToolCalls()` is the only place that reads `isConcurrencySafe`.
- `isConcurrencySafe` returns `true` only for a hand-curated allowlist of
  read-only tools in the tool registry; everything else stays serial.
- **New test:** `chat-executor-tool-loop-parallel.test.ts` with 3 read tools
  in a single round verifies they dispatch in parallel (mock provider
  records start/end times).
- Existing tests stay green. Run the full suite.

**PR:** `refactor/phase-b-parallel-tool-dispatch`

---

## <a id="phase-c"></a>Phase C — Introduce `executeChat()` async generator alongside the class

**Goal.** Land a new `async function* executeChat(params)` in
`runtime/src/llm/execute-chat.ts` that mirrors `claude_code/query.ts:219`'s
shape. It runs **in parallel** with the existing `ChatExecutor` class — both
coexist. Phase C does not delete the class; that's Phase F.

**New file.** `runtime/src/llm/execute-chat.ts` (~600 LOC)

**Shape:**

```typescript
export async function* executeChat(
  params: ExecuteChatParams,
): AsyncGenerator<
  | RequestStartEvent
  | StreamEvent
  | AssistantMessage
  | ToolResultMessage
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const ctx = buildExecutionContext(params);
  let state = initialLoopState(params);

  while (true) {
    yield { type: "request_start", requestId: ctx.requestId };

    // Phase A compaction chain
    const { messages: pruned, compactionState, boundaries } = await runCompactionChain(
      state.messages,
      state.compaction,
    );
    state = { ...state, messages: pruned, compaction: compactionState };
    for (const boundary of boundaries) yield boundary;

    // Cache control (Phase J)
    const messagesForAPI = applyCacheControlBreakpoints(pruned);

    // Provider call
    const response = yield* callProviderWithStream(ctx, messagesForAPI);
    if (isTerminal(response)) return response.terminal;

    // Phase B parallel tool dispatch
    const toolResults = yield* dispatchTools(ctx, response.toolCalls);

    state.messages = [...pruned, response.message, ...toolResults];
    state.turnCount += 1;

    if (shouldStop(state, ctx)) {
      return buildTerminal(state, ctx);
    }
  }
}
```

The generator delegates to sub-generators for provider streaming and tool
dispatch. Each sub-generator yields events as they happen, so the caller
receives them incrementally.

**Feature parity with `ChatExecutor.execute()`:** Phase C must keep every
public behavior the class has — provider fallback, stateful responses,
tool_result ordering, abort signals, token budget, request timeout,
economics policy, model routing. The class's private methods become free
functions in `runtime/src/llm/chat-executor-helpers.ts`.

**Implementation rule.** No method on `ChatExecutor` is deleted in Phase C.
The class stays untouched. `executeChat()` uses the same helpers.

**Acceptance.**

- `runtime/src/llm/execute-chat.ts` exports `executeChat()` as an async
  generator.
- All yield event types are declared in Phase D (so Phase D must merge first
  or C+D merge together).
- `tsc --noEmit` clean.
- **New test:** `execute-chat.test.ts` — drives a 3-turn conversation with a
  mock provider and asserts that (a) events are yielded in the right order,
  (b) tools dispatch, (c) the terminal carries the right reason.
- `ChatExecutor.execute()` tests stay green.

**PR:** `refactor/phase-c-executechat-async-generator`

---

## <a id="phase-d"></a>Phase D — Add streaming event types

**Goal.** Define the yield event vocabulary `executeChat()` produces. Mirror
`claude_code/types/message.ts` shapes.

**New file.** `runtime/src/llm/streaming-events.ts`

```typescript
export interface RequestStartEvent {
  readonly type: "request_start";
  readonly requestId: string;
  readonly turnIndex: number;
  readonly timestamp: number;
}

export interface StreamEvent {
  readonly type: "stream_chunk";
  readonly requestId: string;
  readonly content: string;
  readonly toolCalls?: readonly LLMToolCall[];
  readonly done: boolean;
}

export interface AssistantMessage {
  readonly type: "assistant";
  readonly uuid: string;
  readonly content: LLMContentPart[];
  readonly usage?: LLMUsage;
  readonly stopReason?: LLMPipelineStopReason;
}

export interface ToolResultMessage {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

export interface TombstoneMessage {
  readonly type: "tombstone";
  readonly reason: "snip" | "microcompact" | "autocompact" | "reactive_compact";
  readonly tokensFreed: number;
  readonly markedAt: number;
}

export interface ToolUseSummaryMessage {
  readonly type: "tool_use_summary";
  readonly toolCallIds: readonly string[];
  readonly summary: string;
  readonly sessionId: string;
}

export interface Terminal {
  readonly reason:
    | "stop_reason_end_turn"
    | "max_turns_reached"
    | "max_tool_rounds_exceeded"
    | "token_budget_exceeded"
    | "user_abort"
    | "provider_fallback_exhausted"
    | "recovery_exhausted"
    | "context_compaction_failed";
  readonly finalContent: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  readonly durationMs: number;
  readonly error?: Error;
}

export type ExecuteChatYield =
  | RequestStartEvent
  | StreamEvent
  | AssistantMessage
  | ToolResultMessage
  | TombstoneMessage
  | ToolUseSummaryMessage;
```

**Bridge to existing code.** Add adapters in `runtime/src/llm/streaming-bridge.ts`
that translate these events into the current `StreamProgressCallback +
trace events` callbacks. Callers that haven't migrated yet can wrap
`executeChat()` in a bridge function that drains the generator into the
legacy callback shape.

**Acceptance.**

- `runtime/src/llm/streaming-events.ts` defines all 7 event types.
- `runtime/src/llm/streaming-bridge.ts` has `drainToLegacyCallbacks()` and
  `buildChatExecutorResultFromEvents()`.
- Unit tests for the bridge: events in → legacy result out.

**PR:** `refactor/phase-d-streaming-event-types`

---

## <a id="phase-e"></a>Phase E — Migrate all `chatExecutor.execute()` callers to `for await`

**Goal.** Convert every production caller of `ChatExecutor.execute()` to
`for await (const event of executeChat(...))`. One caller per PR for
bisectability.

**Callers identified** (from the daemon-caller-audit subagent):

| # | File | Line | Callsite | Streaming | Notes |
|---|---|---|---|---|---|
| 1 | `daemon-text-channel-turn.ts` | 228 | `const result = await chatExecutor.execute(...)` | No | Reads .content, .toolCalls, .tokenUsage, .stopReason, .stopReasonDetail, .provider, .model, .durationMs, .compacted, .statefulSummary, .toolRoutingSummary, .plannerSummary, .callUsage |
| 2 | `daemon-webchat-turn.ts` | 243 | `const result = await chatExecutor.execute(...)` | **Yes** | Uses `onStreamChunk: sessionStreamCallback` (line 260) + signal abort. Full suite of result reads + hook dispatch on outbound |
| 3 | `voice-bridge.ts` | 780 | `const result = await chatExecutor.execute(...)` | No (explicit comment: floods overlay) | Inside `handleDelegationToolCall()`; persists via `persistDelegationResult()` |
| 4 | `background-run-supervisor.ts` | 3506 | `actorResult = await this.chatExecutor.execute(...)` | No | Inside executeCycle(); reads .content, .toolCalls, .tokenUsage, .completionProgress, .statefulSummary |
| 5 | `autonomous/curiosity.ts` | 134, 199 | Two call sites in `checkCuriosity()` | No | Reads .content only |
| 6 | `autonomous/desktop-executor.ts` | 293, 405 | planResult, actResult | No | Reads .content and .toolCalls |
| 7 | `sub-agent.ts` | 831 | Inside recursive subagent spawn | No | Wrapped in SubAgentManager; will be replaced in Phase K |
| 8 | Eval runners: `pipeline-quality-runner.ts`, `implementation-gate-suite.ts`, `delegated-workspace-gate-suite.ts`, `long-horizon-suite.ts`, `chaos-suite.ts` | various | Benchmark assertions | No | Migrate last |

**Migration pattern for each caller:**

```typescript
// Before
const result = await chatExecutor.execute(params);
processContent(result.content);
logTrace(result.toolCalls);

// After
let finalContent = "";
const allToolCalls: ToolCallRecord[] = [];
let tokenUsage: LLMUsage | undefined;
let terminal: Terminal | undefined;
const generator = executeChat(params);

while (true) {
  const { value, done } = await generator.next();
  if (done) { terminal = value; break; }
  switch (value.type) {
    case "stream_chunk":
      sessionStreamCallback?.(value);
      break;
    case "assistant":
      finalContent = extractText(value.content);
      if (value.usage) tokenUsage = value.usage;
      break;
    case "tool_result":
      allToolCalls.push(toToolCallRecord(value));
      break;
    case "tombstone":
      emitCompactionTrace(value);
      break;
    // ... handle other event types
  }
}

processContent(finalContent);
logTrace(allToolCalls);
```

**One PR per caller.** PR #1 = daemon-text-channel-turn, PR #2 =
daemon-webchat-turn (streaming path), PR #3 = voice-bridge, PR #4 =
background-run-supervisor, PR #5 = autonomous/curiosity + desktop-executor,
PR #6 = eval runners (bulk).

**Acceptance per PR.**

- Target caller uses `for await (const event of executeChat(...))`.
- All result-field reads are preserved via event accumulation.
- `tsc --noEmit` clean.
- Caller's own tests (+ session persistence tests + webchat integration
  tests) stay green.
- Manual smoke test: run a real turn against the daemon via that channel,
  verify trace events land in the right places.

**PR series:** `refactor/phase-e-migrate-<caller>` (6 PRs)

---

## <a id="phase-f"></a>Phase F — Delete the old `ChatExecutor` class

**Goal.** Once every caller uses `executeChat()`, delete the class. This
is the single biggest simplification in the plan.

**Files to delete or shrink.**

| File | Before | After | Action |
|---|---|---|---|
| `runtime/src/llm/chat-executor.ts` | 1,962 LOC | 0 LOC | **DELETE** — replaced by `execute-chat.ts` + `chat-executor-helpers.ts` |
| `runtime/src/llm/chat-executor-recovery.ts` | 1,794 | ~300 | **SHRINK** — recovery logic becomes sub-generators inside `execute-chat.ts` |
| `runtime/src/llm/chat-executor-text.ts` | 929 | ~200 | **SHRINK** — keep only `estimateContentChars` + `parseJsonObjectFromText` |
| `runtime/src/llm/chat-executor-tool-loop.ts` | 1,117 | ~400 | **SHRINK** — loop becomes sub-generator inside `execute-chat.ts` |
| `runtime/src/llm/chat-executor-tool-utils.ts` | 856 | ~300 | **SHRINK** — keep normalizeToolCallArguments and related pure helpers |
| `runtime/src/llm/chat-executor-types.ts` | 749 | ~200 | **SHRINK** — keep ExecuteChatParams, ToolCallRecord; delete ChatExecutorResult (replaced by Terminal) |
| `runtime/src/llm/chat-executor-fallback.ts` | 388 | ~120 | **SHRINK** — keep the cooldown state + policy; integrate with executeChat's provider loop |
| `runtime/src/llm/chat-executor-planner-verifier-loop.ts` | ? | 0 | **DELETE** — planner-verifier loop is fully gone |
| `runtime/src/llm/chat-executor-constants.ts` | 160 | ~80 | **SHRINK** — drop planner-era constants |
| `runtime/src/llm/chat-executor-routing-state.ts` | 92 | 0 | **DELETE** — tool routing is static in claude_code shape |
| `runtime/src/llm/chat-executor-step-utils.ts` | 26 | 0 | **DELETE** if unused post-migration |
| `runtime/src/llm/chat-executor-turn-contracts.ts` | 69 | 0 | **DELETE** — turn contracts are stub-only |

**Target LOC savings:** ~6,500 LOC deleted from the `chat-executor*` family.

**Also delete:** `runtime/src/llm/chat-executor.test.ts` (4,222 LOC) — the
tests were written against the class shape and must be rewritten against
`executeChat()`. The new tests live in `runtime/src/llm/execute-chat.test.ts`.

**Acceptance.**

- No file named `chat-executor.ts` exists.
- `grep -rn "new ChatExecutor\b" runtime/src` returns empty.
- `grep -rn "ChatExecutor\b" runtime/src` returns only type imports that were
  renamed.
- `tsc --noEmit` clean.
- `vitest run` clean modulo the pre-existing marketplace-cli failure.

**PR:** `refactor/phase-f-delete-chat-executor-class`

---

## <a id="phase-g"></a>Phase G — Unify tool permission evaluator with WebSocket approval flow

**Goal.** Collapse the multi-layer permission stack into a single
`ToolPermissionEvaluator` that matches `claude_code`'s `Tool.checkPermissions()`
return shape while keeping AgenC's WebSocket approval escalation.

**Current state.** `runtime/src/policy/tool-permission-evaluator.ts` already
exists and implements most of the 7 stages (deny → allow → per-tool → canUseTool
→ budgets → approval-required → default-allow). What's missing: the
approval-required path is NOT plumbed into `gateway/approvals.ts` — it's a
parallel gate in `tool-handler-factory-delegation.ts`.

**Files to modify.**

- `runtime/src/policy/tool-permission-evaluator.ts` — accept an async
  `approvalRequester` callback that resolves to the approval outcome.
- `runtime/src/gateway/chat-executor-factory.ts` — wire the daemon's
  `ApprovalEngine` into the evaluator via the callback.
- `runtime/src/gateway/tool-handler-factory-delegation.ts` — remove the
  parallel approval gate; let the evaluator own it.
- `runtime/src/gateway/tool-handler-factory.ts` (3,272 LOC) — shrink the
  permission branches; delegate to evaluator.

**Files to delete.**

- `runtime/src/policy/tool-governance.ts` (226 LOC) — superseded by
  `effect-approval-policy.ts`, not called from primary approval path.
- `runtime/src/policy/mcp-governance.ts` (269 LOC) — fold MCP supply-chain
  rules into the unified evaluator's rule list.
- `runtime/src/policy/bundles.ts` (377 LOC) — dead legacy bundling, resolved
  elsewhere.

**Glob matcher consolidation.** Delete the duplicate glob matchers in
`gateway/approvals.ts`, `policy/tool-policy.ts:149–180`, and
`llm/hooks/matcher.ts`. Use `policy/glob.ts:matchGlob()` everywhere.

**Acceptance.**

- One exported function: `evaluateToolPermission(toolName, args, context) →
  { behavior: "allow" | "deny" | "ask", message?, approvalRequestId? }`.
- `grep -rn "matchGlob\|matchesPattern" runtime/src` shows only one matcher
  impl.
- When `behavior === "ask"`, the tool dispatch awaits the WebSocket approval
  response and resumes with allow/deny.
- ~850 LOC deleted across policy/.
- Tests: unit tests for the evaluator cover all 7 stages.

**PR series:**
- `refactor/phase-g1-unify-tool-permission-evaluator`
- `refactor/phase-g2-delete-dead-policy-files`
- `refactor/phase-g3-consolidate-glob-matcher`

---

## <a id="phase-h"></a>Phase H — Delete dead hook event types + fire the real ones

**Goal.** The hook registry at `runtime/src/llm/hooks/types.ts` declares 17
event types mirroring `claude_code/schemas/hooks.ts`, but only
`PreToolUse`, `PostToolUse`, and `PostToolUseFailure` are actually fired
anywhere in the runtime. Decide: delete the dead 14 or wire them up.

**Decision.** Delete the ones that don't serve an AgenC-specific use case.
Wire up the ones that do.

**Delete (8 events):**

- `FileChanged`, `ConfigChange` — AgenC has no watcher that would fire them.
- `SubagentStart`, `SubagentStop` — use `WS_SUBAGENTS_*` WebSocket events
  instead; runtime hooks don't add value.
- `PermissionRequest`, `PermissionDenied` — already handled by the approval
  engine; duplicative.
- `UserPromptSubmit`, `Notification` — CLI-centric; AgenC uses channel
  plugins for user input.

**Wire up (6 events):**

- `SessionStart` — fire from `daemon.ts` when a new session is created.
- `Stop` — fire from `execute-chat.ts` when the generator returns a Terminal.
- `StopFailure` — fire on Terminal.reason === "recovery_exhausted" | "error".
- `PreCompact` — fire from the compaction chain in Phase A, before each layer.
- `PostCompact` — fire from the compaction chain after each layer.
- Keep `PreToolUse`, `PostToolUse`, `PostToolUseFailure` (already live).

**Files to modify.**

- `runtime/src/llm/hooks/types.ts` — remove 8 dead event type members.
- `runtime/src/llm/hooks/dispatcher.ts` — remove dead context shapes.
- `runtime/src/llm/execute-chat.ts` — fire SessionStart, Stop, StopFailure.
- `runtime/src/llm/compact/index.ts` — fire PreCompact, PostCompact.
- `runtime/src/gateway/daemon.ts` — call SessionStart on session creation.

**Acceptance.**

- `grep -rn "HookEvent\." runtime/src` shows only the 9 kept event names.
- Every HookEvent name that exists is fired from at least one production
  site.
- Unit tests verify SessionStart / Stop / PreCompact / PostCompact fire
  correctly.

**PR:** `refactor/phase-h-hook-events-cleanup`

---

## <a id="phase-i"></a>Phase I — Wire reactive compaction on 413 / context_window_exceeded

**Goal.** Implement claude_code's reactive compaction: when a provider returns
a 413 (context too long) error, trim the history and retry up to N times
before bubbling the error.

**Files to modify.**

- `runtime/src/llm/chat-executor-recovery.ts` (will be shrunk in Phase F)
  — add a reactive compaction recovery path that catches the provider error,
  invokes `applyReactiveCompact()`, retries.
- `runtime/src/llm/grok/adapter.ts` — ensure 413 errors are mapped to a
  distinct `LLMProviderError` type the recovery path can recognize.
- `runtime/src/llm/errors.ts` — add `LLMContextWindowExceededError` if not
  present.

**Concrete change:**

```typescript
// In execute-chat.ts error handling:

try {
  const response = yield* callProviderWithStream(ctx, messages);
} catch (err) {
  if (isContextWindowError(err) && !state.hasAttemptedReactiveCompact) {
    const result = applyReactiveCompact({
      messages: state.messages,
      state: state.compaction.reactive,
      trimPercent: 0.25,
    });
    state = {
      ...state,
      messages: result.messages,
      compaction: { ...state.compaction, reactive: result.state },
      hasAttemptedReactiveCompact: true,
    };
    yield result.boundaryMessage;
    continue; // retry
  }
  throw err;
}
```

**Acceptance.**

- 413 errors trigger reactive compaction and retry.
- After N retries (default 3), the error bubbles with a Terminal.reason
  of `"context_compaction_failed"`.
- Unit test with mock provider that returns 413 once, succeeds on retry.

**PR:** `refactor/phase-i-reactive-413-compact`

---

## <a id="phase-j"></a>Phase J — Add cache_control breakpoints on stable prefixes

**Goal.** Claude's API supports `cache_control: { type: "ephemeral" }` markers
that pin prefixes for prompt caching. This reduces cost and latency
significantly on long conversations. AgenC currently sets zero cache_control
markers (`grep -rn cache_control runtime/src` returns zero).

**Files to modify.**

- `runtime/src/llm/messages.ts` — `normalizeMessagesForAPI` should add
  `cache_control: { type: "ephemeral" }` to the last system message, the
  last user message, and the most recent tool_result that survived
  compaction.
- `runtime/src/llm/grok/adapter.ts` — respect the cache_control field in
  request shaping (xAI supports it on Grok 4 models per xAI docs; verify
  with the xAI docs MCP before shipping).
- `runtime/src/llm/ollama/adapter.ts` — pass through or strip silently
  (Ollama ignores it).

**Cache boundary rules** (mirror claude_code's):
1. Pin the system prompt prefix.
2. Pin the first message in the history tail that is not a tool_result.
3. Pin the last microcompact/autocompact boundary if one exists.

**Acceptance.**

- Grok request payloads include `cache_control` at the specified breakpoints.
- Unit test: `normalizeMessagesForAPI` with a synthetic history returns
  messages with cache_control set at the expected positions.
- Live test against the xAI API (dev flag) confirms the request is accepted.

**PR:** `refactor/phase-j-cache-control-breakpoints`

---

## <a id="phase-k"></a>Phase K — Collapse subagent stack to claude_code-shaped recursive executeChat()

**Goal.** AgenC's subagent stack is 13,657 LOC across 20 files. claude_code's
AgentTool is 6,072 LOC. The delta is legitimate AgenC extensions (execution
contract validation, filesystem scope preflight, admission economics,
verification retry loops) that add real value. But ~4,000 LOC is
post-rip-out scar tissue that can be deleted if we collapse the orchestrator
onto a recursive `executeChat()` call.

**New shape.**

```typescript
// runtime/src/gateway/subagent-query.ts (new, ~400 LOC)

export async function* querySubagent(
  spec: SubAgentSpec,
  parentContext: ExecuteChatContext,
): AsyncGenerator<ExecuteChatYield, Terminal> {
  const scope = await preflightDelegatedScope(spec, parentContext);
  if (scope.behavior === "deny") {
    return { reason: "user_abort", error: new Error(scope.reason) };
  }

  const admitted = evaluateAdmission(spec, parentContext);
  if (!admitted.allowed) {
    return { reason: "user_abort", error: new Error(admitted.reason) };
  }

  yield { type: "subagent_start", sessionId: spec.sessionId };

  // Recursive executeChat with restricted tool set + derived context
  const childEvents = executeChat({
    ...parentContext.params,
    sessionId: spec.sessionId,
    messages: buildInitialChildMessages(spec),
    allowedTools: scope.allowedTools,
    toolHandler: wrapHandlerForChildScope(parentContext.toolHandler, scope),
    maxToolRounds: spec.maxToolRounds,
    signal: combineSignals(parentContext.signal, spec.signal),
  });

  const summary: string[] = [];
  for await (const event of childEvents) {
    if (event.type === "assistant") summary.push(extractText(event.content));
    yield event; // bridge to parent stream
  }

  const terminal = childEvents.return; // final Terminal value
  yield { type: "tool_use_summary", toolCallIds: [], summary: summary.join(" "), sessionId: spec.sessionId };

  return terminal;
}
```

**Keep (legitimate AgenC extensions):**

- `runtime/src/utils/delegation-validation.ts` (1,142 LOC) — acceptance
  criteria + evidence validation. No claude_code parallel. **Keep.**
- `runtime/src/gateway/delegated-scope-preflight.ts` (266 LOC) — filesystem
  safety. **Keep.**
- `runtime/src/gateway/delegation-admission.ts` (1,130 LOC) — economics
  gating (fanout, depth, cost). **Keep, shrink to ~600 LOC** by dropping
  stub state.
- `runtime/src/utils/delegation-execution-context.ts` — execution envelope
  derivation. **Keep.**
- `runtime/src/gateway/sub-agent.ts` (1,068 LOC) — spawn, timeout, abort.
  **Shrink to ~300 LOC** as a thin wrapper around `querySubagent()`.

**Delete or collapse:**

- `runtime/src/gateway/subagent-orchestrator.ts` (2,507 LOC) — DAG execution
  becomes recursive `querySubagent()` calls. **Target: delete ~2,000 LOC,
  keep ~500 LOC as a thin coordinator for multi-step plans.**
- `runtime/src/gateway/subagent-prompt-builder.ts` (1,207 LOC) — ~60% mirrors
  claude_code's prompt assembly. **Shrink to ~500 LOC.**
- `runtime/src/gateway/subagent-context-curation.ts` (1,130 LOC) — relevance
  weighting is real; safe-copy layer is dead. **Shrink to ~600 LOC.**
- `runtime/src/gateway/subagent-failure-classification.ts` (404 LOC) —
  retry budget logic is real; regex pattern matching is consolidatable.
  **Shrink to ~200 LOC.**
- `runtime/src/gateway/delegation-economics.ts` (92 LOC) — stub. **DELETE.**
- `runtime/src/gateway/delegation-runtime.ts` (261 LOC) — policy hook
  shim. **DELETE if unused, otherwise shrink to ~80 LOC.**
- `runtime/src/gateway/subagent-infrastructure.ts` (617 LOC) — process
  management. **Shrink to ~200 LOC.**
- `runtime/src/gateway/subagent-workspace-probes.ts` (833 LOC) — real feature
  but narrow callers. **Shrink to ~400 LOC.**
- `runtime/src/gateway/delegation-timeout.ts` (134 LOC) — runtime limits.
  **Shrink to ~50 LOC.**
- `runtime/src/gateway/delegation-scope.ts` (271 LOC) — scope negotiation.
  **Shrink to ~100 LOC.**
- `runtime/src/gateway/tool-handler-factory-delegation.ts` (851 LOC) —
  delegation tool dispatch. **Shrink to ~300 LOC, route through Phase G
  unified evaluator.**
- `runtime/src/utils/delegated-contract-normalization.ts` (234 LOC) —
  contract schema. **Shrink to ~100 LOC.**
- `runtime/src/utils/delegated-scope-trust.ts` (263 LOC) — attestation
  layer. **Shrink to ~100 LOC.**

**Target LOC savings:** ~6,500 LOC deleted across the subagent stack.

**Acceptance.**

- `runtime/src/gateway/subagent-query.ts` exists and is the sole entry point
  for subagent spawn.
- `runtime/src/gateway/subagent-orchestrator.ts` is either deleted or is
  ~500 LOC.
- Subagent tests (`subagent-orchestrator.test.ts`, `sub-agent.test.ts`) are
  rewritten against the new surface and stay green.
- The 4 legitimate extensions (validation, preflight, admission, execution
  context) are still present and wired in.
- Integration test: a subagent spawned from a parent execution sees a
  restricted tool set, completes its objective, and bubbles its events into
  the parent's stream.

**PR series:**
- `refactor/phase-k1-add-subagent-query`
- `refactor/phase-k2-migrate-orchestrator-callers`
- `refactor/phase-k3-delete-subagent-bloat`
- `refactor/phase-k4-shrink-delegation-stack`

---

## <a id="phase-l"></a>Phase L — Delete runtime-wide dead files

**Goal.** Remove files that provide neither an AgenC extension nor a
claude_code alignment.

**Delete.**

- `runtime/src/bridges/` (1,124 LOC) — Farcaster, LangChain, X.402
  integrations. Imported only in `index.ts` barrel; zero calls in daemon
  or tests.
- `runtime/src/proof/` (1,405 LOC) — merkle/zk proof validation. Orphaned
  cache + types; no wiring in daemon or agent flow. (Prover lives in
  `agenc-prover` repo; the runtime copy is a historical fragment.)
- `runtime/src/browser.ts` (105 LOC) — re-export barrel duplicating
  `channels/webchat/protocol.ts`.
- `runtime/src/operator-events.ts` (10 LOC) — empty stub.
- `runtime/src/marketplace/serialization.ts` (508 LOC) — only used by
  `cli/marketplace-cli.ts`. Move it to `cli/marketplace/` or delete if
  the CLI command is dead.

**Also delete** (from audits):

- `runtime/src/llm/prompt-budget.ts` (832 LOC → delete 600) — Phase A
  replaces most of it with the layered chain.
- `runtime/src/llm/chat-executor-routing-state.ts` (92 LOC) — static routing.
- `runtime/src/llm/chat-executor-turn-contracts.ts` (69 LOC) — stub.
- `runtime/src/llm/chat-executor-step-utils.ts` (26 LOC) — if unused post-Phase F.

**Target LOC savings:** ~3,500 LOC.

**Acceptance.**

- `git status --short` shows the deleted paths.
- `tsc --noEmit` clean.
- `grep -rn "from \"../bridges\|from \"../proof\|from \"./browser" runtime/src`
  returns empty.

**PR series:**
- `refactor/phase-l1-delete-bridges-proof`
- `refactor/phase-l2-delete-browser-operator-events`
- `refactor/phase-l3-delete-marketplace-serialization`

---

## <a id="phase-m"></a>Phase M — Delete residual planner stub methods from daemon.ts

**Goal.** Two dead stub methods remain in `daemon.ts` from the planner-era
cleanup. Delete them.

**Files to modify.**

- `runtime/src/gateway/daemon.ts:4724–4733` — `buildToolRoutingDecision()` is
  a planner-era stub that now returns `undefined`. Its callers fall back
  to static allowed tools; the method can be deleted.
- `runtime/src/gateway/daemon.ts:4735–4740` — `recordToolRoutingOutcome()`
  is an empty void. Delete.
- `runtime/src/gateway/channel-wiring.ts` — remove the contract entries
  that advertised these two methods so the wiring shape shrinks.

**Acceptance.**

- Both methods gone.
- `tsc --noEmit` clean.
- `daemon.ts` LOC drops by ~16.

**PR:** `refactor/phase-m-delete-planner-stub-methods-daemon`

---

## <a id="phase-n"></a>Phase N — Wire memory/consolidation into the compaction chain

**Goal.** `runtime/src/memory/consolidation.ts` implements episodic→semantic
memory consolidation (R2/R7-paper style). `claude_code/services/compact/sessionMemoryCompact.ts`
is a compaction optimization. They're conceptually parallel — AgenC can
invoke consolidation as a compaction layer to drop episodic noise while
keeping the semantic takeaways.

**Files to modify.**

- `runtime/src/memory/consolidation.ts` — expose `consolidateEpisodicSlice()`
  that takes a message window and returns a summary message.
- `runtime/src/llm/compact/index.ts` — add a new layer (optional,
  feature-flagged) that invokes consolidation after the autocompact pass.
- `runtime/src/llm/chat-executor.ts` (Phase A wiring site) — thread the
  memory retriever + consolidator into the compaction chain config.

**Acceptance.**

- When memory consolidation is enabled, the compaction chain emits a
  semantic summary message after autocompact fires.
- The summary is persisted to memory so future sessions can recall it.
- Unit test: a multi-turn session with consolidation enabled produces a
  semantic summary entry in the memory backend.

**PR:** `refactor/phase-n-memory-consolidation-as-compaction-layer`

---

## <a id="phase-o"></a>Phase O — Final `tsc --noUnusedLocals` cascade sweep

**Goal.** After Phases A–N, run the whole pipeline once:

1. `npx tsc --noEmit -p runtime/tsconfig.json` → capture every TS6133/TS6192/TS6196
2. Delete the flagged symbols in dependency order.
3. Repeat until clean.
4. Run the full test suite.
5. Grep for remaining `TODO:` + `FIXME:` + `@deprecated` markers that are
   actually actionable.

**This phase is mechanical.** Expect 500–2,000 LOC of cascade deletions
that fall out of the structural rewrites above.

**Acceptance.**

- `tsc --noEmit` clean with zero TS6133/TS6192/TS6196.
- Full vitest run green modulo the pre-existing LiteSVM failure.
- `grep -rn "TODO\|FIXME\|@deprecated" runtime/src --include="*.ts" | grep -v ".test.ts"`
  returns only legitimate forward-looking markers, not broken-rip-out
  residuals.

**PR:** `refactor/phase-o-final-cascade-sweep`

---

## <a id="phase-p"></a>Phase P — Ship it: rebuild, repack, restart, validate

**Goal.** Prove the alignment works on the live daemon.

**Steps.**

1. `npm run build` in `agenc-core` (runs contracts→runtime→mcp→docs-mcp).
2. `npm run build:public-runtime-artifacts` to repack the public tarball
   with a new version.
3. `agenc-runtime stop`, confirm PID gone.
4. `agenc-runtime start` from the new tarball.
5. Rotate `~/.agenc/daemon.errors.log` to get a fresh baseline.
6. Reproduce the real-world workloads that mattered before the sprint:
   - Web chat session with streaming.
   - Concordia run.
   - Sub-agent delegation (pre-Phase K baseline + post-Phase K shape).
   - Background run over 30+ minutes.
7. Diff the new error log against the pre-sprint error catalog. Any error
   class that persists goes back on the backlog.

**Acceptance.**

- Daemon starts cleanly from a newly-built artifact.
- Live workloads run without fresh error classes.
- Error rate over 30 minutes is ≤ the pre-sprint baseline.
- Commit message on the final merge captures the complete LOC delta.

**PR:** `chore/phase-p-rebuild-repack-validate`

---

## <a id="appendix-a"></a>Appendix A — Deletion manifest

### A.1 Files to delete outright

| File | LOC | Phase |
|---|---|---|
| `runtime/src/llm/chat-executor.ts` | 1,962 | F |
| `runtime/src/llm/chat-executor.test.ts` | 4,222 | F (replaced by execute-chat.test.ts) |
| `runtime/src/llm/chat-executor-planner-verifier-loop.ts` | ? | F |
| `runtime/src/llm/chat-executor-routing-state.ts` | 92 | L |
| `runtime/src/llm/chat-executor-step-utils.ts` | 26 | L (if unused) |
| `runtime/src/llm/chat-executor-turn-contracts.ts` | 69 | L |
| `runtime/src/bridges/` (entire dir) | 1,124 | L |
| `runtime/src/proof/` (entire dir) | 1,405 | L |
| `runtime/src/browser.ts` | 105 | L |
| `runtime/src/operator-events.ts` | 10 | L |
| `runtime/src/marketplace/serialization.ts` | 508 | L |
| `runtime/src/gateway/subagent-orchestrator.ts` | 2,507 → ~500 | K |
| `runtime/src/gateway/delegation-economics.ts` | 92 | K |
| `runtime/src/gateway/delegation-runtime.ts` | 261 | K |
| `runtime/src/policy/tool-governance.ts` | 226 | G |
| `runtime/src/policy/mcp-governance.ts` | 269 | G |
| `runtime/src/policy/bundles.ts` | 377 | G |

### A.2 Files to shrink dramatically

| File | From | To | Phase |
|---|---|---|---|
| `runtime/src/llm/chat-executor-recovery.ts` | 1,794 | ~300 | F |
| `runtime/src/llm/chat-executor-text.ts` | 929 | ~200 | F |
| `runtime/src/llm/chat-executor-tool-loop.ts` | 1,117 | ~400 | F |
| `runtime/src/llm/chat-executor-tool-utils.ts` | 856 | ~300 | F |
| `runtime/src/llm/chat-executor-types.ts` | 749 | ~200 | F |
| `runtime/src/llm/chat-executor-fallback.ts` | 388 | ~120 | F |
| `runtime/src/llm/prompt-budget.ts` | 832 | ~200 | A (→ L deletion of residual) |
| `runtime/src/gateway/subagent-prompt-builder.ts` | 1,207 | ~500 | K |
| `runtime/src/gateway/subagent-context-curation.ts` | 1,130 | ~600 | K |
| `runtime/src/gateway/subagent-failure-classification.ts` | 404 | ~200 | K |
| `runtime/src/gateway/subagent-infrastructure.ts` | 617 | ~200 | K |
| `runtime/src/gateway/subagent-workspace-probes.ts` | 833 | ~400 | K |
| `runtime/src/gateway/delegation-admission.ts` | 1,130 | ~600 | K |
| `runtime/src/gateway/tool-handler-factory.ts` | 3,272 | ~1,500 | G |
| `runtime/src/gateway/tool-handler-factory-delegation.ts` | 851 | ~300 | K |
| `runtime/src/utils/delegated-contract-normalization.ts` | 234 | ~100 | K |
| `runtime/src/utils/delegated-scope-trust.ts` | 263 | ~100 | K |

### A.3 New files to add

| File | Phase | Purpose |
|---|---|---|
| `runtime/src/llm/execute-chat.ts` | C | Async generator replacement for ChatExecutor |
| `runtime/src/llm/execute-chat.test.ts` | C | Tests for executeChat |
| `runtime/src/llm/streaming-events.ts` | D | Yield event type vocabulary |
| `runtime/src/llm/streaming-bridge.ts` | D | Legacy-callback bridge during migration |
| `runtime/src/llm/chat-executor-helpers.ts` | F | Free-function helpers extracted from the deleted class |
| `runtime/src/gateway/subagent-query.ts` | K | Recursive executeChat subagent wrapper |

### A.4 LOC ledger (target)

| Phase | Added | Deleted | Net |
|---|---|---|---|
| A (compaction wiring) | +400 | −600 | −200 |
| B (parallel dispatch) | +150 | −50 | +100 |
| C (executeChat generator) | +600 | 0 | +600 |
| D (streaming events) | +250 | 0 | +250 |
| E (caller migration) | +300 | 0 | +300 |
| F (delete ChatExecutor class) | +800 (helpers) | −8,000 | −7,200 |
| G (permission evaluator unify) | +200 | −900 | −700 |
| H (hook events) | +50 | −120 | −70 |
| I (reactive 413) | +200 | 0 | +200 |
| J (cache_control) | +150 | 0 | +150 |
| K (subagent collapse) | +400 | −6,500 | −6,100 |
| L (dead file delete) | 0 | −3,500 | −3,500 |
| M (daemon stubs) | 0 | −16 | −16 |
| N (memory compaction) | +200 | 0 | +200 |
| O (cascade sweep) | 0 | −1,500 (estimated) | −1,500 |

**Total target: +3,700 added, −21,186 deleted = ~−17,500 LOC net**

On top of the ~35,000 LOC already removed in the prior sprint, this brings
the runtime/src/ total from ~260K down to ~210K with every claude_code
feature actually wired in. **Full completion, not partial.**

---

## <a id="appendix-b"></a>Appendix B — PR sequence and branch names

Land in this order. Do not skip ahead — each phase depends on the
preceding one.

1. `refactor/phase-a-wire-layered-compaction`
2. `refactor/phase-b-parallel-tool-dispatch`
3. `refactor/phase-d-streaming-event-types` *(land before C since C depends on the types)*
4. `refactor/phase-c-executechat-async-generator`
5. `refactor/phase-e1-migrate-daemon-text-channel-turn`
6. `refactor/phase-e2-migrate-daemon-webchat-turn`
7. `refactor/phase-e3-migrate-voice-bridge`
8. `refactor/phase-e4-migrate-background-run-supervisor`
9. `refactor/phase-e5-migrate-autonomous-callers`
10. `refactor/phase-e6-migrate-eval-runners`
11. `refactor/phase-f-delete-chat-executor-class`
12. `refactor/phase-g1-unify-tool-permission-evaluator`
13. `refactor/phase-g2-delete-dead-policy-files`
14. `refactor/phase-g3-consolidate-glob-matcher`
15. `refactor/phase-h-hook-events-cleanup`
16. `refactor/phase-i-reactive-413-compact`
17. `refactor/phase-j-cache-control-breakpoints`
18. `refactor/phase-k1-add-subagent-query`
19. `refactor/phase-k2-migrate-orchestrator-callers`
20. `refactor/phase-k3-delete-subagent-bloat`
21. `refactor/phase-k4-shrink-delegation-stack`
22. `refactor/phase-l1-delete-bridges-proof`
23. `refactor/phase-l2-delete-browser-operator-events`
24. `refactor/phase-l3-delete-marketplace-serialization`
25. `refactor/phase-m-delete-planner-stub-methods-daemon`
26. `refactor/phase-n-memory-consolidation-as-compaction-layer`
27. `refactor/phase-o-final-cascade-sweep`
28. `chore/phase-p-rebuild-repack-validate`

**Rule.** Every PR must: pass `tsc --noEmit`, pass `vitest run` (modulo
the pre-existing LiteSVM failure), and preserve the full test baseline
count (any drop must be justified by deletion of dead tests for deleted
code). One PR per phase unless explicitly split above. No partial phases.

---

## <a id="appendix-c"></a>Appendix C — What explicitly stays (AgenC-only surfaces)

These features are AgenC-specific extensions and are **not** touched by any
phase in this plan. Deletion of any of them would regress user-visible
behavior.

- **Channels subsystem** (runtime/src/channels/): WebChat, Telegram,
  Discord, Matrix, Signal, iMessage, WhatsApp plugins. ~14K LOC.
- **WebSocket approval flow** (runtime/src/gateway/approvals.ts): the
  gateway-side approval request/response cycle. Phase G absorbs its gate
  into the unified permission evaluator but keeps the WebSocket plumbing.
- **Background runs supervisor** (runtime/src/gateway/background-run-*):
  long-running autonomous sessions that survive daemon restarts.
- **Concordia bridge** (runtime/src/plugins/channel-host-services.ts +
  agenc-plugin-concordia): simulation framework connection.
- **Skills marketplace** (runtime/src/skills/): manifests, catalog,
  registry, monetization, Jupiter DEX.
- **Protocol integration** (runtime/src/tools/agenc/, task/, dispute/,
  governance/, reputation/, social/): Solana contract handlers.
- **Watch TUI** (runtime/src/bin/agenc-watch + watch-*).
- **Daemon control plane** (runtime/src/gateway/daemon.ts): start/stop/
  restart lifecycle, WebSocket gateway, session management, MCP manager.
- **Memory subsystem** (runtime/src/memory/): persistent vectors, SQLite
  backend, consolidation, identity/beliefs, 3-role retrieval.
- **Observability** (runtime/src/observability/ + replay/): SQLite trace
  store, replay, metrics.
- **Desktop automation** (runtime/src/desktop/): sandbox manager, desktop
  executor, container routing.
- **Eval suite** (runtime/src/eval/): pipeline quality, mutation testing,
  chaos, delegated workspace gates.
- **Autonomous lane** (runtime/src/autonomous/): goal manager, strategic
  memory, curiosity, desktop awareness (minus the deleted verifier lane).

**Touch these only to delete proven dead code inside them.** Never delete
a file that implements one of these surfaces without explicit user
approval.

---

## Success metrics

- **Structural.** `chat-executor.ts` deleted. `runtime/src` total LOC drops
  from ~260K to ~210K. Every compact layer in `llm/compact/*.ts` is
  imported from the live loop. Zero dead exports (`grep` + tsc-unused run
  to confirm).
- **Behavioral.** The daemon runs a streaming web-chat turn end-to-end.
  Reactive compaction recovers from a 413 on the first retry. A subagent
  spawned from a parent bubbles its events into the parent's stream.
  Parallel tools dispatch as a single batch.
- **Operational.** Error rate over a 30-minute live workload ≤ the
  pre-sprint baseline. No new error classes introduced. The Watch TUI
  shows the new event stream correctly.

---

## What this plan explicitly rejects

- **Rewriting the daemon as a stateless CLI.** AgenC is a long-lived
  daemon. Phase C does not change that.
- **Porting claude_code's Ink TUI.** AgenC has Watch TUI. Keep it.
- **Porting claude_code's print/repl modes.** AgenC has WebSocket channels
  and the daemon control plane.
- **Dropping the approval WebSocket flow.** The unified permission
  evaluator absorbs it; it does not replace it.
- **Deleting the background run supervisor.** That's AgenC's crown jewel
  feature.
- **Deleting memory/consolidation.** Phase N wires it in as a compaction
  layer; it becomes strictly more useful.
- **Deleting Concordia, skills, protocol tools, autonomous lane, desktop
  automation, or eval suite.** All AgenC-specific and valuable.

This plan is about making the **core agent loop** behave like claude_code,
not about making AgenC into a claude_code fork. Every phase preserves the
outer surface.
