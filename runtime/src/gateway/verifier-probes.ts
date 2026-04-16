/**
 * Verifier-requirement types and the `createVerifierRequirement`
 * factory stub.
 *
 * This module previously shipped the full parent-side verification
 * probe runner — probe descriptor generation, subprocess execution,
 * weak-pass classification, coverage accounting, project profile
 * detection, and the `__agencVerification` result marker. All of that
 * machinery was removed when the runtime verifier spawn + in-loop
 * probe dispatch were stripped from the tool loop and subagent
 * orchestrator.
 *
 * What remains is a minimal surface for consumers that still typecheck
 * against the old verifier shape (delegation-runtime, sub-agent result
 * envelopes, persistent-worker-manager, tool-handler-factory-delegation,
 * delegated-runtime-result):
 *
 * - Type exports: {@link VerifierProfileKind}, {@link VerifierBootstrapSource},
 *   {@link ProjectVerifierBootstrap}, {@link VerifierRequirement},
 *   {@link VerificationProbeDescriptor},
 *   {@link VerificationProbeExecutionResult},
 *   {@link VerificationProbeCoverage}, {@link VerificationProbeVerdict},
 *   {@link VerificationProbeAssessment}.
 * - {@link createVerifierRequirement}: always returns an inert
 *   requirement with `required: false`. The upstream reference runtime
 *   does not spawn a runtime verifier, so the field stays false
 *   regardless of caller input.
 *
 * @module
 */

import type { AcceptanceProbeCategory } from "./subagent-orchestrator-types.js";

export type VerifierProfileKind =
  | "generic"
  | "cli"
  | "api"
  | "browser"
  | "infra";

export type VerifierBootstrapSource = "disabled" | "derived" | "fallback";

export interface ProjectVerifierBootstrap {
  readonly workspaceRoot: string;
  readonly profiles: readonly VerifierProfileKind[];
  readonly source: VerifierBootstrapSource;
  readonly rationale: readonly string[];
}

export interface VerifierRequirement {
  readonly required: boolean;
  readonly profiles: readonly VerifierProfileKind[];
  readonly probeCategories: readonly AcceptanceProbeCategory[];
  readonly mutationPolicy: "read_only_workspace";
  readonly allowTempArtifacts: boolean;
  readonly bootstrapSource: VerifierBootstrapSource;
  readonly rationale: readonly string[];
}

export interface VerificationProbeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly category: AcceptanceProbeCategory;
  readonly profile: VerifierProfileKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly writesTempOnly: boolean;
}

export interface VerificationProbeExecutionResult {
  readonly probeId: string;
  readonly label: string;
  readonly category: AcceptanceProbeCategory;
  readonly profile: VerifierProfileKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly error?: string;
}

export interface VerificationProbeCoverage {
  readonly probeIds: readonly string[];
  readonly categories: readonly AcceptanceProbeCategory[];
  readonly profiles: readonly VerifierProfileKind[];
  readonly weakProbeIds: readonly string[];
  readonly failedProbeIds: readonly string[];
}

export type VerificationProbeVerdict =
  | "pass"
  | "weak_pass"
  | "fail"
  | "not_verification";

export interface VerificationProbeAssessment {
  readonly verdict: VerificationProbeVerdict;
  readonly probeId?: string;
  readonly category?: AcceptanceProbeCategory;
  readonly profile?: VerifierProfileKind;
  readonly command?: string;
  readonly reason?: string;
}

/**
 * Inert verifier-requirement factory. Always returns
 * `{ required: false }` with empty profile / probe lists. Callers
 * (delegation-runtime.resolveVerifierRequirement,
 * shouldVerifySubAgentResult) branch on `required` and skip the
 * verifier path when it is false — which is the permanent post-refactor
 * state.
 */
export function createVerifierRequirement(_params: {
  readonly enabled: boolean;
  readonly requested?: boolean;
  readonly runtimeRequired?: boolean;
  readonly projectBootstrap?: boolean;
  readonly workspaceRoot?: string;
  readonly bootstrapCache?: Map<string, ProjectVerifierBootstrap>;
}): VerifierRequirement {
  return {
    required: false,
    profiles: [],
    probeCategories: [],
    mutationPolicy: "read_only_workspace",
    allowTempArtifacts: true,
    bootstrapSource: "disabled",
    rationale: [
      "verifier runtime removed; all delegated runs complete without parent-side verification",
    ],
  };
}
