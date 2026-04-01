import type { GatewayMessage } from "../gateway/message.js";

export const CONCORDIA_SIMULATION_TURN_CONTRACT =
  "concordia_simulation_turn";

export function hasConcordiaSimulationTurnContract(
  metadata?: Readonly<Record<string, unknown>>,
): boolean {
  if (!metadata) return false;
  return (
    metadata.turn_contract === CONCORDIA_SIMULATION_TURN_CONTRACT ||
    metadata.turnContract === CONCORDIA_SIMULATION_TURN_CONTRACT ||
    metadata.concordia_turn_contract === CONCORDIA_SIMULATION_TURN_CONTRACT
  );
}

export function isConcordiaSimulationTurnMessage(
  message: Pick<GatewayMessage, "channel" | "metadata">,
): boolean {
  return (
    message.channel === "concordia" &&
    hasConcordiaSimulationTurnContract(message.metadata)
  );
}
