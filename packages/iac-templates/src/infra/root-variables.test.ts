// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript templates.
// A provider whose server module reads a root variable fed from one of its credentials (ADR 0029,
// D11): the root declares it once, never writes its value, and the takeover's `import` id reads it.
// No built-in provider has one yet, so Contabo's definition is faked with one and an `importId`.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { describe, expect, it, vi } from "vitest";
import { testTarget } from "../__fixtures__/layouts";
import { testContext, testPlan } from "../__fixtures__/plans";
import type { RenderedFile } from "../types";
import { splitPlan } from "./__fixtures__/servers";
import { renderInfra, tfvars } from "./index";
import { withServerImports } from "./takeover";

vi.mock("@opscrew/providers", async (original) => {
  const real = await original<typeof import("@opscrew/providers")>();
  const withRootVariable = (provider: CloudProviderDefinition): CloudProviderDefinition =>
    provider.id === "contabo"
      ? {
          ...provider,
          terraform: {
            ...provider.terraform,
            rootVariables: [
              {
                name: "fake_project_id",
                description: "The project the servers are in.",
                fromEnv: provider.credentials.envVars[0] as string,
              },
            ],
            importId: (serverId) => `"\${var.fake_project_id}/${serverId}"`,
          },
        }
      : provider;
  const CLOUD_PROVIDERS = real.CLOUD_PROVIDERS.map(withRootVariable);
  return {
    ...real,
    CLOUD_PROVIDERS,
    cloudProvider: (id: string) =>
      CLOUD_PROVIDERS.find((provider) => provider.id === id) ?? real.cloudProvider(id),
  };
});

const DECLARATION = [
  'variable "fake_project_id" {',
  '  description = "The project the servers are in."',
  "  type        = string",
  "}",
].join("\n");

const file = (files: readonly RenderedFile[], name: string) =>
  files.find((f) => f.path === `opscrew/infra/prod/${name}`)?.content ?? "";

/** How often `variables.tf` declares the root variable. */
const declarations = (files: readonly RenderedFile[]) =>
  file(files, "variables.tf").split('variable "fake_project_id" {').length - 1;

/** The `import { … }` blocks of a root `main.tf`. */
const imports = (text: string) => [...text.matchAll(/^import \{\n[\s\S]*?^\}$/gm)].map((m) => m[0]);

describe("a provider's root variables", () => {
  it("are declared once for two servers of the provider: a string, no default, not sensitive", () => {
    const plan = splitPlan({
      app: { provider: "contabo" },
      servers: [{ name: "db", provider: "contabo" }],
    });
    const files = renderInfra(plan, testContext());
    expect(declarations(files)).toBe(1);
    expect(file(files, "variables.tf")).toContain(`\n\n${DECLARATION}\n`);
  });

  it("are never given a value in terraform.tfvars.json", () => {
    const plan = splitPlan({
      app: { provider: "contabo" },
      servers: [{ name: "db", provider: "contabo" }],
    });
    const files = renderInfra(plan, testContext());
    expect(Object.keys(tfvars(plan, testContext()))).not.toContain("fake_project_id");
    for (const rendered of files.filter((f) => f.path.endsWith(".json"))) {
      expect(rendered.content).not.toContain("fake_project_id");
    }
    expect(files.filter((f) => f.content.includes("fake_project_id")).map((f) => f.path)).toEqual([
      "opscrew/infra/prod/variables.tf",
    ]);
  });

  it("are declared for an extra server alone, beside a cloud server or one the user owns", () => {
    for (const app of ["hetzner", "own"] as const) {
      const plan = splitPlan({
        app: { provider: app },
        servers: [{ name: "db", provider: "contabo" }],
      });
      expect(declarations(renderInfra(plan, testContext()))).toBe(1);
    }
  });

  it("are declared for the previous server during a move", () => {
    const files = renderInfra(
      testPlan({ provider: "hetzner" }),
      testContext({
        layout: {
          server: testTarget("hetzner"),
          previous: testTarget("contabo"),
          live: "server",
          providers: ["hetzner", "contabo"],
        },
      }),
    );
    expect(declarations(files)).toBe(1);
  });

  it("are absent from a root without a server of the provider", () => {
    for (const plan of [
      testPlan({ provider: "hetzner" }),
      splitPlan({ app: { provider: "own" }, servers: [{ name: "db", provider: "digitalocean" }] }),
    ]) {
      const files = renderInfra(plan, testContext());
      expect(files.filter((f) => f.content.includes("fake_project_id"))).toEqual([]);
    }
  });
});

describe("taking over a server of such a provider", () => {
  const plan = splitPlan({
    app: { provider: "contabo" },
    servers: [{ name: "db", provider: "hetzner" }],
  });

  it("writes the provider's import id, and the quoted id for a provider without one", () => {
    const taken = withServerImports(renderInfra(plan, testContext()), plan, [
      { server: "app", id: "4711" },
      { server: "db", id: "99" },
    ]);
    expect(imports(file(taken, "main.tf"))).toEqual([
      'import {\n  to = module.server.contabo_instance.this\n  id = "${var.fake_project_id}/4711"\n}',
      'import {\n  to = module.server_db.hcloud_server.this\n  id = "99"\n}',
    ]);
  });

  it("checks the server id before the provider's import id gets it", () => {
    expect(() =>
      withServerImports(renderInfra(plan, testContext()), plan, [
        { server: "app", id: '1"}\nresource "x" "y" {' },
      ]),
    ).toThrow("is not a server id");
  });
});

// The rendered declaration and `import` block, aimed at a `terraform_data` (the engines' built-in
// provider, no download), plan with the variable's value from `TF_VAR_*` only.
const detected = await detectEngines();

describe("the engines plan the import id from the environment", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!engine)(
      `${name} imports <project>/<id> (skipped when ${name} isn't installed)`,
      async () => {
        const plan = testPlan({ provider: "contabo" });
        const files = withServerImports(renderInfra(plan, testContext()), plan, [
          { server: "app", id: "4711" },
        ]);
        const [block] = imports(file(files, "main.tf"));
        const root = await mkdtemp(join(tmpdir(), `opscrew-root-variables-${name}-`));
        await mkdir(root, { recursive: true });
        await writeFile(
          join(root, "main.tf"),
          [
            DECLARATION,
            "",
            'resource "terraform_data" "this" {}',
            "",
            (block ?? "").replace(/^ {2}to = .*$/m, "  to = terraform_data.this"),
            "",
          ].join("\n"),
        );
        const runner = new NodeCommandRunner();
        const bin = engine?.binary ?? name;
        const init = await runner.run(bin, ["init", "-input=false", "-no-color"], { cwd: root });
        expect(init.exitCode, init.stdout + init.stderr).toBe(0);
        const result = await runner.run(bin, ["plan", "-input=false", "-lock=false", "-no-color"], {
          cwd: root,
          env: { ...process.env, TF_VAR_fake_project_id: "project-under-test" },
        });
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("id=project-under-test/4711");
        expect(result.stdout).toMatch(/1 to import/);
      },
    );
  }
});
