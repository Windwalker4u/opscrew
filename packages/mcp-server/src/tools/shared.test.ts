import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { portainerAddressNames } from "@opscrew/agents";
import { forbiddenFetch, ScriptedRunner } from "@opscrew/agents/testing";
import { CONNECTION_HINT, OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { runTool, withoutPortainer } from "./shared";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The text of a tool call that fails with `error`, in a server started with `env`. */
async function failedText(env: Record<string, string>, error: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-shared-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env: { OPSCREW_HOME: path.join(dir, "home"), ...env },
    fetch: forbiddenFetch,
    runner: new ScriptedRunner(),
    cwd: dir,
  });
  const result: CallToolResult = await runTool(deps, "opscrew_test", undefined, async () => {
    throw error;
  });
  expect(result.isError).toBe(true);
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

const CODEX = { OPSCREW_MCP_CLIENT: "codex" };
/** How the API clients report a provider they couldn't reach. */
const UNREACHABLE = new OpsCrewError("PROVIDER_ERROR", "Could not reach the Hetzner Cloud API.", {
  hint: CONNECTION_HINT,
});
const UNREACHABLE_TEXT = `Could not reach the Hetzner Cloud API.\n\nNext step: ${CONNECTION_HINT}`;

describe("runTool, when the network can't be reached", () => {
  it("under Codex, adds a sentence on Codex's sandbox settings", async () => {
    const text = await failedText(CODEX, UNREACHABLE);
    expect(text.startsWith(`${UNREACHABLE_TEXT} `)).toBe(true);
    expect(text).toContain("`[sandbox_workspace_write]` `network_access`");
    expect(text).toContain("`sandbox_mode`");
    // A hint a tool put in its place keeps the cause; a bare failure of fetch has its code.
    const rehinted = new OpsCrewError("PROVIDER_ERROR", "x", { hint: "y", cause: UNREACHABLE });
    expect(await failedText(CODEX, rehinted)).toContain("[sandbox_workspace_write]");
    const lookup = Object.assign(new Error("getaddrinfo ENOTFOUND api.osv.dev"), {
      code: "ENOTFOUND",
    });
    const fetchFailed = new TypeError("fetch failed", { cause: lookup });
    expect(await failedText(CODEX, fetchFailed)).toContain("[sandbox_workspace_write]");
  });

  it("leaves the message as it was outside Codex, and for any other error", async () => {
    expect(await failedText({}, UNREACHABLE)).toBe(UNREACHABLE_TEXT);
    expect(await failedText({ OPSCREW_MCP_CLIENT: "other" }, UNREACHABLE)).toBe(UNREACHABLE_TEXT);
    const other = new OpsCrewError("INVALID_INPUT", "Not a plan.", { hint: "Run opscrew plan." });
    expect(await failedText(CODEX, other)).toBe("Not a plan.\n\nNext step: Run opscrew plan.");
  });
});

describe("withoutPortainer", () => {
  it("with the host `portainer`, replaces its address but never the product's own name", () => {
    const names = portainerAddressNames("https://portainer:9443");
    const text = [
      "Connected to https://portainer:9443/api and PORTAINER:9443.",
      "Answer portainer.url and portainer.environment.",
      "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
      "Host: Portainer.",
      "Nothing in your Portainer changed.",
    ].join("\n");
    expect(withoutPortainer(text, names)).toBe(
      [
        "Connected to your Portainer/api and your Portainer.",
        "Answer portainer.url and portainer.environment.",
        "Removed the stack opscrew-shop-portainer-tunnel and opscrew_portainer_x.",
        "Host: Portainer.",
        "Nothing in your Portainer changed.",
      ].join("\n"),
    );
  });

  it("with the host `nas`, replaces a whole host name, case-insensitively", () => {
    const names = portainerAddressNames("https://nas:9443");
    expect(
      withoutPortainer(
        "Portainer on nas (https://NAS:9443/api, nas:8000); kept nas.url, opscrew-shop-nas-tunnel, nas.lan.",
        names,
      ),
    ).toBe(
      "Portainer on your Portainer (your Portainer/api, your Portainer:8000); kept nas.url, opscrew-shop-nas-tunnel, nas.lan.",
    );
  });

  it("with the host `nas`, replaces it after a colon and in URL-encoded form", () => {
    const names = portainerAddressNames("https://nas:9443");
    expect(
      withoutPortainer("DNS:nas; u=https%3A%2F%2Fnas%3A9443; e=user%40nas; [REDACTED:nas]", names),
    ).toBe("DNS:your Portainer; u=your Portainer; e=user%40your Portainer; [REDACTED:nas]");
  });

  it("replaces a dotted host name only as a whole name", () => {
    const names = portainerAddressNames("https://nas.lan:9443");
    expect(withoutPortainer("at nas.lan, not shop.nas.lan or nas.lan.example", names)).toBe(
      "at your Portainer, not shop.nas.lan or nas.lan.example",
    );
  });
});
