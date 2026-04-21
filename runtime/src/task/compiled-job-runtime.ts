import type { ChatExecuteParams } from "../llm/chat-executor-types.js";
import type { LLMTool, ToolHandler } from "../llm/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import {
  createCompiledJobPolicyEngine,
  type CompiledJobEnforcement,
} from "./compiled-job-enforcement.js";

export interface CompiledJobScopedTooling {
  readonly allowedToolNames: readonly string[];
  readonly missingToolNames: readonly string[];
  readonly llmTools: readonly LLMTool[];
  readonly toolHandler: ToolHandler;
}

export interface CompiledJobExecutionRuntime {
  readonly enforcement: CompiledJobEnforcement;
  buildScopedTooling(
    registry: ToolRegistry,
    logger?: Logger,
  ): CompiledJobScopedTooling;
  applyChatExecuteParams(params: ChatExecuteParams): ChatExecuteParams;
}

export function createCompiledJobExecutionRuntime(
  enforcement: CompiledJobEnforcement,
): CompiledJobExecutionRuntime {
  return {
    enforcement,
    buildScopedTooling(
      registry: ToolRegistry,
      logger: Logger = silentLogger,
    ): CompiledJobScopedTooling {
      const scopedRegistry = new ToolRegistry({
        logger,
        policyEngine: createCompiledJobPolicyEngine(enforcement, logger),
      });
      const missingToolNames: string[] = [];

      for (const toolName of enforcement.allowedRuntimeTools) {
        const tool = registry.get(toolName);
        if (!tool) {
          missingToolNames.push(toolName);
          continue;
        }
        scopedRegistry.register(tool);
      }

      const allowedToolNames = scopedRegistry.listNames();
      return {
        allowedToolNames,
        missingToolNames,
        llmTools: scopedRegistry.toLLMTools(),
        toolHandler: scopedRegistry.createToolHandler(),
      };
    },
    applyChatExecuteParams(params: ChatExecuteParams): ChatExecuteParams {
      return {
        ...params,
        maxToolRounds: capRuntimeLimit(
          params.maxToolRounds,
          enforcement.chat.maxToolRounds,
        ),
        toolBudgetPerRequest: capRuntimeLimit(
          params.toolBudgetPerRequest,
          enforcement.chat.toolBudgetPerRequest,
        ),
        requestTimeoutMs: capRuntimeLimit(
          params.requestTimeoutMs,
          enforcement.chat.requestTimeoutMs,
        ),
        contextInjection: {
          skills: mergeBooleanGate(
            params.contextInjection?.skills,
            enforcement.chat.contextInjection?.skills,
          ),
          memory: mergeBooleanGate(
            params.contextInjection?.memory,
            enforcement.chat.contextInjection?.memory,
          ),
        },
        toolRouting: mergeToolRouting(params.toolRouting, enforcement),
        requiredToolEvidence: mergeRequiredToolEvidence(
          params.requiredToolEvidence,
          enforcement.chat.requiredToolEvidence,
        ),
      };
    },
  };
}

function mergeRequiredToolEvidence(
  base: ChatExecuteParams["requiredToolEvidence"],
  enforced: ChatExecuteParams["requiredToolEvidence"],
): ChatExecuteParams["requiredToolEvidence"] {
  if (!base && !enforced) return undefined;

  return {
    ...(base?.maxCorrectionAttempts !== undefined
      ? { maxCorrectionAttempts: base.maxCorrectionAttempts }
      : {}),
    ...(base?.delegationSpec ? { delegationSpec: base.delegationSpec } : {}),
    ...(base?.unsafeBenchmarkMode !== undefined
      ? { unsafeBenchmarkMode: base.unsafeBenchmarkMode }
      : {}),
    ...(base?.verificationContract
      ? { verificationContract: base.verificationContract }
      : {}),
    ...(base?.completionContract
      ? { completionContract: base.completionContract }
      : {}),
    ...(base?.executionEnvelope ?? enforced?.executionEnvelope
      ? {
          executionEnvelope:
            base?.executionEnvelope ?? enforced?.executionEnvelope,
        }
      : {}),
  };
}

function mergeToolRouting(
  base: ChatExecuteParams["toolRouting"],
  enforcement: CompiledJobEnforcement,
): ChatExecuteParams["toolRouting"] {
  const allowed = enforcement.chat.toolRouting?.advertisedToolNames?.length
    ? [...enforcement.chat.toolRouting.advertisedToolNames]
    : [...enforcement.allowedRuntimeTools];
  const allowedSet = new Set(allowed);
  const filterAllowed = (names: readonly string[] | undefined): string[] =>
    uniqueToolNames(
      (names ?? []).filter((toolName) => allowedSet.has(toolName)),
    );

  const advertisedToolNames = (() => {
    const filteredBase = filterAllowed(base?.advertisedToolNames);
    return filteredBase.length > 0 ? filteredBase : allowed;
  })();
  const advertisedSet = new Set(advertisedToolNames);
  const filterAdvertised = (names: readonly string[] | undefined): string[] =>
    uniqueToolNames(
      (names ?? []).filter((toolName) => advertisedSet.has(toolName)),
    );
  const routedToolNames = (() => {
    const filteredBase = filterAdvertised(base?.routedToolNames);
    if (filteredBase.length > 0) return filteredBase;
    const enforcedRouted = filterAdvertised(
      enforcement.chat.toolRouting?.routedToolNames,
    );
    return enforcedRouted.length > 0 ? enforcedRouted : advertisedToolNames;
  })();
  const expandedToolNames = (() => {
    const filteredBase = filterAdvertised(base?.expandedToolNames);
    if (filteredBase.length > 0) return filteredBase;
    const enforcedExpanded = filterAdvertised(
      enforcement.chat.toolRouting?.expandedToolNames,
    );
    return enforcedExpanded.length > 0 ? enforcedExpanded : routedToolNames;
  })();

  return {
    advertisedToolNames,
    routedToolNames,
    expandedToolNames,
    expandOnMiss:
      base?.expandOnMiss === true &&
      enforcement.chat.toolRouting?.expandOnMiss === true,
    persistDiscovery:
      base?.persistDiscovery === true &&
      enforcement.chat.toolRouting?.persistDiscovery === true,
  };
}

function capRuntimeLimit(
  requested: number | undefined,
  enforced: number | undefined,
): number | undefined {
  if (enforced === undefined) return requested;
  if (requested === undefined || requested <= 0) return enforced;
  return Math.min(requested, enforced);
}

function mergeBooleanGate(
  requested: boolean | undefined,
  enforced: boolean | undefined,
): boolean | undefined {
  if (requested === false || enforced === false) return false;
  if (requested === true || enforced === true) return true;
  return undefined;
}

function uniqueToolNames(input: readonly string[]): string[] {
  return [...new Set(input)];
}
