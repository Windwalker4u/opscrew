import { readFile } from "node:fs/promises";
import { type AppRecord, type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { edgeMemoryMb } from "@opscrew/iac-templates";
import {
  type Architecture,
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { serverAddressesFile } from "../shared";
import { appMemoryMb } from "../shared/memory";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import { hostDescription } from "../shares/first-app";
import {
  createdServerFacts,
  FakeHostServer,
  makeRequirements,
  ScriptedRunner,
  SERVER_IPV4,
  type SharedServerProject,
  secondAppRecord,
  sharedServerProject,
  staticSpaFacts,
  testPlan,
} from "../testing";
import { sharedAccessWarning } from "./own";
import { onAppServer } from "./placement";
import { runDesign } from "./run";

const DOMAIN = "landing.example.com";
const NOW = new Date("2026-11-19T12:00:00.000Z");

/** Cloudflare's IP ranges, as its public endpoint answers them. */
const cloudflareRanges: PhaseDeps["fetch"] = async (input) => {
  if (String(input) !== "https://api.cloudflare.com/client/v4/ips") {
    throw new Error(`Unexpected network call in a test: ${String(input)}`);
  }
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result: { ipv4_cidrs: ["173.245.48.0/20"], ipv6_cidrs: ["2400:cb00::/32"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

/** The project's runner with a GitHub origin and no network: `git ls-remote` fails. */
function withGitHub(base: PhaseDeps["runner"]): ScriptedRunner {
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "git" && args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/example/landing.git\n", stderr: "" };
    }
    if (command === "git" && args.includes("ls-remote")) {
      return { exitCode: 128, stdout: "", stderr: "no network in tests" };
    }
    return base.run(command, args, options);
  });
}

/** The deploy login's shell on the fake server: every command it runs answers nothing. */
const shell = (connection: { host: string }): RemoteExec => ({
  host: connection.host,
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
});

interface SecondApp extends SharedServerProject {
  server: FakeHostServer;
}

/**
 * A second app, the static site `landing` at `landing.example.com` (on Cloudflare unless
 * `requirements` says otherwise), beside the first app `shop` (`plan`) on its server, which holds
 * the other apps' `records` and `memoryGb` of memory (4 by default).
 */
async function secondApp(
  o: {
    plan?: DeployPlan;
    records?: AppRecord[];
    facts?: HostFacts;
    memoryGb?: number;
    requirements?: Partial<Requirements>;
    appFacts?: ProjectFacts;
  } = {},
): Promise<SecondApp> {
  const project = await sharedServerProject(o.plan === undefined ? {} : { plan: o.plan });
  const { deps } = project;
  deps.runner = withGitHub(deps.runner);
  deps.fetch = cloudflareRanges;
  deps.clock = { now: () => NOW };
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-11-19T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: o.appFacts ?? staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  const { region: _region, ...base } = makeRequirements();
  await writeArtifact("requirements", deps.paths.files.requirements, {
    ...base,
    provider: "own",
    domain: DOMAIN,
    dnsProvider: "cloudflare",
    ...o.requirements,
  });
  const facts = o.facts ?? createdServerFacts(o.records ?? []);
  const server = new FakeHostServer(
    HostFactsSchema.parse({ ...facts, memoryBytes: (o.memoryGb ?? 4) * 1024 ** 3 }),
  );
  return { ...project, server };
}

/** Design as the CLI runs it: the server read first, then design. */
async function design(app: SecondApp) {
  const ownServer = await inspectOwnServerForDesign(app.deps, {
    services: { remote: shell, host: app.server },
  });
  return runDesign(app.deps, { ownServer });
}

/** The error `promise` ends with. */
async function failure(promise: Promise<unknown>): Promise<Error & { code: string; hint: string }> {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (thrown: unknown) => thrown as Error & { code: string; hint: string },
  );
}

/** The refusal (`code`) `promise` ends with, before anything was written. */
async function refusal(app: SecondApp, promise: Promise<unknown>, code = "PHASE_PRECONDITION") {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown as Error & { code?: string; hint?: string },
  );
  expect(error).toMatchObject({ code });
  await expect(readFile(app.deps.paths.files.plan, "utf8")).rejects.toThrow();
  expect(app.server.applies).toEqual([]);
  return error as Error & { code: string; hint: string };
}

/** Everything the fakes saw and design wrote. */
async function seen(app: SecondApp): Promise<string> {
  const { deps } = app;
  const read = (file: string) => readFile(file, "utf8").catch(() => "");
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify((deps.runner as ScriptedRunner).calls),
    await read(deps.paths.files.plan),
    await read(deps.paths.files.requirements),
    await read(serverAddressesFile(deps.paths)),
    JSON.stringify(await deps.state.read()),
  ].join("\n");
}

describe("design for a second app on the server of another app", () => {
  it("writes the target beside the first app, with no price and the shared-access warning", async () => {
    const app = await secondApp({ records: [secondAppRecord()] });
    const result = await design(app);
    expect(result.plan.target).toEqual({
      provider: "own",
      mode: "vps-compose",
      arch: "amd64",
      access: "public",
      edge: "caddy",
      shares: { app: "shop", provider: "hetzner" },
    });
    // Served as the first app is: behind Cloudflare's proxy, which its firewall lets in alone.
    expect(result.plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: DOMAIN,
      proxied: true,
    });
    expect(result.plan.security.httpAllowedFrom).toBe("edge");
    expect(result.options).toHaveLength(1);
    expect(result.chosen).toMatchObject({
      title: 'Beside "shop" on its Hetzner Cloud server',
      cost: { monthly: { amount: 0 } },
    });
    expect(result.plan.cost.monthly.amount).toBe(0);
    const warning = sharedAccessWarning("shop");
    expect(result.chosen.summary).toContain(warning);
    // Said once in the summary and once as a warning, not again among the trade-offs.
    expect(result.chosen.tradeoffs).not.toContain(warning);
    expect(result.chosen.summary).toContain("The Hetzner Cloud server OpsCrew created for");
    expect(result.chosen.summary).toMatch(/"shop" \d+ MB, "inventory" 512 MB/);
    expect(result.warnings).toContain(warning);
    const said = app.deps.reporter.text();
    expect(said).toContain(warning);
    expect(said).toContain(`no server cost (the server is "shop"'s)`);
    expect(said).toMatch(/Memory limits: .*"shop" \d+ MB, "inventory" 512 MB; .* free\./);
    expect(app.server.applies).toEqual([]);
    expect(await readArtifact("plan", app.deps.paths.files.plan)).toEqual(result.plan);
    // A design with nothing changed leaves the plan as it is.
    const again = await design(app);
    expect(again.plan).toEqual(result.plan);
    const all = await seen(app);
    expect(all).not.toContain(app.firstKey);
    for (const text of [said, await readFile(app.deps.paths.files.plan, "utf8")]) {
      expect(text).not.toContain(SERVER_IPV4);
      expect(text).not.toContain(app.ref.root);
    }
  });

  it("serves the app with DNS only beside a first app served so", async () => {
    const base = testPlan({ deployed: true, domain: "shop.example.com" });
    const plan = DeployPlanSchema.parse({ ...base, dns: { ...base.dns, proxied: false } });
    const result = await design(await secondApp({ plan }));
    expect(result.plan.dns).toMatchObject({ provider: "cloudflare", proxied: false });
    expect(result.plan.security.httpAllowedFrom).toBe("any");
    expect(result.chosen.summary).toContain("The app is served with DNS only");
  });

  it("stops a domain not on Cloudflare beside a proxied first app, naming the alternatives", async () => {
    const app = await secondApp({ requirements: { dnsProvider: "other" } });
    const error = await refusal(app, design(app));
    expect(error.message).toMatch(
      /^"shop" is served behind Cloudflare's proxy, so its server's firewall lets web traffic in only from Cloudflare, and this app's domain isn't on Cloudflare/,
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toMatch(/answer dnsProvider cloudflare/);
    expect(error.hint).toMatch(/a server of its own/);
  });

  it("stops a name too deep for Cloudflare's proxy beside a proxied first app, with advice for it", async () => {
    const app = await secondApp({ requirements: { domain: "api.landing.example.com" } });
    const error = await refusal(app, design(app), "INVALID_INPUT");
    expect(error.message).toBe(
      `"shop" is served behind Cloudflare's proxy, so this app is too, and Cloudflare's free certificate covers only example.com and *.example.com, so api.landing.example.com would fail HTTPS at Cloudflare's edge. Nothing was changed.`,
    );
    expect(error.hint).toBe(
      "In `opscrew interview`, use a name one level below example.com, such as api-landing.example.com, or give this app a server of its own; then run `opscrew design` again.",
    );
    expect(error.hint).not.toContain("server.serve");
  });

  it("takes the first app's proxy for a new plan, and stops when its own plan's differs", async () => {
    const base = testPlan({ deployed: true, domain: "shop.example.com" });
    const plan = DeployPlanSchema.parse({ ...base, target: { ...base.target, edge: "nginx" } });
    const app = await secondApp({ plan });
    const first = await design(app);
    expect(first.plan.target).toMatchObject({ edge: "nginx" });
    // The user sets another proxy in plan.yaml: design stops and leaves the plan as it is.
    const edited = DeployPlanSchema.parse({
      ...first.plan,
      target: { ...first.plan.target, edge: "caddy" },
    });
    await writeArtifact("plan", app.deps.paths.files.plan, edited);
    const before = await readFile(app.deps.paths.files.plan, "utf8");
    const error = await failure(design(app));
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        'This app\'s proxy is Caddy (target.edge in opscrew/plan.yaml), and the server of "shop" runs nginx for every app on it. Nothing was changed.',
    });
    expect(error.hint).toContain("Set target.edge: nginx in opscrew/plan.yaml");
    expect(await readFile(app.deps.paths.files.plan, "utf8")).toBe(before);
  });

  describe("the memory beside the first app and the other apps' records", () => {
    /** The memory limits on the server: the first app's, the other record's and this app's. */
    async function limits() {
      const sized = await design(await secondApp());
      const first = hostDescription(testPlan({ deployed: true, domain: "shop.example.com" }));
      return {
        first: first.memoryMb,
        mine: appMemoryMb(onAppServer(sized.plan)),
        edge: edgeMemoryMb("caddy"),
      };
    }
    /** `mb` as the inspected memory in GB, as design reads it (floored to 0.1 GB). */
    const gb = (mb: number) => Math.floor((mb / 1024) * 10) / 10;

    it("refuses an app that doesn't fit, counting the first app and the other records", async () => {
      const { first, mine, edge } = await limits();
      const app = await secondApp({
        records: [secondAppRecord()],
        memoryGb: gb(384 + edge + first + 512 + mine - 150),
      });
      const error = await refusal(app, design(app));
      expect(error.message).toContain(
        `the other OpsCrew apps on it take ${first + 512} MB of memory limits ("shop" ${first} MB and "inventory" 512 MB)`,
      );
      expect(error.message).toMatch(/Nothing was written\.$/);
    });

    it("warns when less than 15% stays free, naming them", async () => {
      const { first, mine, edge } = await limits();
      const used = first + 512 + mine + edge;
      const app = await secondApp({
        records: [secondAppRecord()],
        memoryGb: Math.ceil(((384 + used / 0.93) / 1024) * 10) / 10,
      });
      const result = await design(app);
      expect(result.warnings.join("\n")).toMatch(
        new RegExp(
          `keeps only \\d+% of its memory free after the memory limits of this app \\(${mine} MB\\) and of the other OpsCrew apps on it \\(${first + 512} MB: "shop" ${first} MB and "inventory" 512 MB\\)`,
        ),
      );
    });
  });

  it("stops in design when another app there holds the name or a hostname", async () => {
    // A hostname the other record serves.
    const taken = await secondApp({
      records: [{ ...secondAppRecord(), hostnames: [DOMAIN] }],
    });
    const error = await refusal(taken, design(taken));
    expect(error.message).toMatch(
      /^This app can't run beside "shop" on its server: The OpsCrew app "inventory" on this server already serves landing\.example\.com/,
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toMatch(/opscrew design again/);
    // A hostname of the first app, which has no record there.
    const firsts = await secondApp({ requirements: { domain: "shop.example.com" } });
    expect((await refusal(firsts, design(firsts))).message).toContain(
      'The OpsCrew app "shop" on this server already serves shop.example.com',
    );
    // A name OpsCrew reads as one of the first app's previews.
    const preview = await secondApp({ appFacts: { ...staticSpaFacts(), name: "shop-pr-3" } });
    expect((await refusal(preview, design(preview))).message).toContain(
      'The name "shop-pr-3" is how OpsCrew names a preview of "shop"',
    );
    expect(await seen(taken)).not.toContain(taken.firstKey);
  });

  it("stops while a record on the server can't be read", async () => {
    const facts = HostFactsSchema.parse({
      ...createdServerFacts(),
      apps: [{ name: "blog", record: null }],
    });
    const app = await secondApp({ facts });
    const error = await refusal(
      app,
      inspectOwnServerForDesign(app.deps, { services: { remote: shell, host: app.server } }),
    );
    expect(error.message).toBe(
      `The server of "shop" also runs "blog", whose record there OpsCrew can't read (written by a newer OpsCrew, or damaged), so OpsCrew doesn't know the memory it takes or the hostnames it serves. Nothing was changed.`,
    );
    expect(error.hint).toMatch(/Run `opscrew provision` with a current OpsCrew in the repository/);
  });
});
