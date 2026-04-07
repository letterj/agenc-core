/**
 * Planner request-analysis — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 977-LOC planner decision pipeline (structured
 * bullet counting, verification cue detection, complexity scoring,
 * planner routing heuristics, imperative tool extraction, artifact
 * target inference). The planner subsystem has been deleted; every
 * planner decision is now a no-op `shouldPlan: false`. Only the four
 * helpers consumed by chat-executor.ts survive: assessPlannerDecision,
 * extractExplicitDeterministicToolRequirements,
 * extractExplicitSubagentOrchestrationRequirements,
 * requestRequiresToolGroundedExecution.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import type { PlannerDecision } from "./chat-executor-types.js";

export function assessPlannerDecision(
  _plannerEnabled: boolean,
  _messageText: string,
  _history: readonly LLMMessage[],
  _metadata?: unknown,
): PlannerDecision {
  return {
    score: 0,
    shouldPlan: false,
    reason: "planner_disabled",
  };
}

export function requestRequiresToolGroundedExecution(
  _messageText: string,
): boolean {
  return false;
}

export function extractExplicitSubagentOrchestrationRequirements(
  _messageText: string,
): undefined {
  return undefined;
}

export interface ExplicitDeterministicToolRequirements {
  readonly forcePlanner?: boolean;
  readonly toolNames?: readonly string[];
}

export function extractExplicitDeterministicToolRequirements(
  _messageText: string,
  _explicitRequirementToolNames: readonly string[],
  _metadata?: unknown,
): ExplicitDeterministicToolRequirements | undefined {
  return undefined;
}
