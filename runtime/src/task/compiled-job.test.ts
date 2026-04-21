import { describe, expect, it } from "vitest";
import {
  compileResolvedMarketplaceTaskJob,
  COMPILED_JOB_POLICY_VERSION,
} from "./compiled-job.js";
import type { ResolvedOnChainTaskJobSpec } from "../marketplace/task-job-spec.js";

function createResolvedJobSpec(
  custom: Record<string, unknown>,
): ResolvedOnChainTaskJobSpec {
  return {
    taskPda: "Task11111111111111111111111111111111111111111",
    taskJobSpecPda: "TaskJobSpec1111111111111111111111111111111",
    creator: "Creator111111111111111111111111111111111111",
    jobSpecHash: "a".repeat(64),
    jobSpecUri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
    createdAt: 1_776_124_800,
    updatedAt: 1_776_124_900,
    bump: 255,
    jobSpecPath: "/tmp/job-spec.json",
    integrity: {
      algorithm: "sha256",
      canonicalization: "json-stable-v1",
      payloadHash: "a".repeat(64),
      uri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
    },
    envelope: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpecEnvelope",
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: "a".repeat(64),
        uri: `agenc://job-spec/sha256/${"a".repeat(64)}`,
      },
      payload: {
        schemaVersion: 1,
        kind: "agenc.marketplace.jobSpec",
        title: "Compiled test job",
        shortDescription: "Compiled test job",
        fullDescription: "Run the approved bounded workflow.",
        acceptanceCriteria: ["Return the approved output only."],
        deliverables: ["Structured output"],
        constraints: null,
        attachments: [{ uri: "https://example.com/brief" }],
        custom,
        context: {},
      },
    },
    payload: {
      schemaVersion: 1,
      kind: "agenc.marketplace.jobSpec",
      title: "Compiled test job",
      shortDescription: "Compiled test job",
      fullDescription: "Run the approved bounded workflow.",
      acceptanceCriteria: ["Return the approved output only."],
      deliverables: ["Structured output"],
      constraints: null,
      attachments: [{ uri: "https://example.com/brief" }],
      custom,
      context: {},
    },
  };
}

describe("compileResolvedMarketplaceTaskJob", () => {
  it("compiles bounded task template requests into a canonical runtime plan", () => {
    const compiled = compileResolvedMarketplaceTaskJob(
      createResolvedJobSpec({
        kind: "agenc.web.boundedTaskTemplateRequest",
        templateId: "web_research_brief",
        templateVersion: 1,
        goal: "Research AI meeting assistants.",
        sourcePolicy: "Allowlisted public web only",
        outputFormat: "markdown brief",
        inputs: {
          topic: "AI meeting assistants",
          sources: "company websites and public news",
        },
      }),
    );

    expect(compiled.jobType).toBe("web_research_brief");
    expect(compiled.policy.riskTier).toBe("L0");
    expect(compiled.policy.allowedTools).toEqual(
      expect.arrayContaining(["fetch_url", "generate_markdown", "cite_sources"]),
    );
    expect(compiled.policy.allowedDomains).toEqual(["https://example.com"]);
    expect(compiled.audit.compilerVersion).toBe(
      "agenc.web.bounded-task-template.v1",
    );
    expect(compiled.audit.policyVersion).toBe(COMPILED_JOB_POLICY_VERSION);
  });

  it("compiles approved templates into the same canonical runtime plan shape", () => {
    const compiled = compileResolvedMarketplaceTaskJob(
      createResolvedJobSpec({
        approvedTemplate: {
          id: "documentation-review",
          version: 1,
          title: "Documentation review",
          hash: "b".repeat(64),
        },
        trustedInstructions: [
          "Review only the requested documentation target.",
        ],
        untrustedVariables: {
          documentPath: "README.md",
          focus: "unsafe instructions",
        },
      }),
    );

    expect(compiled.jobType).toBe("documentation-review");
    expect(compiled.policy.allowedTools).toEqual([
      "read_workspace",
      "generate_markdown",
    ]);
    expect(compiled.untrustedInputs).toEqual({
      documentPath: "README.md",
      focus: "unsafe instructions",
    });
    expect(compiled.audit.sourceKind).toBe(
      "agenc.marketplace.approvedTemplate",
    );
  });

  it("fails closed on unsupported compiled job types", () => {
    expect(() =>
      compileResolvedMarketplaceTaskJob(
        createResolvedJobSpec({
          kind: "agenc.web.boundedTaskTemplateRequest",
          templateId: "unknown_task_type",
          templateVersion: 1,
          goal: "Do something unsupported",
          outputFormat: "markdown",
          inputs: {},
        }),
      ),
    ).toThrow(/Unsupported compiled job type/);
  });
});
