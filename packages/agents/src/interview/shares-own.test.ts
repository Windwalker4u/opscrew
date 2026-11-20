import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Question,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  knownHostsName,
  type OwnServerConnectionInput,
  readOwnServer,
  recordOwnServer,
  type SharesReference,
  serverAddressesFile,
} from "../shared";
import { firstAppPaths } from "../shares/reference";
import {
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  ownPlan,
  SERVER_IPV4,
  sharedServerProject,
  type TestPhaseDeps,
} from "../testing";
import { answersToRequirements } from "./answers";
import type { ServerQuestion } from "./own-server";
import type { InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));

/** The interview's answers without a budget: none is needed beside another app (FR-3026). */
const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  uptime: "standard",
  domain: "inventory.example.com",
  dnsProvider: "cloudflare",
};

const PORT = 2222;

/**
 * A second app's project (a static site) and the first app `shop`, provisioned on this computer on
 * a server the user owns at {@link SERVER_IPV4}, SSH port {@link PORT}: its plan (`plan`, by default
 * proxied), its record (`record` over the default login with the user's key file) and the
 * server's host key pinned for it.
 */
async function ownFirst(o: { plan?: DeployPlan; record?: Partial<OwnServerConnectionInput> } = {}) {
  const deps = await createTestPhaseDeps();
  await materializeFixture(join(examples, "static-vite"), deps.paths.root);
  const ref: SharesReference = {
    root: await mkdtemp(join(tmpdir(), "opscrew-own-first-app-")),
    environment: "prod",
  };
  const first = firstAppPaths(deps.paths, ref);
  await writeArtifact("plan", first.files.plan, o.plan ?? ownPlan({ deployed: true }));
  const keyPath = join(ref.root, "..", `${ref.root.split(sep).pop()}-keys`, "id_ed25519");
  const key = fakeSecret("private-key-pem", "the-user-s-own-key");
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o600 });
  await recordOwnServer(first, {
    host: SERVER_IPV4,
    port: PORT,
    user: "admin",
    agent: false,
    keyPath,
    reachable: true,
    serve: "proxy",
    hostKey: ED25519_FINGERPRINT,
    publicIpv4: SERVER_IPV4,
    ...o.record,
  });
  await mkdir(dirname(first.files.knownHosts), { recursive: true });
  await writeFile(
    first.files.knownHosts,
    `${knownHostsName(SERVER_IPV4, PORT)} ssh-ed25519 ${ED25519}\n`,
  );
  return { deps, ref, first, keyPath, key };
}

type OwnFirst = Awaited<ReturnType<typeof ownFirst>>;

/** Fails a test whose interview should have been refused. */
const refused = (): never => {
  throw new Error("the interview was expected to be refused");
};

/** The repository's files that may be committed: all but OpsCrew's local state and home. */
async function committedText(deps: TestPhaseDeps): Promise<string> {
  const root = deps.paths.root;
  const local = [deps.paths.stateDir, deps.paths.homeDir, dirname(deps.paths.files.knownHosts)];
  const texts: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    const file = join(root, entry);
    if (local.some((dir) => file.startsWith(dir)) || entry.startsWith(".home-opscrew")) continue;
    if ((await stat(file)).isFile()) texts.push(await readFile(file, "utf8"));
  }
  return texts.join("\n");
}

/** Everything the fakes saw: output, audit entries, commands and the phase's state. */
async function seen(deps: TestPhaseDeps): Promise<string> {
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify((deps.runner as unknown as { calls: unknown[] }).calls),
    JSON.stringify(await deps.state.read()),
  ].join("\n");
}

/** Expects nothing of the server's login in any output or committed file. */
async function noLeak(project: OwnFirst): Promise<void> {
  const everything = [await seen(project.deps), await committedText(project.deps)].join("\n");
  for (const hidden of [SERVER_IPV4, project.keyPath, project.key]) {
    expect(everything).not.toContain(hidden);
  }
}

describe("runInterview on a server of the user's own that another app runs on", () => {
  it("copies that app's login, proxied serving and host key into this app's local state", async () => {
    const project = await ownFirst();
    const { deps } = project;
    const result = await runInterview(deps, {
      answers: { ...BASE, provider: "own", "server.shares": project.ref.root },
    });
    const answers = {
      host: SERVER_IPV4,
      port: PORT,
      user: "admin",
      agent: false,
      keyPath: project.keyPath,
      reachable: true,
      serve: "proxy",
    };
    expect(result.ownServer).toEqual(answers);
    expect(result.shares).toBeUndefined();
    // One more app on the user's server: no reference to the first app is kept.
    expect(await readOwnServer(deps.paths)).toEqual({
      ...answers,
      hostKey: ED25519_FINGERPRINT,
      publicIpv4: SERVER_IPV4,
    });
    expect(await readFile(deps.paths.files.knownHosts, "utf8")).toBe(
      `${knownHostsName(SERVER_IPV4, PORT)} ssh-ed25519 ${ED25519}\n`,
    );
    expect(await readFile(serverAddressesFile(deps.paths), "utf8")).not.toContain(project.key);
    // No budget was asked for or given.
    const requirements = await readArtifact("requirements", deps.paths.files.requirements);
    expect(requirements).toMatchObject({
      provider: "own",
      budgetMonthly: { amount: 0, currency: "EUR" },
    });
    expect(deps.reporter.text()).toContain(
      'Saved how to reach the server of "shop" in .opscrew/server.json, on this computer only',
    );
    expect((await deps.state.read()).phases.interview?.summary).toMatch(/the server of "shop"/);
    await noLeak(project);
    expect(await committedText(deps)).not.toContain(project.ref.root);
  });

  it("serves DNS only as that app does, and keeps a budget given, 0 included", async () => {
    const project = await ownFirst({
      plan: ownPlan({ deployed: true, proxied: false }),
      record: { agent: true, keyPath: undefined, serve: "dns-only" },
    });
    const { deps } = project;
    const result = await runInterview(deps, {
      answers: {
        ...BASE,
        budgetMonthly: "0 EUR",
        provider: "own",
        "server.shares": project.ref.root,
      },
    });
    expect(result.ownServer).toEqual({
      host: SERVER_IPV4,
      port: PORT,
      user: "admin",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });
    expect(result.requirements.budgetMonthly).toEqual({ amount: 0, currency: "EUR" });
    await noLeak(project);
  });

  it("refuses a first app served through a tunnel or at home, writing nothing", async () => {
    const base = ownPlan({ deployed: true });
    const tunnel = await ownFirst({
      plan: ownPlan({ deployed: true, access: "tunnel" }),
      record: { reachable: false, serve: undefined },
    });
    const home = await ownFirst({
      plan: DeployPlanSchema.parse({
        ...base,
        target: { ...base.target, home: { ipv4: true } },
        environment: { runner: "server" },
      }),
      record: { reachable: undefined, publicIpv4: undefined, home: {} },
    });
    for (const [project, said] of [
      [tunnel, /^"shop" is served through a Cloudflare Tunnel/],
      [home, /^"shop" runs on a server at your home/],
    ] as const) {
      const error = await runInterview(project.deps, {
        answers: { ...BASE, provider: "own", "server.shares": project.ref.root },
      }).then(refused, (thrown: unknown) => thrown as Error & { hint?: string });
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION", message: said });
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(error.hint).toMatch(/server questions with your server's own login instead/);
      await expect(readFile(project.deps.paths.files.requirements, "utf8")).rejects.toThrow();
      expect(await readOwnServer(project.deps.paths)).toBeUndefined();
      await expect(readFile(project.deps.paths.files.knownHosts, "utf8")).rejects.toThrow();
      await noLeak(project);
    }
  });

  it("asks no budget in a terminal and no server question after the folder", async () => {
    const project = await ownFirst();
    const { deps } = project;
    const asked: Question[][] = [];
    const rounds: ServerQuestion[][] = [];
    const result = await runInterview(deps, {
      ask: async (questions) => {
        asked.push(questions);
        return { ...BASE, provider: "own" };
      },
      askServer: async (questions) => {
        rounds.push(questions);
        const id = questions[0]?.id;
        if (id === "server.kind") return { "server.kind": "shares" };
        return { "server.shares": project.ref.root };
      },
    });
    expect(asked.flat().map((q) => q.id)).not.toContain("budgetMonthly");
    expect(rounds.map((round) => round.map((q) => q.id))).toEqual([
      ["server.kind"],
      ["server.shares"],
    ]);
    expect(result.ownServer).toMatchObject({ host: SERVER_IPV4, port: PORT, serve: "proxy" });
    expect(result.requirements.budgetMonthly).toEqual({ amount: 0, currency: "EUR" });
    await noLeak(project);
  });
});

describe("the budget beside another app (FR-3026)", () => {
  it("is neither required nor asked beside an app on a server OpsCrew created", async () => {
    const project = await sharedServerProject();
    await materializeFixture(join(examples, "static-vite"), project.deps.paths.root);
    await rm(serverAddressesFile(project.deps.paths));
    const result = await runInterview(project.deps, {
      answers: { ...BASE, provider: "own", "server.shares": project.ref.root },
    });
    expect(result.shares).toEqual(project.ref);
    expect(result.requirements.budgetMonthly).toEqual({ amount: 0, currency: "EUR" });
    // Run again without server answers, as a script or the MCP server does: the reference stays.
    const { budgetMonthly: _none, ...answered } = await readArtifact(
      "requirements",
      project.deps.paths.files.requirements,
    );
    await rm(project.deps.paths.files.requirements);
    const again = await runInterview(project.deps, {
      answers: { ...BASE, provider: "own", dataCriticality: answered.dataCriticality },
    });
    expect(again.shares).toEqual(project.ref);
    expect(again.requirements.budgetMonthly).toEqual({ amount: 0, currency: "EUR" });
    // A budget given is validated as usual.
    const error = await runInterview(project.deps, {
      answers: {
        ...BASE,
        budgetMonthly: "a lot",
        provider: "own",
        "server.shares": project.ref.root,
      },
    }).then(refused, (thrown: unknown) => thrown as Error);
    expect(error.message).toMatch(/budgetMonthly: write an amount such as `10 EUR`/);
  });

  it("is required and asked last in a terminal for any other server, never 0", async () => {
    const deps = await createTestPhaseDeps();
    await materializeFixture(join(examples, "static-vite"), deps.paths.root);
    const missing = await runInterview(deps, {
      answers: { ...BASE, provider: "hetzner", region: "eu-central" },
    }).then(refused, (thrown: unknown) => thrown as Error);
    expect(missing.message).toMatch(/Some required answers are missing: budgetMonthly/);
    const zero = await runInterview(deps, {
      answers: { ...BASE, budgetMonthly: "0 EUR", provider: "hetzner", region: "eu-central" },
    }).then(refused, (thrown: unknown) => thrown as Error);
    expect(zero.message).toMatch(/budgetMonthly: write an amount above 0/);
    // Answers naming another app's server don't drop the budget for a server OpsCrew creates.
    const ignored = await runInterview(deps, {
      answers: {
        ...BASE,
        provider: "hetzner",
        region: "eu-central",
        "server.shares": deps.paths.root,
      },
    }).then(refused, (thrown: unknown) => thrown as Error);
    expect(ignored.message).toMatch(/Some required answers are missing: budgetMonthly/);

    // A server of the user's: the budget comes after the server's questions.
    const order: string[] = [];
    const result = await runInterview(deps, {
      ask: async (questions) => {
        order.push(...questions.map((q) => q.id));
        return questions.some((q) => q.id === "budgetMonthly")
          ? { budgetMonthly: "15 USD" }
          : { ...BASE, provider: "own" };
      },
      askServer: async (questions) => {
        order.push(...questions.map((q) => q.id));
        const answers: InterviewAnswers = {};
        for (const q of questions) answers[q.id] = q.default;
        if (questions.some((q) => q.id === "server.host")) answers["server.host"] = "203.0.113.20";
        if (questions.some((q) => q.id === "server.home")) answers["server.home"] = false;
        return answers;
      },
    });
    expect(order.at(-1)).toBe("budgetMonthly");
    expect(order.indexOf("server.serve")).toBeGreaterThan(order.indexOf("provider"));
    expect(order.filter((id) => id === "budgetMonthly")).toHaveLength(1);
    expect(result.requirements.budgetMonthly).toEqual({ amount: 15, currency: "USD" });
  });

  it("keeps an earlier 0 on a server of the user's, and asks for one elsewhere", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    const previous = answersToRequirements(
      { ...BASE, provider: "own", dataCriticality: "none" },
      { now, noBudget: true },
    );
    expect(previous.budgetMonthly).toEqual({ amount: 0, currency: "EUR" });
    expect(answersToRequirements({}, { now, previous, noBudget: true }).budgetMonthly).toEqual({
      amount: 0,
      currency: "EUR",
    });
    // Another environment of the app, or the app on another server of the user's: kept.
    expect(answersToRequirements({}, { now, previous }).budgetMonthly).toEqual({
      amount: 0,
      currency: "EUR",
    });
    // A given 0 is still refused there, without another app's server.
    expect(() => answersToRequirements({ budgetMonthly: "0 EUR" }, { now, previous })).toThrow(
      /budgetMonthly: write an amount above 0/,
    );
    // A server OpsCrew creates: asked for one.
    const cloud = { provider: "hetzner", region: "eu-central" };
    expect(() => answersToRequirements(cloud, { now, previous })).toThrow(
      /Some required answers are missing: budgetMonthly/,
    );
    expect(
      answersToRequirements({ ...cloud, budgetMonthly: "12 EUR" }, { now, previous }).budgetMonthly,
    ).toEqual({ amount: 12, currency: "EUR" });
  });
});
