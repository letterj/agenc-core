/**
 * Concordia simulation bridge — HTTP API + native simulation engine.
 *
 * Starts an HTTP server on port 3200 for backward compatibility with the
 * Python Concordia engine. Also hosts the native TypeScript simulation
 * engine that runs entirely inside the daemon.
 *
 * Events stream through the daemon's existing WebSocket (port 3100)
 * via broadcastEvent("simulation.*", ...). No extra ports needed.
 *
 * @module
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Logger } from "../utils/logger.js";
import { SimulationEngine } from "./simulation-engine.js";

export interface ConcordiaBridgeConfig {
  readonly enabled?: boolean;
  readonly bridgePort?: number;
}

export interface ConcordiaBridgeContext {
  readonly logger: Logger;
  readonly sendMessage: (sessionId: string, content: string) => Promise<string>;
  readonly broadcastEvent: (eventType: string, data: Record<string, unknown>) => void;
  readonly generateAgents: (count: number, premise: string) => Promise<Array<{
    id: string;
    name: string;
    personality: string;
    goal: string;
  }>>;
}

// ============================================================================
// Bridge
// ============================================================================

export class ConcordiaBridge {
  private httpServer: Server | null = null;
  private readonly engine: SimulationEngine;
  private readonly ctx: ConcordiaBridgeContext;
  private readonly bridgePort: number;
  private readonly logger: Logger;
  private startTime = Date.now();

  constructor(config: ConcordiaBridgeConfig, ctx: ConcordiaBridgeContext) {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.bridgePort = config.bridgePort ?? 3200;

    this.engine = new SimulationEngine({
      sendMessage: ctx.sendMessage,
      broadcastEvent: ctx.broadcastEvent,
      logger: ctx.logger,
    });
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error?.("Concordia bridge error:", err);
        this.sendJson(res, 500, { error: String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(this.bridgePort, "0.0.0.0", () => {
        this.logger.info?.(
          `Concordia bridge on 0.0.0.0:${this.bridgePort} (simulation engine ready)`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = null;
    }
  }

  // ==========================================================================
  // HTTP routing
  // ==========================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const path = req.url ?? "/";

    if (req.method === "GET") {
      if (path === "/health") {
        return this.sendJson(res, 200, {
          status: "ok",
          active_sessions: this.engine.getAgents().length,
          uptime_ms: Date.now() - this.startTime,
          ...this.engine.getStatus(),
        });
      }
      if (path === "/agents") {
        return this.sendJson(res, 200, this.engine.getAgents());
      }
      if (path === "/simulation/status") {
        return this.sendJson(res, 200, this.engine.getStatus());
      }
      if (path.startsWith("/simulation/events")) {
        const url = new URL(path, "http://localhost");
        const since = parseInt(url.searchParams.get("since") ?? "0", 10);
        const events = this.engine.getEventsSince(since);
        return this.sendJson(res, 200, {
          events,
          total: this.engine.eventCount,
        });
      }
      if (path.startsWith("/agent/") && path.endsWith("/state")) {
        const agentId = decodeURIComponent(path.split("/")[2]);
        const state = this.engine.getAgentState(agentId);
        if (state) return this.sendJson(res, 200, state);
        return this.sendJson(res, 404, { error: `Agent ${agentId} not found` });
      }
      return this.sendJson(res, 404, { error: "Not found" });
    }

    if (req.method === "POST") {
      const body = await this.readJson(req);

      if (path === "/setup") {
        const agents = (body.agents as Array<Record<string, string>>) ?? [];
        await this.engine.setup({
          worldId: String(body.world_id ?? body.worldId ?? "default"),
          premise: String(body.premise ?? ""),
          maxSteps: Number(body.max_steps ?? body.maxSteps ?? 20),
          agents: agents.map((a) => ({
            id: a.agent_id ?? a.id ?? "",
            name: a.agent_name ?? a.name ?? "",
            personality: a.personality ?? "",
            goal: a.goal ?? "",
          })),
        });
        await this.engine.start();
        const sessions: Record<string, string> = {};
        for (const a of this.engine.getAgents()) {
          sessions[a.id] = `concordia:${a.id}`;
        }
        return this.sendJson(res, 200, { status: "ok", sessions });
      }
      if (path === "/simulation/play" || path === "/simulation/resume") {
        this.engine.resume();
        return this.sendJson(res, 200, { status: "ok" });
      }
      if (path === "/simulation/pause") {
        this.engine.pause();
        return this.sendJson(res, 200, { status: "ok" });
      }
      if (path === "/simulation/stop") {
        await this.engine.stop();
        return this.sendJson(res, 200, { status: "ok" });
      }
      if (path === "/generate-agents") {
        const count = Math.min(10, Math.max(2, Number(body.count) || 3));
        const premise = String(body.premise ?? "");
        const agents = await this.ctx.generateAgents(count, premise);
        return this.sendJson(res, 200, { agents });
      }
      if (path === "/act") {
        const agentId = String(body.agent_id ?? "");
        const content = String(
          (body.action_spec as Record<string, unknown>)?.call_to_action ?? "",
        );
        const action = await this.ctx.sendMessage(agentId, content);
        return this.sendJson(res, 200, { action });
      }
      if (path === "/observe" || path === "/event" || path === "/reset") {
        return this.sendJson(res, 200, { status: "ok" });
      }

      return this.sendJson(res, 404, { error: "Not found" });
    }

    this.sendJson(res, 405, { error: "Method not allowed" });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }

  private readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(new Error(`Invalid JSON: ${err}`));
        }
      });
      req.on("error", reject);
    });
  }
}
