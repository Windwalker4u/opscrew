/**
 * A second app on a server OpsCrew created for another app, the first app (feature 030, plan 2.–4.):
 * its host plan holds only its own steps, its deploy-key step keeps every line of the deploy
 * user's authorized_keys that is not its own, in its order, its record names the first app, and
 * its teardown never counts it as the last app. Root only through Docker, and only for its record.
 */
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  ed25519PublicKey,
  runnerDesired,
  runnerToken,
  SH_AVAILABLE,
  SHOP_PROJECT,
  SHOP_REPOSITORY,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
} from "./__fixtures__/helpers";
import { ShellHarness } from "./__fixtures__/shell-harness";
import {
  APP_RECORDS_DIR,
  checkKeyLine,
  PORTAINER_DIR,
  previewKeyLine,
  READY_FLAG,
  RECORD_PATH,
  RUNNERS_DIR,
  SHARED_DIRS,
} from "./constants";
import { AppRecordSchema, type HostFacts } from "./facts";
import { inspectHost } from "./inspect";
import { planHost, planTeardown } from "./plan";
import { dockerRootCommand } from "./privilege";
import { stepScripts } from "./steps";
import { type DesiredHost, DesiredHostSchema, type HostPlan, type HostStep } from "./types";
import {
  renderUptimeReportScript,
  UPTIME_REPORT_CONFIG_DIR,
  UPTIME_REPORT_SCRIPT,
  UPTIME_REPORT_SERVICE_TEXT,
  UPTIME_REPORT_SERVICE_UNIT,
  UPTIME_REPORT_STATE_DIR,
  UPTIME_REPORT_TIMER_TEXT,
  UPTIME_REPORT_TIMER_UNIT,
  uptimeReportInstance,
} from "./uptime-report";

/** The image root steps run in through Docker (the agents pass `IMAGES.caddy.ref`). */
const IMAGE = `caddy:2.11.7-alpine@sha256:${"0".repeat(63)}1`;
/** The image the login removes data in (the agents pass `IMAGES.busybox.ref`). */
const BUSYBOX = `busybox:1.37.0@sha256:${"a".repeat(64)}`;
const COMMAND = "opscrew provision";

/** The first app, whose server it is: OpsCrew created the server for it. */
const FIRST = "inventory";
const FIRST_HOST = {
  app: FIRST,
  hostnames: ["inventory.example.com"],
  access: "public" as const,
  memoryMb: 1024,
};

// The deploy user's authorized_keys on the first app's server (the Accept's fixture): the first
// app's deploy key, another repository's scheduled check key, a preview key and a line OpsCrew
// did not write. The keys are made at runtime: public keys, never secrets.
const FIRST_KEY = `${ed25519PublicKey()} opscrew-deploy@inventory-0123456789ab`;
const OTHER_CHECK = checkKeyLine(ed25519PublicKey(), "example/other");
const PREVIEW = previewKeyLine(ed25519PublicKey(), "example/inventory", "inventory-preview");
const UNKNOWN = `${ed25519PublicKey()} someone@laptop`;
const FIXTURE = [FIRST_KEY, OTHER_CHECK, PREVIEW, UNKNOWN];

/** The second app's deploy key, and the one a rotation replaces it with. */
const APP_KEY = `${ed25519PublicKey()} opscrew-deploy@shop`;
const NEW_KEY = `${ed25519PublicKey()} opscrew-deploy@shop`;

/**
 * A server OpsCrew created for "inventory", which runs there: OpsCrew logs in as deploy, who has
 * no sudo and is in the docker group, cloud-init made the shared folders deploy's, and the
 * deploy user's keys are the fixture's.
 */
function createdServer(keys: readonly string[] = FIXTURE): FakeHost {
  const fake = new FakeHost({ login: "deploy", sudo: "none" });
  fake.dockerAccess = true;
  fake.dockerRunning = true;
  fake.runnerPrepared = true;
  fake.packages.set("docker-ce", "5:29.0.1-1~ubuntu.24.04~noble");
  fake.packages.set("docker-compose-plugin", "2.39.4");
  fake.packages.set("docker-buildx-plugin", "0.29.1");
  fake.users.set("deploy", {
    uid: 1000,
    password: false,
    keys: [...keys],
    groups: ["deploy", "docker"],
  });
  for (const path of [...SHARED_DIRS, RUNNERS_DIR]) {
    fake.dirs.set(path, { owner: "deploy", group: "deploy", mode: "750", entries: 0 });
  }
  for (const path of [`/srv/apps/${FIRST}`, `/srv/data/${FIRST}`]) {
    fake.dirs.set(path, { owner: "deploy", group: "deploy", mode: "750", entries: 0 });
  }
  fake.files.set(READY_FLAG, "");
  deployApp(fake, FIRST);
  return fake;
}

/** The second app "shop" beside "inventory". */
function second(fake: FakeHost, overrides: Partial<DesiredHost> = {}): DesiredHost {
  return desiredFor(fake, {
    deploy: { user: "deploy", publicKey: APP_KEY },
    shares: { host: FIRST_HOST },
    ...overrides,
  });
}

const facts = (fake: FakeHost) => inspectHost(fake, { rootImage: IMAGE });

function plan(
  found: HostFacts,
  desired: DesiredHost,
  options: { previousDeployKey?: string } = {},
): HostPlan {
  return planHost(found, desired, COMMAND, { ...options, image: BUSYBOX });
}

/** The teardown of `app` ("shop" by default), whose current deploy key is `deployKey`. */
function teardown(
  found: HostFacts,
  deleteData = false,
  options: { deployKey?: string; app?: string } = {},
): HostPlan {
  return planTeardown(
    found,
    {
      deleteData,
      app: options.app ?? "shop",
      projectId: SHOP_PROJECT,
      repositoryUrl: SHOP_REPOSITORY,
      shares: true,
      image: BUSYBOX,
      deployKey: options.deployKey ?? APP_KEY,
      firstApp: FIRST,
    },
    "opscrew destroy",
  );
}

const ids = (hostPlan: HostPlan) => hostPlan.steps.map((step) => step.id);
const codes = (hostPlan: HostPlan) => hostPlan.findings.map((finding) => finding.code);

function stepOf(hostPlan: HostPlan, id: HostStep["id"]): HostStep {
  const found = hostPlan.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no ${id} step`);
  return found;
}

/** The record of `app` the fake holds. */
function recordOf(fake: FakeHost, app: string) {
  const text = fake.files.get(`${APP_RECORDS_DIR}/${app}.json`);
  return text === undefined ? undefined : AppRecordSchema.parse(JSON.parse(text));
}

/** A record of another second app, "blog", as its own host plan would have written it. */
function blogRecord(hostnames: string[] = ["blog.example.com"]) {
  return JSON.stringify({
    schemaVersion: 1,
    app: "blog",
    projectId: "blog-0123456789ab",
    state: "active",
    access: "public",
    hostnames,
    folders: { app: "/srv/apps/blog", data: "/srv/data/blog" },
    composeProject: "blog",
    services: ["web"],
    memoryMb: 256,
    deployKey: ed25519PublicKey(),
    shares: { app: FIRST },
    repository: "https://github.com/example/blog",
  });
}

/** The shared root steps of a server's setup, which a second app's plan never holds. */
const SHARED_ROOT_STEPS = [
  "package-repair",
  "docker",
  "docker-daemon",
  "deploy-user",
  "sshd",
  "ufw",
  "ssh-firewall",
  "web-filter",
  "fail2ban",
  "unattended-upgrades",
  "sysctl",
  "runtime-dirs",
  "tunnel-connector",
  "portainer",
  "dns-updater",
  "edge",
];

describe("the second app's input and record", () => {
  it("takes the first app's description, and refuses a tunnel, a home or Portainer beside it", () => {
    const fake = createdServer();
    expect(DesiredHostSchema.safeParse(second(fake)).success).toBe(true);
    for (const extra of [
      { access: "tunnel" as const, tunnel: { compose: TUNNEL_COMPOSE, tunnelId: TUNNEL_ID } },
      { home: { ipv4: true } },
      { portainer: { version: "2.33.1", compose: { initial: "admin_password", final: "x" } } },
    ]) {
      const parsed = DesiredHostSchema.safeParse(second(fake, extra));
      expect(
        parsed.error?.issues.map((issue) => issue.path[0]),
        JSON.stringify(extra),
      ).toEqual(["shares"]);
    }
  });

  it("reads a record that names the first app and the project's repository", () => {
    const record = AppRecordSchema.parse(JSON.parse(blogRecord()));
    expect(record.shares).toEqual({ app: FIRST });
    expect(record.repository).toBe("https://github.com/example/blog");
  });
});

describe("planHost for a second app", () => {
  it("plans only the app's own steps, the record through Docker, with the docker privilege", async () => {
    const fake = createdServer();
    const found = await facts(fake);
    expect(found.privilege).toBe("docker");
    const hostPlan = plan(found, second(fake));
    expect(hostPlan.findings).toEqual([]);
    expect(ids(hostPlan)).toEqual(["deploy-key", "app-dirs", "app-record"]);
    expect(hostPlan.steps.every((step) => step.scope === "app")).toBe(true);
    expect(hostPlan.steps.every((step) => step.state === "change")).toBe(true);
    expect(stepOf(hostPlan, "deploy-key").params.runAs).toBe("login");
    expect(stepOf(hostPlan, "app-dirs").params.runAs).toBe("login");
    expect(stepOf(hostPlan, "app-record").params).toMatchObject({
      shares: FIRST,
      repository: SHOP_REPOSITORY,
    });
    expect(stepOf(hostPlan, "app-record").reason).not.toContain("host.json");

    // With the drills and the runner: still no shared root step.
    const full = plan(
      found,
      second(fake, {
        runner: runnerDesired(),
        drills: {
          files: { "compose.yaml": "services: {}\n", schedule: "weekly\n" },
          valuesSha256: sha256Hex(""),
        },
      }),
    );
    expect(ids(full)).toEqual(["deploy-key", "app-dirs", "app-record", "drills", "github-runner"]);
    expect(full.steps.filter((step) => SHARED_ROOT_STEPS.includes(step.id))).toEqual([]);
    expect(stepOf(full, "drills").params.runAs).toBe("login");
    expect(stepOf(full, "github-runner").params.runAs).toBe("login");
  });

  it("blocks a login that is root or uses sudo, and one that cannot become root through Docker", async () => {
    const root = new FakeHost();
    const sudo = new FakeHost({ login: "alice" });
    const sudoPassword = new FakeHost({ login: "alice", sudo: "password" });
    const none = createdServer();
    none.dockerAccess = false;
    // A login in the docker group other than deploy: not the server OpsCrew created.
    const other = new FakeHost({ login: "alice", sudo: "none" });
    other.dockerAccess = true;
    for (const [fake, privilege] of [
      [root, "root"],
      [sudo, "sudo"],
      [sudoPassword, "sudo-password"],
      [none, "none"],
      [other, "docker"],
    ] as const) {
      const found = await facts(fake);
      expect(found.privilege).toBe(privilege);
      const hostPlan = plan(found, second(fake));
      expect(hostPlan.findings.length, privilege).toBeGreaterThan(0);
      expect(hostPlan.findings.map((finding) => finding.message).join(" "), privilege).toContain(
        `"${FIRST}"`,
      );
      expect(
        hostPlan.steps.every((step) => step.state === "blocked"),
        privilege,
      ).toBe(true);
      expect(hostPlan.steps.filter((step) => SHARED_ROOT_STEPS.includes(step.id))).toEqual([]);
    }
  });

  it("needs the image the login removes data in", async () => {
    const fake = createdServer();
    const found = await facts(fake);
    expect(() => planHost(found, second(fake), COMMAND)).toThrow(
      /image the deploy user removes data in/,
    );
  });
});

describe("a second app's claims, over the records and the first app's description", () => {
  /** The plan's findings whose message names "inventory". */
  async function namingFirst(
    desired: (fake: FakeHost) => DesiredHost,
    setup?: (fake: FakeHost) => void,
  ) {
    const fake = createdServer();
    setup?.(fake);
    const hostPlan = plan(await facts(fake), desired(fake));
    expect(stepOf(hostPlan, "app-record").state).toBe("blocked");
    return hostPlan.findings.filter((finding) => finding.message.includes(`"${FIRST}"`));
  }

  it("refuses the first app's name", async () => {
    const found = await namingFirst((fake) => second(fake, { app: FIRST }));
    expect(found.map((finding) => finding.code)).toContain("first-app-name");
  });

  it("refuses a hostname of the first app's", async () => {
    const found = await namingFirst((fake) =>
      second(fake, { hostnames: ["shop.example.com", "inventory.example.com"] }),
    );
    expect(found.map((finding) => finding.code)).toEqual(["hostname-taken"]);
    expect(found[0]?.message).toContain("inventory.example.com");
  });

  it("refuses a way of serving other than the first app's", async () => {
    const found = await namingFirst((fake) =>
      second(fake, { shares: { host: { ...FIRST_HOST, access: "web-filter" } } }),
    );
    expect(found.map((finding) => finding.code)).toEqual(["access-mode-conflict"]);
  });

  it("refuses a name OpsCrew reads as one of the first app's previews", async () => {
    const found = await namingFirst((fake) => second(fake, { app: `${FIRST}-pr-3` }));
    expect(found.map((finding) => finding.code)).toEqual(["app-name-preview"]);
  });

  it("refuses a hostname another second app's record holds, naming that app", async () => {
    const fake = createdServer();
    fake.files.set(`${APP_RECORDS_DIR}/blog.json`, blogRecord(["shop.example.com"]));
    const hostPlan = plan(await facts(fake), second(fake));
    expect(codes(hostPlan)).toEqual(["hostname-taken"]);
    expect(hostPlan.findings[0]?.message).toContain('"blog"');
    expect(hostPlan.otherApps?.map((other) => other.app)).toEqual(["blog"]);
  });

  it("blocks a kernel setting of the whole server, which is the first app's server setup", async () => {
    const fake = createdServer();
    const hostPlan = plan(
      await facts(fake),
      second(fake, { sysctl: { "vm.max_map_count": "262144" } }),
    );
    expect(codes(hostPlan)).toEqual(["server-setting-needed"]);
    expect(hostPlan.findings[0]?.message).toContain(`"${FIRST}"`);
    expect(hostPlan.findings[0]?.message).toContain("vm.max_map_count");
    expect(ids(hostPlan)).not.toContain("sysctl");
  });

  it("blocks a server without the shared folders OpsCrew's first boot makes", async () => {
    const fake = createdServer();
    fake.dirs.delete("/srv/edge");
    const hostPlan = plan(await facts(fake), second(fake));
    expect(codes(hostPlan)).toEqual(["shared-dirs-missing"]);
    expect(hostPlan.findings[0]?.message).toContain("/srv/edge");
    expect(ids(hostPlan)).not.toContain("runtime-dirs");
  });
});

describe.skipIf(!SH_AVAILABLE)("the second app's deploy-key step in a real shell", () => {
  const KEYS = "/home/deploy/.ssh/authorized_keys";

  /** A harness whose deploy user lives in its root's /home/deploy. */
  function harness(): ShellHarness {
    const h = new ShellHarness();
    h.stub("getent", `echo "deploy:x:1000:1000::${h.root}/home/deploy:/bin/sh"`, { log: false });
    h.stub("id", "echo 1000", { log: false });
    return h;
  }
  const text = (h: ShellHarness, lines: readonly string[]) =>
    lines.map((line) => `${h.rooted(line)}\n`).join("");
  const scriptsOf = (hostPlan: HostPlan) => stepScripts(hostPlan, stepOf(hostPlan, "deploy-key"));

  it("keeps every other line in its order and adds the app's key; a rotation keeps the old one; the removal drops only the app's lines", async () => {
    const fake = createdServer();
    const setup = plan(await facts(fake), second(fake));
    const add = scriptsOf(setup);
    const h = harness();
    try {
      h.write(KEYS, text(h, FIXTURE));
      expect(h.run(add.check).stdout).toContain("state=change");
      const applied = h.run(add.apply);
      expect(applied.status, applied.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, [...FIXTURE, APP_KEY]));
      const verified = h.run(add.verify);
      expect(verified.status, verified.stderr).toBe(0);
      expect(h.run(add.check).stdout).toContain("state=in-place");

      // The same plan applied on the fake server: its record now names the app's key.
      await applyApproved(fake, setup, { rootImage: IMAGE });
      expect(fake.users.get("deploy")?.keys).toEqual([...FIXTURE, APP_KEY]);
      const after = await facts(fake);

      // A rotation: the new key, with the old one beside it until the new one proved itself.
      const rotation = scriptsOf(
        plan(after, second(fake, { deploy: { user: "deploy", publicKey: NEW_KEY } }), {
          previousDeployKey: APP_KEY,
        }),
      );
      const rotated = h.run(rotation.apply);
      expect(rotated.status, rotated.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, [...FIXTURE, NEW_KEY, APP_KEY]));
      expect(h.run(rotation.verify).status).toBe(0);

      // The teardown's removal: the app's line goes, the others stay as they were.
      const removal = scriptsOf(teardown(after));
      h.write(KEYS, text(h, [...FIXTURE, APP_KEY]));
      expect(h.run(removal.check).stdout).toContain("state=change");
      const removed = h.run(removal.apply);
      expect(removed.status, removed.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, FIXTURE));
      expect(h.run(removal.verify).status).toBe(0);
      expect(h.run(removal.check).stdout).toContain("state=in-place");
    } finally {
      h.dispose();
    }
  });

  /**
   * The fake server and the shell's file with "shop" set up there, then the first step of a
   * rotation applied to both: the new key, the old one beside it in the file and in the record.
   */
  async function midRotation(h: ShellHarness) {
    const fake = createdServer();
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    h.write(KEYS, text(h, [...FIXTURE, APP_KEY]));
    const add = plan(
      await facts(fake),
      second(fake, { deploy: { user: "deploy", publicKey: NEW_KEY } }),
      {
        previousDeployKey: APP_KEY,
      },
    );
    expect(stepOf(add, "app-record").params).toMatchObject({ previousDeployKey: APP_KEY });
    const added = h.run(scriptsOf(add).apply);
    expect(added.status, added.stderr).toBe(0);
    await applyApproved(fake, add, { rootImage: IMAGE });
    expect(recordOf(fake, "shop")).toMatchObject({
      deployKey: NEW_KEY,
      previousDeployKey: APP_KEY,
    });
    expect(h.read(KEYS)).toBe(text(h, [...FIXTURE, NEW_KEY, APP_KEY]));
    return fake;
  }

  it("removes a rotation's old key once the new one proved itself, and the record forgets it", async () => {
    const h = harness();
    try {
      const fake = await midRotation(h);
      // The second step names only the new key: the record's old key is the app's line too.
      const done = plan(
        await facts(fake),
        second(fake, { deploy: { user: "deploy", publicKey: NEW_KEY } }),
      );
      const finish = scriptsOf(done);
      expect(h.run(finish.check).stdout).toContain("state=change");
      const finished = h.run(finish.apply);
      expect(finished.status, finished.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, [...FIXTURE, NEW_KEY]));
      expect(h.run(finish.verify).status).toBe(0);
      await applyApproved(fake, done, { rootImage: IMAGE });
      const record = recordOf(fake, "shop");
      expect(record?.deployKey).toBe(NEW_KEY);
      expect(record).not.toHaveProperty("previousDeployKey");
      expect(fake.users.get("deploy")?.keys).toEqual([...FIXTURE, NEW_KEY]);
      // Planned again, nothing changes.
      const again = plan(
        await facts(fake),
        second(fake, { deploy: { user: "deploy", publicKey: NEW_KEY } }),
      );
      expect(again.steps.filter((item) => item.state === "change")).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it("removes both of the app's keys in a teardown during a rotation", async () => {
    const h = harness();
    try {
      const fake = await midRotation(h);
      const removal = scriptsOf(teardown(await facts(fake), false, { deployKey: NEW_KEY }));
      const removed = h.run(removal.apply);
      expect(removed.status, removed.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, FIXTURE));
      expect(h.run(removal.verify).status).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("refuses to write when the file changed since the inspection the plan was made from", async () => {
    const fake = createdServer();
    const add = scriptsOf(plan(await facts(fake), second(fake)));
    const h = harness();
    try {
      for (const changed of [
        // The first app's key replaced, a line added, a line gone.
        [
          `${ed25519PublicKey()} opscrew-deploy@inventory-0123456789ab`,
          OTHER_CHECK,
          PREVIEW,
          UNKNOWN,
        ],
        [...FIXTURE, `${ed25519PublicKey()} someone-else@laptop`],
        [FIRST_KEY, OTHER_CHECK, PREVIEW],
      ]) {
        const before = text(h, changed);
        h.write(KEYS, before);
        const refused = h.run(add.apply);
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain("changed since this plan was made");
        expect(h.read(KEYS)).toBe(before);
      }
    } finally {
      h.dispose();
    }
  });

  it("writes nothing when the lines it keeps cannot be read, in a setup and in a teardown", async () => {
    const fake = createdServer();
    const add = scriptsOf(plan(await facts(fake), second(fake)));
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    const removal = scriptsOf(teardown(await facts(fake)));
    const h = harness();
    try {
      // The filter that keeps the other lines fails part-way (it prints a line, then exits 1).
      h.stub("awk", "echo half-a-line; exit 1", { log: false });
      for (const [scripts, lines] of [
        [add, FIXTURE],
        [removal, [...FIXTURE, APP_KEY]],
      ] as const) {
        const before = text(h, lines);
        h.write(KEYS, before);
        const refused = h.run(scripts.apply);
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toMatch(/could not read .*authorized_keys, so it changed nothing/);
        expect(h.read(KEYS)).toBe(before);
      }
    } finally {
      h.dispose();
    }
  });

  it("reads lines that end in CRLF and a last line without a newline", async () => {
    const fake = createdServer();
    const add = scriptsOf(plan(await facts(fake), second(fake)));
    const h = harness();
    try {
      const rooted = FIXTURE.map((line) => h.rooted(line));
      h.write(KEYS, rooted.join("\r\n"));
      const applied = h.run(add.apply);
      expect(applied.status, applied.stderr).toBe(0);
      // Every line stays, in its order, the last one ended so the app's key is a line of its own.
      // (dash keeps a line's CR, Git Bash's sh drops it: sshd reads the key either way.)
      expect(h.read(KEYS)?.replaceAll("\r", "")).toBe(`${[...rooted, APP_KEY].join("\n")}\n`);
      const verified = h.run(add.verify);
      expect(verified.status, verified.stderr).toBe(0);
    } finally {
      h.dispose();
    }
  });

  it("adds the app's key to an empty file, and writes nothing when the file is missing", async () => {
    const fake = createdServer([]);
    const add = scriptsOf(plan(await facts(fake), second(fake)));
    const empty = harness();
    try {
      empty.write(KEYS, "");
      const applied = empty.run(add.apply);
      expect(applied.status, applied.stderr).toBe(0);
      expect(empty.read(KEYS)).toBe(`${APP_KEY}\n`);
      expect(empty.run(add.verify).status).toBe(0);
    } finally {
      empty.dispose();
    }
    const missing = harness();
    try {
      missing.write("/home/deploy/.ssh/known_hosts", "");
      const refused = missing.run(add.apply);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("changed nothing");
      expect(missing.exists(KEYS)).toBe(false);
    } finally {
      missing.dispose();
    }
  });

  it("removes the app's key in a teardown after a provision that stopped before its record", async () => {
    // The deploy-key step ran, the record's did not: the line holds the app's current key.
    const fake = createdServer([...FIXTURE, APP_KEY]);
    const hostPlan = teardown(await facts(fake));
    expect(hostPlan.findings).toEqual([]);
    expect(ids(hostPlan)).not.toContain("app-record");
    const removal = scriptsOf(hostPlan);
    const h = harness();
    try {
      h.write(KEYS, text(h, [...FIXTURE, APP_KEY]));
      const removed = h.run(removal.apply);
      expect(removed.status, removed.stderr).toBe(0);
      expect(h.read(KEYS)).toBe(text(h, FIXTURE));
    } finally {
      h.dispose();
    }
  });
});

describe("planTeardown of a second app", () => {
  /** "shop" provisioned and deployed beside "inventory", with Portainer and its check key there. */
  async function withShop(): Promise<FakeHost> {
    const shopCheck = checkKeyLine(ed25519PublicKey(), "acme/shop");
    const fake = createdServer([...FIXTURE, shopCheck]);
    fake.files.set(`${PORTAINER_DIR}/compose.yaml`, "name: opscrew-portainer\n");
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    deployApp(fake, "shop");
    return fake;
  }

  it("keeps the edge, the check key and Portainer with no other record, and the record as data kept", async () => {
    const fake = await withShop();
    const keys = fake.users.get("deploy")?.keys ?? [];
    const found = await facts(fake);
    expect(found.apps.map((app) => app.name)).toEqual(["shop"]);
    const hostPlan = teardown(found);
    expect(hostPlan.findings).toEqual([]);
    // The key line goes last: every step logs in with it (live pass L1, run 6).
    expect(ids(hostPlan)).toEqual(["app-dirs", "app-record", "deploy-key"]);
    expect(hostPlan.steps.filter((step) => SHARED_ROOT_STEPS.includes(step.id))).toEqual([]);
    expect(ids(hostPlan)).not.toContain("check-key");
    expect(stepOf(hostPlan, "app-dirs").params).toMatchObject({ runAs: "login", image: BUSYBOX });
    expect(stepOf(hostPlan, "app-record").params).toMatchObject({ keepData: true });

    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    // Only the app's key line went; every other line stayed, in its order.
    expect(fake.users.get("deploy")?.keys).toEqual(keys.filter((line) => line !== APP_KEY));
    expect(recordOf(fake, "shop")).toMatchObject({
      state: "data-kept",
      shares: { app: FIRST },
      repository: SHOP_REPOSITORY,
    });
    expect(fake.containers.some((container) => container.project === "opscrew-edge")).toBe(true);
    expect(fake.containers.some((container) => container.project === FIRST)).toBe(true);
    expect(fake.files.has(`${PORTAINER_DIR}/compose.yaml`)).toBe(true);
    expect(fake.files.has(RECORD_PATH)).toBe(false);
  });

  it("blocks every step for the first app's name, naming it", async () => {
    const hostPlan = teardown(await facts(createdServer()), true, { app: FIRST });
    expect(codes(hostPlan)).toContain("first-app-name");
    expect(hostPlan.findings.map((finding) => finding.message).join(" ")).toContain(`"${FIRST}"`);
    expect(hostPlan.steps.length).toBeGreaterThan(0);
    expect(hostPlan.steps.every((step) => step.state === "blocked")).toBe(true);
  });

  it("blocks every step over containers of the app's name with no record of this project's", async () => {
    const fake = createdServer();
    fake.containers.push({ name: "shop-web-1", project: "shop", ports: "" });
    const hostPlan = teardown(await facts(fake), true);
    expect(codes(hostPlan)).toEqual(["compose-project-exists"]);
    expect(hostPlan.findings[0]?.message).toContain('"shop"');
    expect(hostPlan.steps.length).toBeGreaterThan(0);
    expect(hostPlan.steps.every((step) => step.state === "blocked")).toBe(true);
  });

  it("removes the record with the data", async () => {
    const fake = await withShop();
    const hostPlan = teardown(await facts(fake), true);
    expect(stepOf(hostPlan, "app-record").params).toMatchObject({ keepData: false });
    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    expect(recordOf(fake, "shop")).toBeUndefined();
    expect(fake.dirs.has("/srv/data/shop")).toBe(false);
    expect(fake.dirs.has(`/srv/data/${FIRST}`)).toBe(true);
  });

  it("needs the image the login removes data in", async () => {
    const found = await facts(createdServer());
    expect(() =>
      planTeardown(
        found,
        { deleteData: true, app: "shop", projectId: SHOP_PROJECT, shares: true },
        "opscrew destroy",
      ),
    ).toThrow(/image the deploy user removes data in/);
  });
});

describe("inspecting a server OpsCrew created", () => {
  it("reads the records as root through Docker with the image, and none without it", async () => {
    const fake = createdServer();
    fake.files.set(`${APP_RECORDS_DIR}/blog.json`, blogRecord());
    const withoutImage = await inspectHost(fake);
    expect(withoutImage.apps).toEqual([]);
    fake.calls.length = 0;
    const found = await facts(fake);
    expect(found.apps.map((app) => app.record?.shares)).toEqual([{ app: FIRST }]);
    const reads = fake.calls.filter((call) => call.docker !== undefined).map((call) => call.name);
    expect(reads).toEqual(["network.inspect"]);
    expect(fake.calls.find((call) => call.name === "network.inspect")?.command).toBe(
      dockerRootCommand(IMAGE),
    );
  });

  it("finds no records on a server without /etc/opscrew/apps", async () => {
    const fake = createdServer();
    expect([...fake.files.keys()].some((path) => path.startsWith("/etc/opscrew"))).toBe(false);
    expect((await facts(fake)).apps).toEqual([]);
  });
});

describe("applying a second app's plan", () => {
  /** The scripts that ran, by how: through Docker (as root), or as the login. */
  function byHow(fake: FakeHost) {
    const steps = fake.calls.filter((call) => /\.(check|apply|verify)$/.test(call.name));
    return {
      docker: steps.filter((call) => call.docker !== undefined).map((call) => call.name),
      login: steps
        .filter((call) => call.docker === undefined)
        .map((call) => {
          expect(call.command.startsWith("sh -c "), call.name).toBe(true);
          return call.name;
        }),
    };
  }

  it("runs only the record through Docker, every other step as the login, and writes no host record", async () => {
    const fake = createdServer();
    const hostPlan = plan(
      await facts(fake),
      second(fake, {
        runner: runnerDesired(),
        drills: {
          files: { "compose.yaml": "services: {}\n", schedule: "weekly\n" },
          valuesSha256: sha256Hex(""),
        },
      }),
    );
    fake.calls.length = 0;
    const result = await applyApproved(fake, hostPlan, {
      rootImage: IMAGE,
      secrets: { previewValues: "" },
      runnerToken: async () => runnerToken(),
    });
    expect(result.applied).toEqual([
      "deploy-key",
      "app-dirs",
      "app-record",
      "drills",
      "github-runner",
    ]);
    const how = byHow(fake);
    expect(new Set(how.docker)).toEqual(
      new Set(["app-record.check", "app-record.apply", "app-record.verify"]),
    );
    expect(how.login.some((name) => name.startsWith("deploy-key."))).toBe(true);
    expect(how.login.some((name) => name.startsWith("app-dirs."))).toBe(true);
    expect(how.login.some((name) => name.startsWith("drills."))).toBe(true);
    expect(how.login.some((name) => name.startsWith("github-runner."))).toBe(true);
    // The other apps are read as root through Docker before the first change; no host record.
    expect(
      fake.calls.filter((call) => call.docker !== undefined).map((call) => call.name),
    ).toContain("apps.read");
    expect(fake.calls.some((call) => call.name.startsWith("record."))).toBe(false);
    expect(fake.files.has(RECORD_PATH)).toBe(false);
    expect(recordOf(fake, "shop")).toMatchObject({
      state: "active",
      access: "public",
      deployKey: APP_KEY,
      shares: { app: FIRST },
      repository: SHOP_REPOSITORY,
    });
    expect(fake.users.get("deploy")?.keys).toEqual([...FIXTURE, APP_KEY]);

    // Planned again, everything is in place.
    const again = plan(
      await facts(fake),
      second(fake, {
        runner: runnerDesired(),
        drills: {
          files: { "compose.yaml": "services: {}\n", schedule: "weekly\n" },
          valuesSha256: sha256Hex(""),
        },
      }),
    );
    expect(again.steps.filter((step) => step.state === "change").map((step) => step.id)).toEqual(
      [],
    );
  });

  it("runs only the record's removal through Docker in a teardown", async () => {
    const fake = createdServer();
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    deployApp(fake, "shop");
    const hostPlan = teardown(await facts(fake), true);
    fake.calls.length = 0;
    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    const how = byHow(fake);
    expect(new Set(how.docker)).toEqual(
      new Set([
        "app-record.teardown.check",
        "app-record.teardown.apply",
        "app-record.teardown.verify",
      ]),
    );
    expect(how.login.some((name) => name.startsWith("app-dirs.teardown."))).toBe(true);
    expect(how.login.some((name) => name.startsWith("deploy-key."))).toBe(true);
    expect(fake.files.has(RECORD_PATH)).toBe(false);
  });

  it("removes the app's key line last, checked in its own run, since every later login needs it", async () => {
    // Live pass L1, run 6: a check after the key line went logged in with that key and was refused.
    const fake = createdServer();
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    deployApp(fake, "shop");
    const hostPlan = teardown(await facts(fake), true);
    expect(hostPlan.steps.at(-1)?.id).toBe("deploy-key");
    fake.calls.length = 0;
    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    const names = fake.calls
      .filter((call) => /\.(check|apply|verify)$/.test(call.name))
      .map((call) => call.name);
    expect(names.at(-1)).toBe("deploy-key.app.apply");
    expect(names).not.toContain("deploy-key.app.verify");
    expect(fake.users.get("deploy")?.keys).not.toContain(APP_KEY);
  });

  it("refuses the plan when another app's record appeared since it was made", async () => {
    const fake = createdServer();
    const hostPlan = plan(await facts(fake), second(fake));
    fake.files.set(`${APP_RECORDS_DIR}/blog.json`, blogRecord());
    await expect(applyApproved(fake, hostPlan, { rootImage: IMAGE })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    });
    expect(recordOf(fake, "shop")).toBeUndefined();
    expect(fake.users.get("deploy")?.keys).toEqual(FIXTURE);
  });
});

describe("a second app's uptime report (feature 046)", () => {
  const SHOP_REPORT = uptimeReportInstance("acme/shop/shop/prod");
  const FIRST_REPORT = uptimeReportInstance("example/inventory/inventory/prod");
  const conf = (instance: string) => `${UPTIME_REPORT_CONFIG_DIR}/${instance}.conf`;
  const keyFile = (instance: string) => `${UPTIME_REPORT_CONFIG_DIR}/${instance}.key`;
  const stateFile = (instance: string) => `${UPTIME_REPORT_STATE_DIR}/${instance}/state`;
  const UNITS = [UPTIME_REPORT_SCRIPT, UPTIME_REPORT_SERVICE_UNIT, UPTIME_REPORT_TIMER_UNIT];

  /** "shop" set up beside "inventory", each app in `apps` with its report as its step left it. */
  async function withReports(apps: readonly [string, string][]): Promise<FakeHost> {
    const fake = createdServer();
    await applyApproved(fake, plan(await facts(fake), second(fake)), { rootImage: IMAGE });
    deployApp(fake, "shop");
    fake.files.set(UPTIME_REPORT_SCRIPT, renderUptimeReportScript());
    fake.files.set(UPTIME_REPORT_SERVICE_UNIT, UPTIME_REPORT_SERVICE_TEXT);
    fake.files.set(UPTIME_REPORT_TIMER_UNIT, UPTIME_REPORT_TIMER_TEXT);
    fake.madeDirs.add(UPTIME_REPORT_CONFIG_DIR);
    for (const [instance, app] of apps) {
      fake.files.set(conf(instance), `app=${app}\n`);
      fake.files.set(keyFile(instance), `${"ab".repeat(32)}\n`);
      fake.files.set(stateFile(instance), "sent 1\n");
      fake.uptimeReportTimers.add(instance);
    }
    return fake;
  }

  it("is read as root through Docker, and the share's teardown removes only its own", async () => {
    const fake = await withReports([
      [SHOP_REPORT, "shop"],
      [FIRST_REPORT, FIRST],
    ]);
    // The login can't list the folder (0700, root's): only the read through Docker finds them.
    expect((await inspectHost(fake)).uptimeReport?.instances).toEqual([]);
    const found = await facts(fake);
    expect(found.uptimeReport?.instances.map((item) => [item.instance, item.app]).sort()).toEqual(
      [
        [SHOP_REPORT, "shop"],
        [FIRST_REPORT, FIRST],
      ].sort(),
    );
    const hostPlan = teardown(found);
    expect(hostPlan.steps.find((step) => step.id === "uptime-report")).toMatchObject({
      state: "change",
      params: { remove: true, instances: SHOP_REPORT, shared: false },
    });
    fake.calls.length = 0;
    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    const removal = fake.calls.filter((call) => call.name.startsWith("uptime-report."));
    expect(removal.length).toBeGreaterThan(0);
    expect(removal.every((call) => call.docker !== undefined)).toBe(true);
    // shop's timer, config, key and state are gone; inventory's and the shared files stay.
    expect(fake.uptimeReportTimers.has(SHOP_REPORT)).toBe(false);
    for (const path of [conf(SHOP_REPORT), keyFile(SHOP_REPORT), stateFile(SHOP_REPORT)]) {
      expect(fake.files.has(path), path).toBe(false);
    }
    expect(fake.uptimeReportTimers.has(FIRST_REPORT)).toBe(true);
    for (const path of [conf(FIRST_REPORT), keyFile(FIRST_REPORT), stateFile(FIRST_REPORT)]) {
      expect(fake.files.has(path), path).toBe(true);
    }
    for (const path of UNITS) expect(fake.files.has(path), path).toBe(true);
  });

  it("removes the script and units with the share's report when it is the last one", async () => {
    const fake = await withReports([[SHOP_REPORT, "shop"]]);
    const hostPlan = teardown(await facts(fake));
    expect(hostPlan.steps.find((step) => step.id === "uptime-report")?.params).toEqual({
      remove: true,
      instances: SHOP_REPORT,
      shared: true,
    });
    await applyApproved(fake, hostPlan, { command: "opscrew destroy", rootImage: IMAGE });
    expect(fake.uptimeReportTimers.size).toBe(0);
    for (const path of [...UNITS, conf(SHOP_REPORT), keyFile(SHOP_REPORT)]) {
      expect(fake.files.has(path), path).toBe(false);
    }
    // The first app is untouched.
    expect(fake.dirs.has(`/srv/apps/${FIRST}`)).toBe(true);
    expect(fake.containers.some((container) => container.project === FIRST)).toBe(true);
    expect(fake.users.get("deploy")?.keys).toEqual(FIXTURE);
  });
});
