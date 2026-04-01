/**
 * React hook for real-time simulation state.
 *
 * Connects to:
 * 1. Python EventServer WebSocket (port 3201) for simulation events
 * 2. Bridge HTTP API for agent state and control
 *
 * Phase 4 of the CONCORDIA_TODO.MD implementation plan.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

// ============================================================================
// Types
// ============================================================================

export interface SimulationEvent {
  type: string;
  step: number;
  timestamp: number;
  agent_name?: string;
  content?: string;
  action_spec?: Record<string, unknown>;
  resolved_event?: string;
  scene?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentState {
  identity: {
    name: string;
    personality: string;
    learnedTraits: string[];
    beliefs: Record<string, { belief: string; confidence: number }>;
  } | null;
  memoryCount: number;
  recentMemories: Array<{ content: string; role: string; timestamp: number }>;
  relationships: Array<{
    otherAgentId: string;
    sentiment: number;
    interactionCount: number;
  }>;
  worldFacts: Array<{ content: string; observedBy: string; confirmations: number }>;
  turnCount: number;
  lastAction: string | null;
}

export interface SimulationStatus {
  step: number;
  max_steps: number;
  running: boolean;
  paused: boolean;
  world_id: string;
  agent_count: number;
}

export interface SimulationState {
  events: SimulationEvent[];
  agentStates: Record<string, AgentState>;
  status: SimulationStatus;
  connected: boolean;
  error: string | null;
}

type SimAction =
  | { type: "ADD_EVENT"; event: SimulationEvent }
  | { type: "SET_AGENT_STATE"; agentId: string; state: AgentState }
  | { type: "SET_STATUS"; status: SimulationStatus }
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "CLEAR" };

// ============================================================================
// Reducer
// ============================================================================

const initialState: SimulationState = {
  events: [],
  agentStates: {},
  status: {
    step: 0,
    max_steps: 0,
    running: false,
    paused: false,
    world_id: "",
    agent_count: 0,
  },
  connected: false,
  error: null,
};

function reducer(state: SimulationState, action: SimAction): SimulationState {
  switch (action.type) {
    case "ADD_EVENT":
      return {
        ...state,
        events: [...state.events.slice(-999), action.event],
      };
    case "SET_AGENT_STATE":
      return {
        ...state,
        agentStates: { ...state.agentStates, [action.agentId]: action.state },
      };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_CONNECTED":
      return { ...state, connected: action.connected };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR":
      return initialState;
    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useSimulation(config: {
  eventWsUrl?: string;
  bridgeUrl?: string;
  controlUrl?: string;
  agentIds?: string[];
  pollIntervalMs?: number;
}) {
  const {
    eventWsUrl = "ws://localhost:3201",
    bridgeUrl = "http://localhost:3200",
    controlUrl = "http://localhost:3202",
    agentIds = [],
    pollIntervalMs = 2000,
  } = config;

  const [state, dispatch] = useReducer(reducer, initialState);

  // Poll bridge for simulation events (no separate WebSocket needed)
  const eventIndexRef = useRef(0);

  useEffect(() => {
    let alive = true;

    const pollEvents = async () => {
      if (!alive) return;
      try {
        const resp = await fetch(
          `${bridgeUrl}/simulation/events?since=${eventIndexRef.current}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data.events && Array.isArray(data.events)) {
            for (const evt of data.events) {
              const simEvent: SimulationEvent = {
                type: evt.type?.replace("simulation.", "") ?? "step",
                step: evt.data?.step ?? 0,
                timestamp: evt.data?.timestamp ?? Date.now(),
                agent_name: evt.data?.agentName ?? evt.data?.agent_name,
                content: evt.data?.content,
                resolved_event: evt.data?.resolution,
                metadata: evt.data,
              };
              dispatch({ type: "ADD_EVENT", event: simEvent });
            }
            eventIndexRef.current = data.total ?? eventIndexRef.current;
          }
          dispatch({ type: "SET_CONNECTED", connected: true });
        }
      } catch {
        dispatch({ type: "SET_CONNECTED", connected: false });
      }
    };

    const interval = setInterval(pollEvents, 1000);
    // Initial poll
    void pollEvents();

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [bridgeUrl]);

  // Poll agent states
  useEffect(() => {
    if (agentIds.length === 0) return;

    const interval = setInterval(async () => {
      for (const agentId of agentIds) {
        try {
          const resp = await fetch(`${bridgeUrl}/agent/${agentId}/state`);
          if (resp.ok) {
            const agentState: AgentState = await resp.json();
            dispatch({ type: "SET_AGENT_STATE", agentId, state: agentState });
          }
        } catch {
          // Non-blocking
        }
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [bridgeUrl, agentIds, pollIntervalMs]);

  // Poll simulation status (from bridge on same port as /setup)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${bridgeUrl}/simulation/status`);
        if (resp.ok) {
          const status: SimulationStatus = await resp.json();
          dispatch({ type: "SET_STATUS", status });
        }
      } catch {
        // Non-blocking
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [bridgeUrl, pollIntervalMs]);

  // Control functions (all on bridge URL — no separate control port)
  const play = useCallback(async () => {
    await fetch(`${bridgeUrl}/simulation/play`, { method: "POST" }).catch(() => {});
  }, [bridgeUrl]);

  const pause = useCallback(async () => {
    await fetch(`${bridgeUrl}/simulation/pause`, { method: "POST" }).catch(() => {});
  }, [bridgeUrl]);

  const step = useCallback(async () => {
    await fetch(`${bridgeUrl}/simulation/step`, { method: "POST" }).catch(() => {});
  }, [bridgeUrl]);

  const stop = useCallback(async () => {
    await fetch(`${bridgeUrl}/simulation/stop`, { method: "POST" }).catch(() => {});
  }, [bridgeUrl]);

  return { state, play, pause, step, stop };
}
