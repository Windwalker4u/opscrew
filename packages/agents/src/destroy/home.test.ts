/**
 * `opscrew destroy` for an app served from home (plan 14., research R12): the teardown host plan
 * removes the app's address updater, then its records are deleted at Cloudflare through their own
 * plan approved by its hash with the app's name typed, then with the repository's last app at home
 * a pull request removes the outside check's workflow; `--undo-host` also removes the IPv6 filter;
 * the output names the token page. No token or address of the home goes anywhere.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeCloudflareAccounts } from "@opscrew/connector-cloudflare/testing";
import {
  DNS_UPDATER_RECORD_COMMENT,
  type HostFacts,
  HostFactsSchema,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderOutsideCheckWorkflow } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  everythingPrinted,
  type OwnProject,
  ownProject,
  provisionOwn,
} from "../drift/__fixtures__/own-project";
import {
  OUTSIDE_CHECK_PATH,
  outsideCheckUnused,
  removeUnusedOutsideCheck,
} from "../home/outside-check";
import {
  ACCOUNT_ID,
  createProject,
  createTestPhaseDeps,
  FakeRunnerGitHub,
  filteredFacts,
  HOME_IPV4,
  HOME_IPV6,
  ownPlan,
} from "../testing";
import { TOKEN_PAGE } from "./home";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

const OWN_TOKEN = fakeSecret("cloudflare-token", "destroy-home-own");
const UPDATER = fakeSecret("cloudflare-token", "destroy-home-updater");
const NAME = "shop.example.com";
const CF_V4 = ["173.245.48.0/20", "103.21.244.0/22"];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `plan` served from home behind the proxy over IPv4, deployed by the server's runner. */
function atHome(plan: DeployPlan, more: Record<string, unknown> = {}): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    target: { ...plan.target, home: { ipv4: true } },
    security: { ...plan.security, httpAllowedFrom: "cloudflare" },
    environment: { ...plan.environment, runner: "server" },
    ...more,
  });
}

/** The app's address updater as inspection reads it on the server. */
function updaterOn(zoneId: string): NonNullable<HostFacts["dnsUpdaters"]>[number] {
  return {
    app: "shop",
    config: {
      schemaVersion: 1,
      app: "shop",
      zoneId,
      name: NAME,
      proxied: true,
      ipv4: true,
      ipv6: false,
    },
    configFile: { mode: "600", owner: "root" },
    token: { present: true, mode: "600", owner: "root", sha256: sha256(UPDATER) },
    timer: { enabled: true, active: true },
    state: null,
  };
}

/** Writes and commits the outside check's workflow, as a home app's merged pull request left it. */
async function commitOutsideCheck(s: { root: string; git: OwnProject["git"] }): Promise<void> {
  const file = renderOutsideCheckWorkflow();
  await mkdir(dirname(join(s.root, file.path)), { recursive: true });
  await writeFile(join(s.root, file.path), file.content);
  await s.git(s.root, "add", file.path);
  await s.git(s.root, "commit", "-m", "the outside check");
}

/** Writes `plan` as the staging environment's. */
async function writeStaging(root: string, plan: DeployPlan): Promise<void> {
  const file = join(root, "opscrew", "environments", "staging", "plan.yaml");
  await writeArtifact(
    "plan",
    file,
    DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, name: `${plan.app.name}-staging` },
      environment: { ...plan.environment, name: "staging" },
    }),
  );
}

type Answer = (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };

/**
 * `shop` deployed at home: provisioned, its deploy pull request merged (with the outside check's
 * workflow) and pushed, its server running the address updater and the IPv6 filter, and the
 * updater's records at Cloudflare beside OpsCrew's own CAA record. `events` lists the host
 * applies, approvals and record deletions in order.
 */
async function deployedAtHome(o: { answer?: Answer } = {}) {
  const events: string[] = [];
  let answer: Answer = o.answer ?? (() => true);
  const s = await ownProject({
    answer: (request) => {
      events.push(`approve:${request.kind}`);
      return answer(request);
    },
  });
  await provisionOwn(s);
  // The deploy pull request is merged; the outside check's workflow came with it.
  await s.git(s.root, "checkout", "main");
  await s.git(s.root, "merge", "--ff-only", "opscrew/deploy-setup");
  await commitOutsideCheck(s);
  await s.git(s.root, "push", "origin", "main");
  const plan = await readArtifact("plan", s.deps.paths.files.plan);
  await writeArtifact("plan", s.deps.paths.files.plan, atHome(plan));

  const cloudflare = fakeCloudflareAccounts({
    accounts: [{ name: "home", id: ACCOUNT_ID, token: OWN_TOKEN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  const zone = cloudflare.zone("example.com", "home");
  for (const [type, content] of [
    ["A", HOME_IPV4],
    ["AAAA", HOME_IPV6],
  ] as const) {
    cloudflare.addRecord(zone, {
      type,
      name: NAME,
      content,
      proxied: true,
      ttl: 1,
      comment: DNS_UPDATER_RECORD_COMMENT,
    });
  }
  cloudflare.addRecord(zone, {
    type: "CAA",
    name: NAME,
    data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
  });
  s.deps.fetch = async (url, init) => {
    if (init?.method === "DELETE" && String(url).includes("/dns_records/")) {
      events.push("records-delete");
    }
    return cloudflare.fetch(url, init);
  };
  s.deps.env.CLOUDFLARE_API_TOKEN = OWN_TOKEN;
  // A proxied app's home address and the updater's token: secrets, never shown or kept.
  s.deps.redactor.addLiteral(HOME_IPV4);
  s.deps.redactor.addLiteral(HOME_IPV6);
  s.deps.redactor.addLiteral(UPDATER);

  // The server runs the app's updater and the web filter with its IPv6 table.
  const facts = structuredClone(s.host.facts);
  facts.record?.changes.push({
    step: "web-filter",
    purpose: "setup",
    at: "2026-10-14T12:00:00.000Z",
    previous: {},
  });
  s.host.facts = HostFactsSchema.parse({
    ...facts,
    dnsUpdaters: [updaterOn(zone.id)],
    webFilter: { ...filteredFacts(CF_V4), table6: "a".repeat(64) },
  });
  const apply = s.host.apply.bind(s.host);
  s.host.apply = async (remote, hostPlan, options) => {
    events.push(`host:${hostPlan.purpose}`);
    return apply(remote, hostPlan, options);
  };
  events.length = 0;
  s.handler.requests.length = 0;
  s.github.pulls.length = 0;
  /** The updater's records Cloudflare holds now, and every record's type. */
  const records = () => ({
    updater: zone.records
      .filter((record) => record.comment === DNS_UPDATER_RECORD_COMMENT)
      .map((record) => `${record.type} ${record.name}`)
      .sort(),
    types: zone.records.map((record) => record.type).sort(),
  });
  return Object.assign(s, {
    events,
    records,
    cloudflare,
    answer: (next: Answer) => {
      answer = next;
    },
  });
}

type Deployed = Awaited<ReturnType<typeof deployedAtHome>>;

function services(s: OwnProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
    runnerGitHub: new FakeRunnerGitHub(),
  };
}

/** Everything the run said, recorded, asked, saved, committed and sent to GitHub. */
async function everythingSeen(s: Deployed): Promise<string> {
  const plansDir = s.deps.paths.files.plansDir;
  const saved = await readdir(plansDir).catch(() => [] as string[]);
  const plans = await Promise.all(
    saved.map((name) => readFile(join(plansDir, name), "utf8").catch(() => "")),
  );
  const log = await s.git(s.root, "log", "--all", "--format=%B");
  return [
    everythingPrinted(s),
    JSON.stringify(s.handler.requests),
    JSON.stringify(s.github.pulls),
    JSON.stringify(s.host.applies.map((applied) => applied.plan)),
    await readFile(s.deps.paths.files.plan, "utf8"),
    ...plans,
    log,
  ].join("\n");
}

describe.skipIf(!findExecutable("git"))("opscrew destroy for an app at home", () => {
  it("removes the updater with the teardown, then its records through their own plan, then the outside check in a pull request", async () => {
    const s = await deployedAtHome();
    const result = await runDestroy(s.deps, { services: services(s) });

    // The teardown host plan removes the app's updater instance with the last instance's files.
    const teardown = s.host.applies.find((applied) => applied.plan.purpose === "teardown");
    expect(teardown?.plan.steps.find((step) => step.id === "dns-updater")).toMatchObject({
      state: "change",
      params: { remove: true },
    });
    // Then the records: their own approval, by type and name, with the app's name typed.
    const recordsApproval = s.handler.requests.find((request) =>
      request.title.includes("address updater's records"),
    );
    expect(recordsApproval).toMatchObject({
      kind: "cloudflare-apply",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(recordsApproval?.details).toContain(`A ${NAME}, AAAA ${NAME}`);
    const order = s.events.filter((event) => event !== "approve:iac-apply");
    expect(order.indexOf("host:teardown")).toBeLessThan(order.indexOf("approve:cloudflare-apply"));
    expect(order.indexOf("approve:cloudflare-apply")).toBeLessThan(order.indexOf("records-delete"));
    expect(s.records()).toEqual({ updater: [], types: ["CAA"] });

    // The repository's last app at home: the pull request removes the outside check's workflow.
    expect(s.github.pulls).toHaveLength(1);
    const [pull] = s.github.pulls;
    expect(pull).toMatchObject({ base: "main", title: "OpsCrew: remove the outside check" });
    expect(pull?.body).toContain(`removes \`${OUTSIDE_CHECK_PATH}\``);
    expect(await s.git(s.root, "ls-tree", "-r", "--name-only", pull?.head ?? "")).not.toContain(
      OUTSIDE_CHECK_PATH,
    );
    expect(await s.git(s.root, "ls-tree", "-r", "--name-only", "main")).toContain(
      OUTSIDE_CHECK_PATH,
    );
    expect(s.events.slice(-2)).toEqual(["approve:git-push", "approve:pull-request"]);

    // The output names the token page; the workflow is not left behind.
    const remaining = result.remaining.join("\n");
    expect(remaining).toContain(
      `The address updater's Cloudflare token: OpsCrew removed your server's copy, but the token works until you delete it at ${TOKEN_PAGE}.`,
    );
    expect(remaining).not.toContain("outside check");
    expect(s.deps.reporter.text()).toContain(TOKEN_PAGE);

    // No token or address of the home anywhere.
    const seen = await everythingSeen(s);
    for (const secret of [HOME_IPV4, HOME_IPV6, UPDATER, OWN_TOKEN]) {
      expect(seen).not.toContain(secret);
    }
  });

  it("deletes no record when their deletion is refused, and the next run continues with them", async () => {
    const s = await deployedAtHome();
    s.answer((request) => !request.title.includes("address updater's records"));
    await expect(runDestroy(s.deps, { services: services(s) })).rejects.toThrow(
      "Nothing in Cloudflare was changed.",
    );
    expect(s.records().updater).toEqual([`A ${NAME}`, `AAAA ${NAME}`]);
    expect(s.events).not.toContain("records-delete");
    expect(s.github.pulls).toHaveLength(0);
    // Nothing recorded the teardown as done, so the next run deletes them.
    s.answer(() => true);
    await runDestroy(s.deps, { services: services(s) });
    expect(s.records().updater).toEqual([]);
    expect(s.github.pulls).toHaveLength(1);
  });

  it("keeps the outside check while another environment is at home", async () => {
    const s = await deployedAtHome();
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    await writeStaging(s.root, plan);
    const result = await runDestroy(s.deps, { services: services(s) });
    expect(s.records().updater).toEqual([]);
    expect(s.github.pulls).toHaveLength(0);
    expect(s.events).not.toContain("approve:pull-request");
    expect(result.remaining.join("\n")).not.toContain("outside check");
  });

  it("says the outside check stays when no pull request removes it", async () => {
    const s = await deployedAtHome();
    s.answer((request) => request.kind !== "pull-request");
    const result = await runDestroy(s.deps, { services: services(s) });
    expect(s.github.pulls).toHaveLength(0);
    expect(result.remaining.join("\n")).toContain(
      `The outside check's workflow (${OUTSIDE_CHECK_PATH}): no app of this repository is at home any more; no pull request removes it yet (its removal is committed on the branch opscrew/deploy-setup-2). Push opscrew/deploy-setup-2 and open a pull request into main.`,
    );
  });

  it("on another branch, says in destroy's words why no pull request removes the outside check", async () => {
    const s = await deployedAtHome();
    await s.git(s.root, "checkout", "-b", "feature");
    const result = await runDestroy(s.deps, { services: services(s) });
    expect(s.github.pulls).toHaveLength(0);
    const remaining = result.remaining.join("\n");
    expect(remaining).toContain(
      `The outside check's workflow (${OUTSIDE_CHECK_PATH}): no app of this repository is at home any more; this clone is on feature, but the deployment files go on a new branch from the latest main, so OpsCrew opened no pull request. Run \`git checkout main && git pull\`, then make the change on a new branch and open a pull request yourself.`,
    );
    const item = result.remaining.find((line) => line.startsWith("The outside check's workflow"));
    expect(item).not.toContain("opscrew provision");
    expect(await s.git(s.root, "ls-files", "--deleted")).toBe("");
  });

  it("--undo-host also removes the IPv6 filter", async () => {
    const s = await deployedAtHome();
    await runDestroy(s.deps, { services: services(s), undoHost: true });
    const undo = s.host.applies.find((applied) => applied.plan.purpose === "undo");
    const filter = undo?.plan.steps.find((step) => step.id === "web-filter");
    expect(filter).toMatchObject({ state: "change", params: { remove: true } });
    expect(filter?.reason).toContain("its nftables table inet opscrew-web when there is one");
    const seen = await everythingSeen(s);
    for (const secret of [HOME_IPV4, HOME_IPV6, UPDATER]) expect(seen).not.toContain(secret);
  });
});

describe.skipIf(!findExecutable("git"))(
  "the outside check's workflow and the last app at home",
  () => {
    /** A repository whose prod plan is `plan`, with the workflow committed. */
    async function repository(plan: DeployPlan) {
      const project = await createProject(plan);
      await commitOutsideCheck(project);
      const deps = await createTestPhaseDeps({
        root: project.root,
        runner: new NodeCommandRunner(),
      });
      return { ...project, deps };
    }
    const deployed = (plan: DeployPlan, more: Record<string, unknown> = {}) =>
      atHome(plan, {
        deployment: { ...plan.deployment, lastApplyAt: "2026-10-14T12:00:00.000Z" },
        ...more,
      });

    it("a destroy removes it with the last app at home, never while another one is deployed", async () => {
      const plan = deployed(ownPlan());
      const s = await repository(plan);
      expect(await outsideCheckUnused(s.deps, plan, { leaving: true })).toBe(true);
      await writeStaging(s.root, plan);
      expect(await outsideCheckUnused(s.deps, plan, { leaving: true })).toBe(false);
      // A destroyed environment at home no longer keeps it.
      await writeStaging(
        s.root,
        DeployPlanSchema.parse({
          ...plan,
          deployment: { ...plan.deployment, destroyedAt: "2026-10-15T12:00:00.000Z" },
        }),
      );
      expect(await outsideCheckUnused(s.deps, plan, { leaving: true })).toBe(true);
    });

    it("a switch out of home removes it in the pull request with the repository's last app at home", async () => {
      const home = deployed(ownPlan());
      const s = await repository(home);
      // Still at home: it stays.
      expect(await removeUnusedOutsideCheck(s.deps, home)).toEqual([]);
      // Switched to public mode: the deploy-setup pull request removes it.
      const switched = DeployPlanSchema.parse({
        ...home,
        target: { ...home.target, home: undefined },
      });
      expect(await removeUnusedOutsideCheck(s.deps, switched)).toEqual([OUTSIDE_CHECK_PATH]);
      expect(await s.git(s.root, "ls-files", "--deleted")).toBe(OUTSIDE_CHECK_PATH);
      expect(s.deps.reporter.text()).toContain(
        "No app of this repository is at home any more, so the pull request removes the outside check's workflow.",
      );
      // Not tracked any more: nothing to remove.
      await s.git(s.root, "rm", "--cached", "--quiet", OUTSIDE_CHECK_PATH);
      expect(await removeUnusedOutsideCheck(s.deps, switched)).toEqual([]);
    });

    it("a switch keeps it while another environment of the repository is at home", async () => {
      const home = deployed(ownPlan());
      const s = await repository(home);
      await writeStaging(s.root, home);
      const switched = DeployPlanSchema.parse({
        ...home,
        target: { ...home.target, home: undefined },
      });
      expect(await removeUnusedOutsideCheck(s.deps, switched)).toEqual([]);
      expect(await s.git(s.root, "ls-files", "--deleted")).toBe("");
    });
  },
);
