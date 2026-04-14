import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import {
  createCreateTaskTool,
  createGetApprovedTaskTemplateTool,
  createListApprovedTaskTemplatesTool,
} from "./tools.js";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("agenc task template tools", () => {
  it("blocks raw agenc.createTask by default", async () => {
    const tool = createCreateTaskTool(
      {
        provider: { publicKey: new PublicKey("11111111111111111111111111111111") },
      } as never,
      createLogger() as never,
    );

    const result = await tool.execute({
      description: "Unsafe raw task",
      reward: "1",
      requiredCapabilities: "1",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      error: expect.stringContaining("Raw agenc.createTask is disabled"),
    });
  });

  it("lists approved task templates", async () => {
    const result = await createListApprovedTaskTemplatesTool(
      createLogger() as never,
    ).execute({});

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content) as { templates: { id: string }[] };
    expect(payload.templates.some((template) => template.id === "runtime-smoke-test")).toBe(true);
  });

  it("fetches a selected approved task template", async () => {
    const result = await createGetApprovedTaskTemplateTool(
      createLogger() as never,
    ).execute({ templateId: "runtime-smoke-test" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      template: { id: "runtime-smoke-test", status: "approved" },
    });
  });
});
