/**
 * Native TypeScript simulation engine for Concordia-style social simulations.
 *
 * Runs entirely inside the daemon — no Python, no extra ports, no separate
 * processes. Uses the same ChatExecutor as the webchat channel for LLM calls.
 * Events stream through the existing daemon WebSocket via broadcastEvent().
 *
 * Architecture mirrors BackgroundRunSupervisor: setTimeout-based stepping,
 * pause/resume support, event broadcasting through the webchat channel.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface SimulationAgent {
  id: string;
  name: string;
  personality: string;
  goal: string;
  observations: string[];
  turns: number;
  lastAction: string | null;
  relationships: Record<string, { count: number; sentiment: number }>;
}

export interface WorldFact {
  content: string;
  observedBy: string;
  timestamp: number;
}

export interface SimulationConfig {
  worldId: string;
  premise: string;
  maxSteps: number;
  agents: Array<{
    id: string;
    name: string;
    personality: string;
    goal: string;
  }>;
}

export interface SimulationStatus {
  worldId: string;
  step: number;
  maxSteps: number;
  running: boolean;
  paused: boolean;
  agentCount: number;
}

export interface SimulationDeps {
  /** Call the LLM — routes through ChatExecutor (Grok). */
  sendMessage: (sessionId: string, content: string) => Promise<string>;
  /** Broadcast event to all subscribed WebSocket clients. */
  broadcastEvent: (eventType: string, data: Record<string, unknown>) => void;
  logger: Logger;
}

// ============================================================================
// Engine
// ============================================================================

export class SimulationEngine {
  private step = 0;
  private maxSteps = 20;
  private running = false;
  private paused = false;
  private worldId = "";
  private premise = "";
  private turnIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly agents = new Map<string, SimulationAgent>();
  private readonly worldFacts: WorldFact[] = [];
  private readonly agentOrder: string[] = [];
  private readonly eventLog: Array<{ type: string; data: Record<string, unknown> }> = [];
  private readonly deps: SimulationDeps;
  private readonly logger: Logger;

  constructor(deps: SimulationDeps) {
    this.deps = deps;
    this.logger = deps.logger;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async setup(config: SimulationConfig): Promise<void> {
    // Stop any existing simulation
    await this.stop();

    this.step = 0;
    this.maxSteps = config.maxSteps;
    this.worldId = config.worldId;
    this.premise = config.premise;
    this.turnIndex = 0;
    this.agents.clear();
    this.worldFacts.length = 0;
    this.agentOrder.length = 0;

    for (const a of config.agents) {
      this.agents.set(a.id, {
        id: a.id,
        name: a.name,
        personality: a.personality,
        goal: a.goal,
        observations: [],
        turns: 0,
        lastAction: null,
        relationships: {},
      });
      this.agentOrder.push(a.id);
    }

    if (config.premise) {
      this.worldFacts.push({
        content: config.premise,
        observedBy: "GM",
        timestamp: Date.now(),
      });
    }

    this.logger.info?.(
      `Simulation setup: ${config.worldId}, ${config.agents.length} agents, ${config.maxSteps} steps`,
    );

    this.broadcast("simulation.setup", {
      worldId: this.worldId,
      agentCount: this.agents.size,
      maxSteps: this.maxSteps,
      premise: this.premise,
    });
  }

  async start(): Promise<void> {
    if (this.agents.size === 0) return;
    this.running = true;
    this.paused = false;
    this.logger.info?.(`Simulation starting: ${this.worldId}`);
    this.broadcastStatus();

    // Broadcast premise as first event
    this.broadcast("simulation.premise", {
      step: 0,
      content: this.premise,
    });

    this.scheduleNextStep();
  }

  pause(): void {
    if (!this.running) return;
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info?.(`Simulation paused at step ${this.step}`);
    this.broadcastStatus();
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.logger.info?.(`Simulation resumed at step ${this.step}`);
    this.broadcastStatus();
    this.scheduleNextStep();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.paused = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.step > 0) {
      this.logger.info?.(`Simulation stopped at step ${this.step}/${this.maxSteps}`);
      this.broadcast("simulation.complete", {
        step: this.step,
        maxSteps: this.maxSteps,
        worldId: this.worldId,
      });
    }
    this.broadcastStatus();
  }

  getStatus(): SimulationStatus {
    return {
      worldId: this.worldId,
      step: this.step,
      maxSteps: this.maxSteps,
      running: this.running,
      paused: this.paused,
      agentCount: this.agents.size,
    };
  }

  getAgents(): Array<{
    id: string;
    name: string;
    personality: string;
    goal: string;
    turns: number;
    lastAction: string | null;
  }> {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.id,
      name: a.name,
      personality: a.personality,
      goal: a.goal,
      turns: a.turns,
      lastAction: a.lastAction,
    }));
  }

  getAgentState(agentId: string): Record<string, unknown> | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const relationships = Object.entries(agent.relationships).map(
      ([otherId, data]) => ({
        otherAgentId: otherId,
        relationship: "acquaintance",
        sentiment: data.sentiment,
        interactionCount: data.count,
      }),
    );

    return {
      identity: {
        name: agent.name,
        personality: agent.personality,
        learnedTraits: [],
        beliefs: {},
      },
      memoryCount: agent.observations.length,
      recentMemories: agent.observations.slice(-5).map((obs) => ({
        content: obs.slice(0, 200),
        role: "system",
        timestamp: Date.now(),
      })),
      relationships,
      worldFacts: this.worldFacts.slice(-5).map((f) => ({
        content: f.content,
        observedBy: f.observedBy,
        confirmations: 0,
      })),
      turnCount: agent.turns,
      lastAction: agent.lastAction,
    };
  }

  // ==========================================================================
  // Core simulation loop
  // ==========================================================================

  private scheduleNextStep(): void {
    if (!this.running || this.paused) return;
    // 2s between steps for pacing (user can watch in real-time)
    this.timer = setTimeout(() => void this.runStep().catch((err) => {
      this.logger.error?.("Simulation step error:", err);
      this.broadcast("simulation.error", {
        step: this.step,
        error: String(err),
      });
    }), 2000);
  }

  private async runStep(): Promise<void> {
    if (!this.running || this.paused) return;

    this.step++;
    if (this.step > this.maxSteps) {
      await this.stop();
      return;
    }

    this.logger.info?.(`Simulation step ${this.step}/${this.maxSteps}`);

    // 1. Pick the acting agent (round-robin)
    const actorId = this.agentOrder[this.turnIndex % this.agentOrder.length];
    this.turnIndex++;
    const actor = this.agents.get(actorId);
    if (!actor) {
      this.scheduleNextStep();
      return;
    }

    // 2. Generate GM observation for the actor
    const observation = await this.generateObservation(actor);
    if (observation) {
      actor.observations.push(observation);
      if (actor.observations.length > 30) {
        actor.observations.splice(0, actor.observations.length - 30);
      }
      this.broadcast("simulation.observation", {
        step: this.step,
        agentName: actor.name,
        agentId: actor.id,
        content: observation,
      });
    }

    // 3. Get the agent's action
    const action = await this.getAgentAction(actor, observation);
    actor.turns++;
    actor.lastAction = action;
    this.broadcast("simulation.action", {
      step: this.step,
      agentName: actor.name,
      agentId: actor.id,
      content: action,
    });

    // 4. Resolve the event via GM
    const resolution = await this.resolveEvent(actor, action);
    this.broadcast("simulation.resolution", {
      step: this.step,
      agentName: actor.name,
      content: resolution,
    });

    // 5. Track relationships (if resolution mentions other agents)
    this.trackRelationships(actor, resolution);

    // 6. Add to world facts
    this.worldFacts.push({
      content: `${actor.name}: ${action}`,
      observedBy: actor.name,
      timestamp: Date.now(),
    });
    if (this.worldFacts.length > 30) {
      this.worldFacts.splice(0, this.worldFacts.length - 30);
    }

    // 7. Broadcast step complete
    this.broadcastStatus();

    // 8. Schedule next
    this.scheduleNextStep();
  }

  // ==========================================================================
  // LLM calls (via ChatExecutor)
  // ==========================================================================

  private async generateObservation(actor: SimulationAgent): Promise<string> {
    const recentEvents = this.worldFacts.slice(-5).map((f) => f.content).join("\n");
    const prompt = [
      `[Game Master - Observation for ${actor.name}]`,
      `World: ${this.premise}`,
      recentEvents ? `Recent events:\n${recentEvents}` : "",
      `Generate a 1-2 sentence observation that ${actor.name} would notice right now.`,
      `Be specific and vivid. Include sensory details.`,
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.deps.sendMessage(`sim-gm-${this.worldId}`, prompt);
      return response || "The scene continues to unfold around you.";
    } catch {
      return "The scene continues to unfold around you.";
    }
  }

  private async getAgentAction(
    actor: SimulationAgent,
    observation: string,
  ): Promise<string> {
    const recentObs = actor.observations.slice(-3).join("\n");
    const prompt = [
      `[You are ${actor.name}]`,
      `Personality: ${actor.personality}`,
      `Goal: ${actor.goal}`,
      recentObs ? `Recent observations:\n${recentObs}` : "",
      observation ? `Current observation: ${observation}` : "",
      `What do you do next? Respond with a specific action in 1-2 sentences.`,
      `Stay in character. Do not include your name as a prefix.`,
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.deps.sendMessage(
        `sim-agent-${actor.id}-${this.worldId}`,
        prompt,
      );
      // Strip name prefix if included
      let action = response || "considers the situation carefully";
      if (action.startsWith(`${actor.name}: `)) {
        action = action.slice(actor.name.length + 2);
      }
      return action;
    } catch {
      return "considers the situation carefully";
    }
  }

  private async resolveEvent(
    actor: SimulationAgent,
    action: string,
  ): Promise<string> {
    const recentEvents = this.worldFacts.slice(-3).map((f) => f.content).join("\n");
    const prompt = [
      `[Game Master - Event Resolution]`,
      `World: ${this.premise}`,
      recentEvents ? `Recent events:\n${recentEvents}` : "",
      `${actor.name} attempts: ${action}`,
      `What happens as a result? Describe the outcome in 1-2 sentences.`,
      `Be specific. Consider how other characters might react.`,
    ].filter(Boolean).join("\n\n");

    try {
      const response = await this.deps.sendMessage(`sim-gm-${this.worldId}`, prompt);
      return response || `${actor.name}'s action proceeds without incident.`;
    } catch {
      return `${actor.name}'s action proceeds without incident.`;
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private trackRelationships(actor: SimulationAgent, text: string): void {
    const lower = text.toLowerCase();
    for (const [id, agent] of this.agents) {
      if (id === actor.id) continue;
      if (lower.includes(agent.name.toLowerCase()) || lower.includes(id)) {
        if (!actor.relationships[id]) {
          actor.relationships[id] = { count: 0, sentiment: 0 };
        }
        actor.relationships[id].count++;
      }
    }
  }

  /** Get events since a given index (for HTTP polling). */
  getEventsSince(sinceIndex: number): Array<{ type: string; data: Record<string, unknown> }> {
    return this.eventLog.slice(sinceIndex);
  }

  get eventCount(): number {
    return this.eventLog.length;
  }

  private broadcast(eventType: string, data: Record<string, unknown>): void {
    const event = { ...data, timestamp: Date.now() };
    this.eventLog.push({ type: eventType, data: event });
    // Cap at 500 events
    if (this.eventLog.length > 500) {
      this.eventLog.splice(0, this.eventLog.length - 500);
    }
    this.deps.broadcastEvent(eventType, event);
  }

  private broadcastStatus(): void {
    this.broadcast("simulation.status", this.getStatus() as unknown as Record<string, unknown>);
  }
}
