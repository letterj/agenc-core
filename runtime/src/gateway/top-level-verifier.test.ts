import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";
import {
  applyLegacyTopLevelVerifier,
  runTopLevelVerifierValidation,
} from "./top-level-verifier.js";
import type { VerifierRequirement } from "./verifier-probes.js";

function createResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "Implemented every requested artifact.",
    provider: "grok",
    usedFallback: false,
    toolCalls: [
      {
        name: "system.writeFile",
        args: { path: "/workspace/src/main.c" },
        result: '{"ok":true}',
        isError: false,
        durationMs: 5,
      },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    runtimeContractSnapshot: createRuntimeContractSnapshot({
      runtimeContractV2: false,
      stopHooksEnabled: false,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: false,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    }),
    turnExecutionContract: {
      version: 1,
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      delegationPolicy: "direct_owner",
      contractFingerprint: "contract-1",
      taskLineageId: "task-1",
    },
    activeTaskContext: {
      version: 1,
      taskLineageId: "task-1",
      contractFingerprint: "contract-1",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
    },
    ...overrides,
  };
}

function createVerifierRequirement(
  overrides: Partial<VerifierRequirement> = {},
): VerifierRequirement {
  return {
    required: true,
    profiles: ["generic"],
    probeCategories: ["build"],
    mutationPolicy: "read_only_workspace",
    allowTempArtifacts: false,
    bootstrapSource: "disabled",
    rationale: ["test requirement"],
    ...overrides,
  };
}

function createVerifierService(
  requirement: VerifierRequirement = createVerifierRequirement(),
) {
  return {
    resolveVerifierRequirement: vi.fn(() => requirement),
    shouldVerifySubAgentResult: vi.fn(() => requirement.required),
  };
}

describe("runTopLevelVerifierValidation", () => {
  it("spawns the verifier worker with grounded read evidence", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-1",
      output: "### Check: build\nResult: FAIL\nVERDICT: FAIL",
      success: false,
      durationMs: 42,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/workspace/src/main.c" },
          result: '{"ok":true}',
          isError: false,
          durationMs: 2,
        },
      ],
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
      agentDefinitions: [
        {
          name: "verify",
          description: "Verification worker",
          model: "inherit",
          tools: ["system.readFile", "system.bash", "verification.runProbe"],
          maxTurns: 8,
          source: "built-in",
          filePath: "/tmp/verify.md",
          body: "Verifier system prompt",
        },
      ],
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Verifier system prompt",
        tools: [
          "system.readFile",
          "verification.runProbe",
          "system.listDir",
          "system.stat",
          "verification.listProbes",
        ],
        structuredOutput: expect.objectContaining({
          enabled: true,
          schema: expect.objectContaining({
            name: "agenc_top_level_verifier_decision",
            strict: true,
          }),
        }),
        requiredToolEvidence: expect.objectContaining({
          executionEnvelope: expect.objectContaining({
            verificationMode: "grounded_read",
            targetArtifacts: ["/workspace/src/main.c"],
          }),
        }),
      }),
    );
    expect(decision.outcome).toBe("retry_with_blocking_message");
    expect(decision.runtimeVerifier.overall).toBe("fail");
    expect(decision.blockingMessage).toContain("Runtime verification blocked completion");
  });

  it("prefers structured verifier verdicts over text parsing", async () => {
    const spawn = vi.fn(async () => "subagent:verify-2");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-2",
      output: "Verifier wrote a long narrative without a VERDICT line.",
      success: false,
      durationMs: 25,
      toolCalls: [],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "fail",
          summary: "Build fails under verifier-run acceptance checks.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
    });

    expect(decision.outcome).toBe("retry_with_blocking_message");
    expect(decision.summary).toContain(
      "Build fails under verifier-run acceptance checks.",
    );
    expect(decision.runtimeVerifier.overall).toBe("fail");
  });

  it("skips verifier workers for non-workflow turns", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "hello",
      result: createResult({
        turnExecutionContract: {
          ...createResult().turnExecutionContract,
          turnClass: "dialogue",
          ownerMode: "none",
          targetArtifacts: [],
        },
      }),
      subAgentManager: { spawn, waitForResult: vi.fn(async () => null) },
      verifierService: createVerifierService(),
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(decision.outcome).toBe("skipped");
    expect(decision.runtimeVerifier.overall).toBe("skipped");
  });

  it("fails closed when runtime-required verifier services are unavailable", async () => {
    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: null,
      verifierService: null,
    });

    expect(decision.outcome).toBe("fail_closed");
    expect(decision.runtimeVerifier.overall).toBe("retry");
    expect(decision.summary).toContain("runtime is unavailable");
  });

  it("blocks PASS verdicts that skip required probe coverage", async () => {
    const spawn = vi.fn(async () => "subagent:verify-coverage");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-coverage",
      output: "All good.\nVERDICT: PASS",
      success: true,
      durationMs: 20,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/workspace/src/main.c" },
          result: '{"ok":true}',
          isError: false,
          durationMs: 2,
        },
      ],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "pass",
          summary: "Verifier thinks the build is correct.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const decision = await runTopLevelVerifierValidation({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(
        createVerifierRequirement({
          profiles: ["generic", "cli"],
          probeCategories: ["build", "smoke"],
        }),
      ),
    });

    expect(decision.outcome).toBe("retry_with_blocking_message");
    expect(decision.summary).toContain("required probe categories");
  });
});

describe("applyLegacyTopLevelVerifier", () => {
  it("downgrades legacy top-level completion when verification fails", async () => {
    const spawn = vi.fn(async () => "subagent:verify-legacy");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-legacy",
      output: "Verifier wrote a long narrative without a VERDICT line.",
      success: false,
      durationMs: 25,
      toolCalls: [],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "fail",
          summary: "Build fails under verifier-run acceptance checks.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const updated = await applyLegacyTopLevelVerifier({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: createVerifierService(),
    });

    expect(updated.completionState).toBe("partial");
    expect(updated.content).toContain(
      "Build fails under verifier-run acceptance checks.",
    );
    expect(updated.stopReasonDetail).toContain("Top-level verifier fail");
    expect(updated.runtimeContractSnapshot?.legacyTopLevelVerifierMode).toBe(
      "applied",
    );
  });
});
