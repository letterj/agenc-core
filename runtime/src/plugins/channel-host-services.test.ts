import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMemoryBackend, createEmbeddingProvider } = vi.hoisted(() => ({
  createMemoryBackend: vi.fn(),
  createEmbeddingProvider: vi.fn(),
}));

vi.mock("../gateway/memory-backend-factory.js", () => ({
  createMemoryBackend,
}));

vi.mock("../memory/embeddings.js", () => ({
  createEmbeddingProvider,
}));

import { createChannelHostServices } from "./channel-host-services.js";

function makeBackend(label: string) {
  const store = new Map<string, unknown>();
  return {
    label,
    addEntry: vi.fn(),
    getThread: vi.fn().mockResolvedValue([]),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key)),
    listKeys: vi.fn(async (prefix = "") =>
      Array.from(store.keys()).filter((key) => key.startsWith(prefix)),
    ),
  };
}

describe("createChannelHostServices", () => {
  beforeEach(() => {
    createMemoryBackend.mockReset();
    createEmbeddingProvider.mockReset();
    createEmbeddingProvider.mockResolvedValue({
      name: "noop",
      dimension: 1536,
      embed: vi.fn(),
    });
    createMemoryBackend.mockImplementation(async ({ worldId }: { worldId?: string }) =>
      makeBackend(worldId ?? "global"),
    );
  });

  it("returns a world resolver and runtime defaults", async () => {
    const services = createChannelHostServices({
      config: {
        llm: {
          provider: "grok",
          apiKey: "test-key",
          model: "grok-4.20-beta-0309-reasoning",
          baseUrl: "https://api.x.ai/v1",
        },
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(services?.concordia_memory).toBeDefined();
    expect(services?.concordia_runtime?.llm).toEqual({
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4.20-beta-0309-reasoning",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(services?.concordia_runtime?.defaults).toEqual({
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4-1-fast-non-reasoning",
      baseUrl: "https://api.x.ai/v1",
    });

    const world = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    expect(world?.memoryBackend).toBeDefined();
    expect(world?.identityManager).toBeDefined();
    expect(world?.socialMemory).toBeDefined();
    expect(world?.graph).toBeDefined();
    expect(world?.sharedMemory).toBeDefined();
  });

  it("caches the same world context and isolates different worlds", async () => {
    const services = createChannelHostServices({
      config: {
        memory: { backend: "sqlite" },
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const worldOneA = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    const worldOneB = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-1",
      workspaceId: "workspace-1",
    });
    const worldTwo = await services?.concordia_memory?.resolveWorldContext({
      worldId: "world-2",
      workspaceId: "workspace-1",
    });

    expect(worldOneA).toBe(worldOneB);
    expect(worldOneA?.memoryBackend).not.toBe(worldTwo?.memoryBackend);
  });
});
