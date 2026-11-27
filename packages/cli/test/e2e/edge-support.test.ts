import { deploymentFiles } from "@opscrew/agents";
import { testPlan } from "@opscrew/agents/testing";
import type { EdgeProxy } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { deployCommands, renderContext, withSite } from "./edge-support";

describe("deployCommands", () => {
  it.each(["caddy", "nginx", "openlitespeed"] as const satisfies readonly EdgeProxy[])(
    "extracts the edge start and reload commands from a rendered %s workflow",
    (edge) => {
      const plan = withSite(testPlan(), {
        edge,
        domain: "shop.example.com",
        www: false,
        proxied: false,
      });
      const files = deploymentFiles(plan, renderContext());
      const workflow = files.find((f) => f.path === plan.cicd.workflowPath)?.content ?? "";
      const commands = deployCommands(workflow);
      expect(commands.up).toBe("edge up -d --wait --remove-orphans");
      expect(commands.reload).toContain(`edge exec -T ${edge} `);
      if (edge === "nginx") {
        expect(commands.chown).toBeDefined();
        expect(commands.hasCertificate).toBeDefined();
        expect(commands.certonly).toBeDefined();
        expect(commands.renewBefore).toBeDefined();
      }
    },
  );
});
