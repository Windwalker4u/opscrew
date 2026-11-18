/**
 * A server at home: SSH only from the home network (`DesiredHost.sshFrom`, the runner machines'
 * `ssh-firewall` step unchanged), nftables installed on a home server that lacks it, the table
 * shared by the home apps, and the app record's `home`, with home and non-home apps (or home apps
 * served over different address families) refused on one server.
 */
import { describe, expect, it } from "vitest";
import { deployApp, FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  DEPLOY_KEY,
  desiredFor,
  planFor,
  provision,
  rejection,
  removeApp,
  SHOP_REPOSITORY,
  scriptsFor,
} from "./__fixtures__/helpers";
import { AppRecordSchema } from "./facts";
import { hostPlanHash } from "./hash";
import { inspectHost } from "./inspect";
import { planRunnerHost, planUndo } from "./plan";
import { sshFirewallListing } from "./ssh-firewall";
import { stepScripts } from "./steps";
import type { DesiredHost, HostPlan, HostStep } from "./types";

const HOME = { ipv4: true } as const;
const SSH_FROM = ["fe80::/10", "192.168.1.0/24"];

const codes = (plan: HostPlan) => plan.findings.map((finding) => finding.code);
const firewallStep = (plan: HostPlan) => plan.steps.find((step) => step.id === "ssh-firewall");
const recordStep = (plan: HostPlan) => plan.steps.find((step) => step.id === "app-record");

function present(step: HostStep | undefined): HostStep {
  if (step === undefined) throw new Error("no such step");
  return step;
}

/** A server at home that OpsCrew reaches from 192.168.1.40, on the home network. */
function homeServer(): FakeHost {
  const fake = new FakeHost();
  fake.sshClient = { address: "192.168.1.40", port: 22 };
  return fake;
}

function home(fake: FakeHost, overrides: Partial<DesiredHost> = {}): DesiredHost {
  return desiredFor(fake, { home: HOME, sshFrom: SSH_FROM, ...overrides });
}

function blog(fake: FakeHost, overrides: Partial<DesiredHost> = {}): DesiredHost {
  return desiredFor(fake, {
    app: "blog",
    projectId: "blog-1",
    hostnames: ["blog.example.com"],
    deploy: { user: "deploy", publicKey: DEPLOY_KEY.replace("opscrew-deploy", "blog-deploy") },
    ...overrides,
  });
}

function appRecord(fake: FakeHost, app: string) {
  const text = fake.files.get(`/etc/opscrew/apps/${app}.json`);
  return text === undefined ? undefined : AppRecordSchema.parse(JSON.parse(text));
}

describe("SSH only from the home network", () => {
  it("adds the ssh-firewall step when the desired host has sshFrom, applied under the automatic undo", async () => {
    const fake = homeServer();
    const plan = await planFor(fake, home(fake));
    expect(codes(plan)).toEqual([]);
    const ids = plan.steps.map((item) => item.id);
    expect(ids.indexOf("ssh-firewall")).toBe(ids.indexOf("ufw") + 1);
    const step = firewallStep(plan);
    expect(step).toMatchObject({
      state: "change",
      scope: "shared",
      title: "SSH firewall: port 22 only from 192.168.1.0/24 and fe80::/10",
      params: { sources: "192.168.1.0/24 fe80::/10", ports: "22", from: "192.168.1.40" },
    });
    expect(step?.reason).toContain("OpsCrew applies it from 192.168.1.40");
    expect(stepScripts(plan, present(step)).deadMan?.step).toBe("ssh-firewall");

    const result = await applyApproved(fake, plan);
    expect(result.applied).toContain("ssh-firewall");
    expect(fake.sshFirewall).toEqual({
      table: sshFirewallListing({ sources: ["192.168.1.0/24", "fe80::/10"], ports: [22] }),
      enabled: true,
    });
    expect(firewallStep(await planFor(fake, home(fake)))?.state).toBe("in-place");
  });

  it("is refused when OpsCrew's own address is outside the sources", async () => {
    const fake = homeServer();
    const plan = await planFor(fake, home(fake, { sshFrom: ["203.0.113.0/24"] }));
    expect(codes(plan)).toEqual(["ssh-firewall-locks-out"]);
    expect(firewallStep(plan)?.state).toBe("blocked");
  });

  it("installs nftables on a home server without nft, and blocks without home", async () => {
    const fake = homeServer();
    fake.nftInstalled = false;
    const plan = await planFor(fake, home(fake));
    expect(codes(plan)).toEqual([]);
    const step = firewallStep(plan);
    expect(step).toMatchObject({
      state: "change",
      params: {
        sources: "192.168.1.0/24 fe80::/10",
        ports: "22",
        from: "192.168.1.40",
        install: "nftables",
      },
    });
    expect(step?.reason).toMatch(/^OpsCrew installs nftables \(the nft command\) first\. /);
    const scripts = stepScripts(plan, present(step));
    expect(scripts.preApply).toContain("apt_get install --no-install-recommends nftables");

    await applyApproved(fake, plan);
    expect(fake.nftInstalled).toBe(true);
    expect(fake.sshFirewall.enabled).toBe(true);

    const bare = homeServer();
    bare.nftInstalled = false;
    const notHome = await planFor(bare, desiredFor(bare, { sshFrom: SSH_FROM }));
    expect(codes(notHome)).toEqual(["no-nft"]);
    expect(firewallStep(notHome)?.state).toBe("blocked");
  });

  it("keeps every render unchanged without sshFrom, home and install", async () => {
    const fake = homeServer();
    const plain = await planFor(fake);
    expect(firewallStep(plain)).toBeUndefined();
    expect(recordStep(plain)?.params).not.toHaveProperty("homeIpv4");
    const firewall = scriptsFor({
      id: "ssh-firewall",
      params: { sources: "192.168.1.0/24", ports: "22", from: "192.168.1.40" },
    });
    expect(firewall.preApply).toBeUndefined();
    const installing = scriptsFor({
      id: "ssh-firewall",
      params: { sources: "192.168.1.0/24", ports: "22", from: "192.168.1.40", install: "nftables" },
    });
    expect({ ...installing, preApply: undefined }).toEqual({ ...firewall, preApply: undefined });

    await applyApproved(fake, plain);
    const record = fake.files.get("/etc/opscrew/apps/shop.json") ?? "";
    expect(record).not.toContain("home");
    expect(Object.keys(JSON.parse(record))).toEqual([
      "schemaVersion",
      "app",
      "projectId",
      "state",
      "access",
      "hostnames",
      "folders",
      "composeProject",
      "services",
      "memoryMb",
      "deployKey",
    ]);
  });

  it("stays as it is while other home apps are there; planUndo still removes it", async () => {
    const fake = homeServer();
    await provision(fake, home(fake));
    deployApp(fake, "shop");
    const table = fake.sshFirewall.table;
    // The same sources in another order: nothing to say.
    const same = await planFor(
      fake,
      home(fake, { ...blog(fake), sshFrom: [...SSH_FROM].reverse() }),
    );
    expect(firewallStep(same)?.reason).toBe(
      'OpsCrew\'s SSH firewall is already set for "shop"; OpsCrew leaves it as it is.',
    );
    const plan = await planFor(fake, home(fake, { ...blog(fake), sshFrom: ["192.168.1.0/25"] }));
    expect(codes(plan)).toEqual([]);
    expect(firewallStep(plan)).toMatchObject({ state: "in-place" });
    // Other sources: a warning in the step (it does not block), naming no address.
    expect(firewallStep(plan)?.reason).toBe(
      'OpsCrew\'s SSH firewall is already set for "shop"; OpsCrew leaves it as it is. The networks you named for "blog" differ from the ones SSH already allows: the SSH firewall keeps the ones it has.',
    );
    await applyApproved(fake, plan);
    expect(fake.sshFirewall.table).toBe(table);

    await removeApp(fake, "blog");
    await removeApp(fake, "shop");
    expect(fake.sshFirewall.table).toBe(table);
    const undo = planUndo(
      await inspectHost(fake),
      { repositoryUrl: SHOP_REPOSITORY },
      "opscrew destroy --undo-host",
    );
    expect(firewallStep(undo)).toMatchObject({ state: "change", params: { remove: true } });
  });

  it("stays on a runner machine that is also a home server, without harden.firewall", async () => {
    const fake = homeServer();
    await provision(fake, home(fake));
    const table = fake.sshFirewall.table;
    const runnerPlan = () =>
      inspectHost(fake).then((facts) =>
        planRunnerHost(
          facts,
          { repositoryUrl: SHOP_REPOSITORY, runners: [] },
          "opscrew runner host add home",
        ),
      );
    const plan = await runnerPlan();
    expect(firewallStep(plan)).toBeUndefined();
    await applyApproved(fake, plan);
    expect(fake.sshFirewall.table).toBe(table);

    // Without a home app's record, the runner machine's plan removes it, as before.
    await removeApp(fake, "shop", false);
    expect(firewallStep(await runnerPlan())).toMatchObject({
      state: "change",
      params: { remove: true },
    });
  });

  it("plans the table again for another home app when it is missing", async () => {
    const fake = homeServer();
    await provision(fake, desiredFor(fake, { home: HOME }));
    deployApp(fake, "shop");
    const plan = await planFor(fake, home(fake, blog(fake)));
    expect(firewallStep(plan)?.state).toBe("change");
  });
});

describe("the app record's home", () => {
  it("records home: { ipv4 } in /etc/opscrew/apps/<app>.json", async () => {
    const fake = homeServer();
    const { plan } = await provision(fake, home(fake, { home: { ipv4: false } }));
    expect(recordStep(plan)?.params.homeIpv4).toBe(false);
    expect(appRecord(fake, "shop")?.home).toEqual({ ipv4: false });
    expect(recordStep(await planFor(fake, home(fake, { home: { ipv4: false } })))?.state).toBe(
      "in-place",
    );
    // Changing it rewrites the record, and the plan's hash differs.
    const other = await planFor(fake, home(fake));
    expect(recordStep(other)?.state).toBe("change");
    expect(hostPlanHash(other)).not.toBe(
      hostPlanHash(await planFor(fake, home(fake, { home: { ipv4: false } }))),
    );
  });

  it("refuses a home app beside a non-home app, and the other way round", async () => {
    const plain = homeServer();
    await provision(plain);
    deployApp(plain, "shop");
    const homeBeside = await planFor(plain, home(plain, blog(plain)));
    expect(codes(homeBeside)).toEqual(["home-mode-conflict"]);
    expect(homeBeside.findings[0]?.message).toBe(
      'The OpsCrew app "shop" on this server is not hosted at home, and this app is. The apps share the server\'s firewall and its edge, which a home server sets up for the home network: SSH only from it, and the site on its own address families.',
    );
    expect(homeBeside.findings[0]?.hint).toBe(
      'Host this app the same way as "shop" (opscrew interview), or use another server for it, then run opscrew provision again.',
    );
    expect(recordStep(homeBeside)?.state).toBe("blocked");

    const atHome = homeServer();
    await provision(atHome, home(atHome));
    deployApp(atHome, "shop");
    const plainBeside = await planFor(atHome, blog(atHome));
    expect(codes(plainBeside)).toEqual(["home-mode-conflict"]);
    expect(plainBeside.findings[0]?.message).toContain(
      'The OpsCrew app "shop" on this server is hosted at home, and this app is not.',
    );
  });

  it("refuses home apps served over different address families, and allows the same", async () => {
    const fake = homeServer();
    await provision(fake, home(fake));
    deployApp(fake, "shop");
    const ipv6 = await planFor(fake, home(fake, { ...blog(fake), home: { ipv4: false } }));
    expect(codes(ipv6)).toEqual(["home-mode-conflict"]);
    expect(ipv6.findings[0]?.message).toBe(
      "The OpsCrew app \"shop\" on this server is served from home over IPv4, and this app would be served over IPv6 only. The apps share the server's edge and its web filter, which serve every app's site over the same address families.",
    );
    const same = await planFor(fake, home(fake, blog(fake)));
    expect(codes(same)).toEqual([]);
  });

  it("checks home again at apply time, before the first change", async () => {
    const fake = homeServer();
    await provision(fake, home(fake));
    deployApp(fake, "shop");
    // A second home app with the same home.ipv4 passes the apply's re-check.
    const second = await planFor(fake, home(fake, blog(fake)));
    await applyApproved(fake, second);
    expect(appRecord(fake, "blog")?.home).toEqual(HOME);

    // Another app recorded meanwhile with a different home.ipv4 is refused there.
    const third = await planFor(
      fake,
      home(fake, {
        ...blog(fake),
        app: "news",
        projectId: "news-1",
        hostnames: ["news.example.com"],
        deploy: { user: "deploy", publicKey: DEPLOY_KEY.replace("opscrew-deploy", "news-deploy") },
        home: { ipv4: false },
      }),
    );
    expect(codes(third)).toEqual(["home-mode-conflict"]);
    const plan = await planFor(
      fake,
      home(fake, {
        ...blog(fake),
        app: "news",
        projectId: "news-1",
        hostnames: ["news.example.com"],
        deploy: { user: "deploy", publicKey: DEPLOY_KEY.replace("opscrew-deploy", "news-deploy") },
      }),
    );
    expect(codes(plan)).toEqual([]);
    const shop = appRecord(fake, "shop");
    fake.files.set(
      "/etc/opscrew/apps/shop.json",
      JSON.stringify({ ...shop, home: { ipv4: false } }),
    );
    fake.calls.length = 0;
    const error = await rejection(applyApproved(fake, plan));
    expect(error.message).toContain('The OpsCrew app "');
    expect(error.message).toContain("over IPv6 only");
    expect(fake.names()).toEqual(["privilege", "record.read", "apps.read"]);
  });
});
