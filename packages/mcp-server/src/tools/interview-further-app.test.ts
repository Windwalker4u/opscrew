import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { addApp } from "@opscrew/agents";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpscrewMcpServer } from "../server";

// Detection as it is, watched: the facts the tool's fallback detected.
vi.mock("@opscrew/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opscrew/detect")>();
  return { ...actual, detectProject: vi.fn(actual.detectProject) };
});

/** The detect fixture of the 0.2.8 report, with the Vite app `apps/pay`. */
const THREE_APPS = fileURLToPath(
  new URL("../../../detect/test/fixtures/monorepo-three-apps/", import.meta.url),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("opscrew_interview_questions for a further app without its analysis", () => {
  it("detects the app's own folder only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-further-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const root = path.join(dir, "repo");
    await materializeFixture(THREE_APPS, root);
    await addApp(root, "pay", "apps/pay");
    const server = createOpscrewMcpServer({
      version: "0.0.0-test",
      env: { OPSCREW_HOME: path.join(dir, "home") },
      fetch: forbiddenFetch,
      runner: new ScriptedRunner(),
      cwd: root,
    });
    const client = new Client({ name: "opscrew-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    vi.mocked(detectProject).mockClear();
    const result = (await client.callTool({
      name: "opscrew_interview_questions",
      arguments: { app: "pay" },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { factsSource: string }).factsSource).toBe("detected");
    expect(vi.mocked(detectProject).mock.calls).toEqual([
      [root, { appDir: "apps/pay", rootFiles: false }],
    ]);
    const facts = (await vi.mocked(detectProject).mock.results[0]?.value) as ProjectFacts;
    expect(facts.envVars.map((variable) => variable.name)).toEqual([
      "VITE_BASE_PATH",
      "VITE_CHECKOUT_URL",
      "VITE_SHOP_ID",
    ]);
    expect(facts.services).toEqual([]);
  });
});
