# ADR-002 — Remove `requiresUserStop` from `BackgroundRunContract`

## Status

Accepted. Supersedes in part [ADR-001 "Durable task runtime"](./adr-001-durable-task-runtime.md), which listed `requiresUserStop` among the contract fields.

## Context

The `BackgroundRunContract` carried a `requiresUserStop: boolean` field alongside `kind: "finite" | "until_condition" | "until_stopped"`. The two signals tracked 1:1 in production — `requiresUserStop: true` always implied `kind === "until_stopped"` and vice versa — but the boolean was also consulted by an override path in `groundDecision` that converted the actor's `stop_reason: "completed"` text-only responses into `state: "working"`, re-invoking the model without a new input turn.

That override produced a self-feedback loop: the actor's narrative became `run.lastUserUpdate`, which `buildActorPrompt` injected back as `Latest published status:` on the next cycle, which the actor echoed, which became the next `lastUserUpdate`, and so on. One production run reached cycle 80+ emitting the same "Cycle N Status: Tools disabled" narrative without making progress.

PR #438 stripped the override branch and the `EXHAUSTIVE_INTENT_RE` auto-activation that made the override fire for ordinary "implement in full"-style objectives. That fixed the behavioral divergence. The field itself remained on the contract and was still referenced by 18+ runtime consumers, the LLM contract-planner prompt, the operator API, the recent-run snapshot, the web dashboard, and ~102 test fixtures — all of which duplicated the `kind === "until_stopped"` signal already present.

The reference runtime AgenC targets for long-run behavior has no equivalent concept. It treats a text-only model response as terminal for the current loop, and relies on a fresh input turn as the continuation signal. Keeping a contract field with no analogue — and no remaining behavioral effect after PR #438 — produced drift without benefit.

## Decision

Remove `requiresUserStop` from `BackgroundRunContract` end-to-end. Every consumer that previously read it now reads `contract.kind === "until_stopped"` instead.

### Sites collapsed

- Managed-process exit-completion gates (`background-run-supervisor-managed-process.ts`).
- Run-domain `allowsDeterministicCompletion` predicate (`run-domains.ts`).
- Idle-timeout suppression for long-lived runs (`background-run-supervisor.ts`, `background-run-store.ts`, `background-run-supervisor-helpers.ts`).
- Max-runtime and max-cycle budget bypass (`background-run-supervisor.ts`).
- `parseContract` and `buildFallbackContract` no longer set the field.
- `amendRunConstraints` drops the field from both its input parameter shape and the merged contract; legacy payloads with the key are silently ignored.
- Operator DTO (`BackgroundRunOperatorSummary`) and the `BackgroundRunRecentSnapshot` no longer expose the field.
- `buildBackgroundRunExplanation` takes an optional `contractKind` instead of a required boolean; the explanation prose keys on `kind === "until_stopped"`.
- Web dashboard constraint editor removed the "Requires user stop" checkbox.
- LLM contract-planner prompt dropped the field from its JSON schema example so the model does not keep proposing it in new contracts.

### Persistence

`AGENT_RUN_SCHEMA_VERSION` is not bumped. Legacy persisted records that still carry `requiresUserStop: true|false` load cleanly — the key is treated as extra JSON and stripped on next write. Two regression tests in `background-run-store.test.ts` cover:

1. A consistent legacy record (`kind: "until_stopped", requiresUserStop: true`) — loads, field stripped, until-stopped behavior retained via `kind`.
2. An inconsistent legacy record (`kind: "finite", requiresUserStop: true`) — loads, field stripped, the legacy boolean is not consulted; the finite run does not bypass max-runtime/max-cycle.

## Consequences

- Contract schema is smaller and matches the reference-runtime design: no flag that overrides the model's termination signal.
- Operator API response shape loses one key. No external callers identified; the web dashboard is in-repo and was updated in the same PR.
- `amendRunConstraints` input silently ignores `requiresUserStop` so a runtime-ahead / dashboard-behind deploy does not 400.
- The behavioral fix from PR #438 is now also a structural fix: there is no dormant contract field that a future regression could re-activate.

## Related

- ADR-001 "Durable task runtime" — original contract definition.
- PR #436 — anchor files, TUI counter fix, TUI terminal state, zero-tool completion guard.
- PR #438 — removes `EXHAUSTIVE_INTENT_RE` regex and the `groundDecision` override branch (behavioral divergence).
- PR that lands this ADR — completes schema-level parity with the reference runtime.
