import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  knownHostsName,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
  updateServerAddresses,
} from "../shared";
import { firstAppPaths } from "../shares/reference";
import {
  ED25519,
  ED25519_FINGERPRINT,
  hostKeyBlob,
  hostTestPlan,
  SERVER_IPV4,
  type SharedServerProject,
  sharedServerProject,
  testPlan,
} from "../testing";
import { splitFollowUps } from "./follow-ups";
import {
  answersToOwnServer,
  answersToSharedServer,
  buildSharesQuestions,
  SERVER_FIELDS,
  type ServerQuestion,
} from "./own-server";
import type { InterviewAnswers } from "./questions";
import { runInterview } from "./run";

const examples = fileURLToPath(new URL("../../../../examples/", import.meta.url));

const BASE: InterviewAnswers = {
  expectedMonthlyUsers: "<1k",
  budgetMonthly: { amount: 10, currency: "EUR" },
  uptime: "standard",
  domain: "inventory.example.com",
  dnsProvider: "cloudflare",
};

const split = (server: Record<string, unknown>) =>
  splitFollowUps({ server }, "server", SERVER_FIELDS);

/** A second app's project (a static site) beside the first app `shop`, with no record yet. */
async function secondApp(): Promise<SharedServerProject> {
  const project = await sharedServerProject();
  await materializeFixture(join(examples, "static-vite"), project.deps.paths.root);
  await rm(serverAddressesFile(project.deps.paths));
  return project;
}

/** Everything the fakes saw and what the interview wrote. */
async function seen(project: SharedServerProject): Promise<string> {
  const { deps } = project;
  const read = (file: string) => readFile(file, "utf8").catch(() => "");
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify((deps.runner as unknown as { calls: unknown[] }).calls),
    await read(deps.paths.files.requirements),
    await read(serverAddressesFile(deps.paths)),
    JSON.stringify(await deps.state.read()),
  ].join("\n");
}

describe("answersToSharedServer", () => {
  it("names the app by its repository folder, app key and environment, prod by default", async () => {
    const project = await sharedServerProject();
    const root = project.deps.paths.root;
    const folder = project.ref.root;
    expect(await answersToSharedServer(split({ shares: folder }), { root })).toEqual({
      root: folder,
      environment: "prod",
    });
    // A relative folder is read from the repository's root; `.` is the repository's first app.
    expect(
      await answersToSharedServer(
        split({ shares: relative(root, folder), "shares-app": ".", "shares-env": "staging" }),
        { root },
      ),
    ).toEqual({ root: folder, environment: "staging" });
    expect(
      await answersToSharedServer(split({ shares: folder, "shares-app": "docs" }), { root }),
    ).toEqual({ root: folder, app: "docs", environment: "prod" });
    // `~/` starts at the home folder, as server.key's does.
    expect(
      await answersToSharedServer(split({ shares: `~/${basename(folder)}` }), {
        root,
        env: { HOME: dirname(folder) },
      }),
    ).toEqual({ root: folder, environment: "prod" });
  });

  it.runIf(process.platform === "win32")(
    "reads a folder named in other letter cases on Windows as the same one",
    async () => {
      const project = await sharedServerProject();
      const ref = { root: project.ref.root, app: "docs", environment: "staging" };
      const previous = { ...project.own, shares: ref };
      expect(
        await answersToSharedServer(split({ shares: ref.root.toUpperCase() }), {
          root: project.deps.paths.root,
          previous,
        }),
      ).toMatchObject({ app: "docs", environment: "staging" });
    },
  );

  it("keeps the earlier reference without answers, and leaves a server of the user's alone", async () => {
    const project = await sharedServerProject();
    const context = { root: project.deps.paths.root, previous: project.own };
    expect(await answersToSharedServer(split({}), context)).toEqual(project.ref);
    // Only the environment changes: the folder is the earlier one.
    expect(await answersToSharedServer(split({ "shares-env": "dev" }), context)).toEqual({
      ...project.ref,
      environment: "dev",
    });
    const own = split({ host: "203.0.113.20", user: "root", key: "agent" });
    expect(await answersToSharedServer(own, context)).toBeUndefined();
    expect(await answersToSharedServer(split({}), { root: project.deps.paths.root })).toBe(
      undefined,
    );
  });

  it("refuses a folder that isn't there, a login beside it and names that aren't valid", async () => {
    const project = await sharedServerProject();
    const root = project.deps.paths.root;
    const missing = join(root, "no-such-folder");
    await expect(answersToSharedServer(split({ shares: missing }), { root })).rejects.toMatchObject(
      {
        code: "INVALID_INPUT",
        message: expect.stringContaining(`server.shares: there is no folder ${missing}`),
      },
    );
    const error = await answersToSharedServer(
      split({
        shares: project.ref.root,
        host: SERVER_IPV4,
        user: "deploy",
        "shares-app": "Not A Key",
        "shares-env": "-x",
      }),
      { root },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(error?.message).toContain(
      "server.host, server.user: the address and the login come from the other app's server",
    );
    expect(error?.message).toContain("server.shares-app: write the app's key");
    expect(error?.message).toContain("server.shares-env: write the environment's name");
    await expect(answersToSharedServer(split({ "shares-env": "dev" }), { root })).rejects.toThrow(
      /server\.shares \(the repository folder of the app whose server this app shares\) is missing/,
    );
    // A password is refused without echoing it.
    const secret = "hunter2-not-a-real-one";
    const refused = await answersToSharedServer(
      split({ shares: project.ref.root, password: secret }),
      { root },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(refused?.message).toMatch(/never asks for or stores a password/);
    expect(JSON.stringify(refused)).not.toContain(secret);
  });

  it("is never taken for a server of the user's own", () => {
    expect(() =>
      answersToOwnServer(
        split({ host: "203.0.113.20", user: "root", key: "agent", shares: "/srv/shop" }),
      ),
    ).toThrow(/server\.shares: only `opscrew interview` and `opscrew env add` put an app/);
  });
});

describe("buildSharesQuestions", () => {
  it("asks the folder, then the app and the environment only where there are several", () => {
    expect(buildSharesQuestions().map((q) => q.id)).toEqual(["server.shares"]);
    const questions = buildSharesQuestions({
      apps: [{ dir: "." }, { key: "docs", dir: "docs" }],
      environments: ["prod", "dev"],
    });
    expect(questions.map((q) => q.id)).toEqual([
      "server.shares",
      "server.shares-app",
      "server.shares-env",
    ]);
    expect(questions[1]?.options).toEqual([
      { value: ".", label: "The first app (in .)" },
      { value: "docs", label: '"docs" (in docs)' },
    ]);
    expect(questions[1]?.default).toBe(".");
    expect(questions[2]?.default).toBe("prod");
    expect(questions[0]?.help).toMatch(/provisioned from this computer/);
  });
});

describe("runInterview on the server of another app", () => {
  it("saves the reference and the first app's address locally, with this app's own key", async () => {
    const project = await secondApp();
    const { deps } = project;
    const result = await runInterview(deps, {
      answers: { ...BASE, provider: "own", "server.shares": project.ref.root },
    });
    expect(result.shares).toEqual(project.ref);
    expect(result.ownServer).toBeUndefined();
    expect(await readOwnServer(deps.paths)).toEqual({
      host: SERVER_IPV4,
      port: 22,
      user: "deploy",
      agent: false,
      keyPath: deps.paths.files.deployKey,
      shares: project.ref,
    });
    const requirements = await readFile(deps.paths.files.requirements, "utf8");
    expect(requirements).toMatch(/provider: own/);
    expect(requirements).not.toContain(project.ref.root);
    expect(requirements).not.toMatch(/region|server|shares/);
    expect((await deps.state.read()).phases.interview?.summary).toMatch(/the server of "shop"/);
    expect(deps.reporter.text()).toContain('this app runs on the server of "shop"');
    const all = await seen(project);
    expect(all).not.toContain(project.firstKey);
    for (const text of [deps.reporter.text(), requirements]) {
      expect(text).not.toContain(SERVER_IPV4);
    }
  });

  /** The record of a second app joined to the server of `shop`, with its pinned host key. */
  async function joined(project: SharedServerProject): Promise<void> {
    await recordOwnServer(project.deps.paths, {
      ...project.own,
      hostKey: ED25519_FINGERPRINT,
      joined: true,
    });
  }

  it("drops the pinned key and the joined login for another first app at another address", async () => {
    const project = await sharedServerProject();
    await materializeFixture(join(examples, "static-vite"), project.deps.paths.root);
    await joined(project);
    // Another first app, "blog", provisioned on this computer on a server at another address.
    const ref = { root: await mkdtemp(join(tmpdir(), "opscrew-first-app-")), environment: "prod" };
    const blog = firstAppPaths(project.deps.paths, ref);
    const base = testPlan({ deployed: true, domain: "blog.example.com" });
    await writeArtifact(
      "plan",
      blog.files.plan,
      DeployPlanSchema.parse({ ...base, app: { ...base.app, name: "blog" } }),
    );
    const address = "203.0.113.30";
    await updateServerAddresses(blog, (current) => ({ ...current, deployment: { ipv4: address } }));
    await mkdir(dirname(blog.files.deployKey), { recursive: true });
    await writeFile(blog.files.deployKey, fakeSecret("private-key-pem", "blog-deploy-key"));
    await writeFile(blog.files.knownHosts, `${knownHostsName(address)} ssh-ed25519 ${ED25519}\n`);
    await runInterview(project.deps, {
      answers: { ...BASE, provider: "own", "server.shares": ref.root },
    });
    const own = await readOwnServer(project.deps.paths);
    expect(own).toMatchObject({ host: address, shares: ref });
    expect(own?.hostKey).toBeUndefined();
    expect(own?.joined).toBeUndefined();
  });

  it("drops the pinned key and the joined login when the server has a new host key", async () => {
    const project = await sharedServerProject();
    await materializeFixture(join(examples, "static-vite"), project.deps.paths.root);
    await joined(project);
    // The first app's server was recreated at the same address, with a new host key.
    const rebuilt = hostKeyBlob("ssh-ed25519", "rebuilt");
    await writeFile(
      project.first.files.knownHosts,
      `${knownHostsName(SERVER_IPV4)} ssh-ed25519 ${rebuilt}\n`,
    );
    await runInterview(project.deps, { answers: { ...BASE, provider: "own" } });
    const own = await readOwnServer(project.deps.paths);
    expect(own).toMatchObject({ host: SERVER_IPV4, shares: project.ref });
    expect(own?.hostKey).toBeUndefined();
    expect(own?.joined).toBeUndefined();
  });

  it("keeps the pinned host key and the joined login when the same server is named again", async () => {
    const project = await sharedServerProject();
    await materializeFixture(join(examples, "static-vite"), project.deps.paths.root);
    const { deps } = project;
    await joined(project);
    await runInterview(deps, { answers: { ...BASE, provider: "own" } });
    expect(await readOwnServer(deps.paths)).toMatchObject({
      shares: project.ref,
      hostKey: ED25519_FINGERPRINT,
      joined: true,
    });
  });

  it("stops at the end of the interview with the first app's refusal, writing nothing", async () => {
    const project = await secondApp();
    const { deps } = project;
    await rm(project.first.files.plan);
    const error = await runInterview(deps, {
      answers: { ...BASE, provider: "own", "server.shares": project.ref.root },
    }).catch((thrown: unknown) => thrown as Error & { hint?: string });
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(
        /has no OpsCrew plan on this computer\. Nothing was changed\.$/,
      ),
    });
    await expect(readFile(deps.paths.files.requirements, "utf8")).rejects.toThrow();
    expect(await readOwnServer(deps.paths)).toBeUndefined();
    expect(await seen(project)).not.toContain(project.firstKey);
  });

  it("asks which server, then the folder, the app and the environment in a terminal", async () => {
    const project = await secondApp();
    const { deps } = project;
    // The first app's repository has a further app and a second environment.
    const docs = join(project.ref.root, "opscrew", "apps", "docs");
    await mkdir(docs, { recursive: true });
    await writeArtifact("app", join(docs, "app.yaml"), { schemaVersion: 1, dir: "docs" });
    await writeArtifact(
      "plan",
      firstAppPaths(deps.paths, { ...project.ref, environment: "dev" }).files.plan,
      hostTestPlan(),
    );
    const rounds: ServerQuestion[][] = [];
    const result = await runInterview(deps, {
      ask: async () => ({ ...BASE, provider: "own" }),
      askServer: async (questions) => {
        rounds.push(questions);
        const id = questions[0]?.id;
        if (id === "server.kind") return { "server.kind": "shares" };
        if (id === "server.shares") return { "server.shares": project.ref.root };
        return { [id ?? ""]: questions[0]?.default };
      },
    });
    expect(rounds.map((round) => round.map((q) => q.id))).toEqual([
      ["server.kind"],
      ["server.shares"],
      ["server.shares-app"],
      ["server.shares-env"],
    ]);
    expect(rounds[0]?.[0]).toMatchObject({
      default: "own",
      options: [
        { value: "own" },
        {
          value: "shares",
          label: "A server another of your OpsCrew apps runs on (one OpsCrew created)",
        },
      ],
    });
    expect(rounds[3]?.[0]?.options?.map((option) => option.value)).toEqual(["prod", "dev"]);
    expect(result.shares).toEqual(project.ref);
    expect(await seen(project)).not.toContain(project.firstKey);
  });
});
