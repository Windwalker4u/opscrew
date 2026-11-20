import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ResourceChange } from "@opscrew/contracts";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderCloudInit } from "@opscrew/iac-templates";
import { type CloudProvider, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { providerProfile } from "../providers";
import { readDeployPublicKey } from "../shared";
import { hasDeployment } from "../shared/server-address";
import {
  createProject,
  createTestPhaseDeps,
  DIGITALOCEAN_CREATE,
  FakeEngine,
  FakeFirewalls,
  FakeFirstBoot,
  FakeGitHub,
  FIRST_BOOT_SERVER_ID,
  type FirstBootOptions,
  fakeSharedCloudflare,
  fakeWantedFirewall,
  firstBootErrors,
  NEW_HOST_KEY,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "../testing";
import { firstAppLook, noOtherApps } from "../testing/other-apps";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const QUOTED = fakeSecret("hcloud-token", "provision-first-boot");

/** Contabo's created server, which its connector protects with a firewall after the apply. */
const CONTABO_CREATE: ResourceChange[] = [
  {
    address: "module.server.contabo_instance.this",
    type: "contabo_instance",
    name: "this",
    provider: "registry.opentofu.org/contabo/contabo",
    action: "create",
  },
];

/** What each provider's fake engine plans and outputs for the app's new server. */
function scenario(provider: CloudProvider): ConstructorParameters<typeof FakeEngine>[0] {
  if (provider === "digitalocean") {
    return { changes: DIGITALOCEAN_CREATE, planJson: planJsonFor({ provider: "digitalocean" }) };
  }
  if (provider === "contabo") {
    return {
      changes: CONTABO_CREATE,
      planJson: {},
      outputs: {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        server_id: FIRST_BOOT_SERVER_ID,
        server_name: "shop",
        url: `http://${SERVER_IPV4}`,
        wanted_firewalls: { server: fakeWantedFirewall("contabo", FIRST_BOOT_SERVER_ID) },
      },
    };
  }
  return {};
}

/**
 * `opscrew provision` of a plan on `provider` whose new server's first boot `boot` scripts; each
 * approval is given unless `answer` refuses it. The clock is the test's.
 */
async function setup(
  provider: CloudProvider,
  boot: FirstBootOptions,
  options: { deployed?: boolean; answer?: (title: string) => boolean } = {},
) {
  const base = testPlan({
    provider,
    userSecret: false,
    ...(options.deployed ? { deployed: true } : {}),
  });
  const plan = options.deployed
    ? DeployPlanSchema.parse({
        ...base,
        deployment: { ...base.deployment, firstDeployAt: "2026-10-10T09:00:00.000Z" },
      })
    : base;
  const project = await createProject(plan);
  const server = new FakeFirstBoot({ errors: firstBootErrors(QUOTED), base: readyRemote, ...boot });
  const handler = new ScriptedApprovalHandler((request) => options.answer?.(request.title) ?? true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: server.runner(projectRunner()),
    approvalHandler: handler,
  });
  const github = new FakeGitHub();
  let clock = 0;
  const services: ProvisionServices = {
    otherApps: hasDeployment(plan) ? await firstAppLook(deps.paths) : { inspect: noOtherApps },
    engine: async () => new FakeEngine(scenario(provider)),
    provider: {
      configured: true,
      verify: async () => ({ ok: true, message: "ok" }),
      servers: server.servers,
    },
    github,
    tcpConnect: server.tcpConnect,
    remote: server.remote,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    ...(provider === "contabo"
      ? { firewalls: { contabo: new FakeFirewalls(() => undefined) } }
      : {}),
  };
  return { deps, server, handler, github, services };
}

describe.skipIf(!findExecutable("git"))(
  "runProvision: a new server whose first boot failed",
  () => {
    describe.each(["hetzner", "digitalocean", "contabo"] as const)("on %s", (provider) => {
      const profile = providerProfile(provider);
      const named = `the new ${profile.displayName} ${profile.serverNoun} shop`;

      it("restarts it, installs it again with its first-boot file, pins the new key and goes on", async () => {
        const { deps, server, handler, github, services } = await setup(provider, {
          network: false,
        });
        await runProvision(deps, { services });
        expect(server.calls).toEqual([
          `restart ${FIRST_BOOT_SERVER_ID}`,
          `reinstall ${FIRST_BOOT_SERVER_ID}`,
        ]);
        expect(handler.requests.map((r) => r.title)).toEqual(
          expect.arrayContaining([`Restart ${named}`, `Install ${named} again`]),
        );
        // The same image, and the first-boot file the module renders from the same inputs.
        const publicKey = await readDeployPublicKey(deps, "test");
        expect(server.installed).toEqual({
          image: profile.defaultImage,
          userData: renderCloudInit({ sshPublicKey: publicKey, web: true }),
        });
        // The deploy secrets hold the new host key.
        expect(github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(
          `${SERVER_IPV4} ${NEW_HOST_KEY}\n`,
        );
        expect(github.pulls).toHaveLength(1);
        const printed = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
        expect(printed).not.toContain(QUOTED);
        expect(printed).not.toContain("apt-get");
        expect(printed).not.toContain("#cloud-config");
      });

      it("never offers an install after the app's first deploy, and names what failed", async () => {
        const { deps, server, handler, services } = await setup(provider, {}, { deployed: true });
        const error = (await runProvision(deps, { services }).catch(
          (e: unknown) => e,
        )) as OpsCrewError;
        expect(error).toMatchObject({
          code: "PROVIDER_ERROR",
          message: `The server at ${SERVER_IPV4} did not finish its first-boot setup: the provider's first-boot command, the package install and OpsCrew's setup script failed.`,
        });
        expect(server.calls).toEqual([]);
        expect(handler.requests.some((r) => r.title.includes("again"))).toBe(false);
      });

      it("stops a run whose repair was refused with the command that offers it again", async () => {
        const { deps, server, services } = await setup(
          provider,
          {},
          { answer: (title) => !title.startsWith("Install") },
        );
        const error = (await runProvision(deps, { services }).catch(
          (e: unknown) => e,
        )) as OpsCrewError;
        expect(error.code).toBe("APPROVAL_REFUSED");
        expect(error.hint).toContain(
          "in a script, run `opscrew provision --plan-only`, then `opscrew provision --approve <the hash it prints> --confirm shop`.",
        );
        expect(server.calls).toEqual([]);
      });
    });
  },
);
