/**
 * A second app's destroy on the server OpsCrew created for the first app (feature 030, plan 8.):
 * logged in with its own deploy key, without the first app's folder, it removes only its own
 * parts (its key line, folders and record; never the edge or another line), and its DNS records
 * and Cloudflare rules as for a server the user owns. `--undo-host` is refused.
 */
import { rm } from "node:fs/promises";
import { HostApplyError } from "@opscrew/connector-ssh-host";
import { IMAGES } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import {
  BEFORE,
  everythingSeen,
  kinds,
  type SecondAppProject,
  secondAppProject,
} from "../provision/__fixtures__/second-app";
import { runProvision } from "../provision/run";
import { readOwnServer } from "../shared";
import { ED25519_FINGERPRINT, SERVER_IPV4 } from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

/** The second app provisioned and joined, its deploy pull request merged. */
async function provisioned(): Promise<SecondAppProject> {
  const s = await secondAppProject();
  await runProvision(s.deps, { services: s.services });
  await s.git(s.root, "checkout", "-q", "main");
  await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
  s.engine.changes = [];
  s.handler.requests.length = 0;
  return s;
}

function services(s: SecondAppProject): DestroyServices {
  return {
    ...(s.services.engine !== undefined ? { engine: s.services.engine } : {}),
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
}

/** The `-i` key files of every ssh call since `from`. */
function keyFiles(s: SecondAppProject, from: number): string[] {
  return s.runner.calls
    .slice(from)
    .filter((call) => call.command === "ssh")
    .flatMap((call) => {
      const at = call.args.indexOf("-i");
      return at < 0 ? [] : [call.args[at + 1] as string];
    });
}

describe("a second app's destroy", () => {
  it("removes only its own parts, logged in with its own key, without the first app's folder", async () => {
    const s = await provisioned();
    expect((await readOwnServer(s.deps.paths))?.joined).toBe(true);
    // The first app's folder and its state on this computer are gone.
    await rm(s.shared.ref.root, { recursive: true, force: true });
    await rm(s.shared.first.projectHomeDir, { recursive: true, force: true });
    const calls = s.runner.calls.length;
    const applies = s.host.applies.length;
    const result = await runDestroy(s.deps, {
      services: services(s),
      confirm: async () => true,
    });

    expect(kinds(s)).toEqual(["iac-apply", "host-apply", "cloudflare-apply", "github-secrets"]);
    const used = keyFiles(s, calls);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((file) => file === s.key.privateKeyFile)).toBe(true);

    // The teardown: the app's own parts only, as the login, its record as root through Docker.
    expect(s.host.applies).toHaveLength(applies + 1);
    const teardown = s.host.applies.at(-1);
    expect(teardown?.plan.purpose).toBe("teardown");
    expect(teardown?.options.rootImage).toBe(IMAGES.caddy.ref);
    const ids = teardown?.plan.steps.map((step) => step.id) ?? [];
    expect(ids).not.toContain("edge");
    expect(ids).not.toContain("check-key");
    expect(ids).not.toContain("portainer");
    const key = teardown?.plan.steps.find((step) => step.id === "deploy-key");
    expect(key?.params).toMatchObject({ runAs: "login", keys: "" });
    // authorized_keys holds exactly the lines it held before the app came.
    expect(s.host.facts.deployUser?.keys).toEqual(BEFORE);
    expect(s.host.facts.apps.find((app) => app.name === "inventory")).toBeUndefined();
    expect(result.hostPlans?.teardown).toBe(teardown?.options.approvedHash);

    // The DNS records went as for a server the user owns, their address only as TF_VAR_*.
    const destroyPlans = s.engine.plans.filter((plan) => plan.destroy);
    expect(destroyPlans.length).toBeGreaterThan(0);
    for (const plan of destroyPlans) expect(plan.env.TF_VAR_server_ipv4).toBe(SERVER_IPV4);
    // What remains is the first app's: its server's setup, the app and the edge.
    expect(result.remaining.join("\n")).toContain(
      'The server\'s setup (Docker, the deploy user, SSH and the firewall), the other OpsCrew app on it ("shop") and what the apps share, the edge: they belong to "shop", which OpsCrew created the server for.',
    );
    expect(result.remaining.join("\n")).not.toContain("--undo-host");
    // The server is the first app's: it stays until that app's destroy.
    const stays =
      'The server is the one OpsCrew created for "shop", and it stays until that app\'s `opscrew destroy`.';
    const host = s.handler.requests.find((request) => request.kind === "host-apply");
    expect(host?.details).toContain(stays);
    expect(result.remaining[0]).toBe(stays);
    const words = `${JSON.stringify(s.handler.requests)}\n${result.remaining.join("\n")}`;
    expect(words).not.toContain("never deletes, rebuilds or reinstalls");

    const seen = await everythingSeen(s);
    expect(seen).not.toContain(s.shared.firstKey);
    const printed = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
    expect(printed).not.toContain(SERVER_IPV4);
  });

  it("forgets joined once its key is off the server: provision again logs in with the first app's key", async () => {
    const s = await provisioned();
    await runDestroy(s.deps, { services: services(s), confirm: async () => true });
    const own = await readOwnServer(s.deps.paths);
    expect(own?.joined).toBeUndefined();
    expect(own).toMatchObject({
      keyPath: s.key.privateKeyFile,
      hostKey: ED25519_FINGERPRINT,
      shares: s.shared.ref,
    });

    s.handler.requests.length = 0;
    const calls = s.runner.calls.length;
    await runProvision(s.deps, { services: s.services });
    expect(keyFiles(s, calls)).toContain(s.shared.first.files.deployKey);
    expect((await readOwnServer(s.deps.paths))?.joined).toBe(true);
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, s.key.publicKeyOpenSsh]);
  });

  it("a destroy that stops after the teardown runs again with the first app's deploy login", async () => {
    const s = await provisioned();
    const remove = s.github.deleteActionsSecret.bind(s.github);
    let down = true;
    s.github.deleteActionsSecret = async (owner, repo, name) => {
      if (down) {
        down = false;
        throw new Error("GitHub is unreachable");
      }
      return remove(owner, repo, name);
    };
    await expect(
      runDestroy(s.deps, { services: services(s), confirm: async () => true }),
    ).rejects.toThrow();
    expect(s.host.facts.deployUser?.keys).toEqual(BEFORE);
    expect((await readOwnServer(s.deps.paths))?.joined).toBeUndefined();

    const calls = s.runner.calls.length;
    await runDestroy(s.deps, { services: services(s), confirm: async () => true });
    const used = keyFiles(s, calls);
    expect(used).toContain(s.shared.first.files.deployKey);
    expect(used).not.toContain(s.key.privateKeyFile);
    expect(s.host.facts.deployUser?.keys).toEqual(BEFORE);
    expect(await everythingSeen(s)).not.toContain(s.shared.firstKey);
  });

  it("forgets joined when the teardown stopped after removing its key line", async () => {
    const s = await provisioned();
    s.host.fail = new HostApplyError("COMMAND_FAILED", "the record step failed", [
      "app-dirs",
      "deploy-key",
    ]);
    await expect(
      runDestroy(s.deps, { services: services(s), confirm: async () => true }),
    ).rejects.toThrow("the record step failed");
    expect((await readOwnServer(s.deps.paths))?.joined).toBeUndefined();
  });

  it("refuses --undo-host before any change: the server's setup is the first app's", async () => {
    const s = await provisioned();
    const applies = s.host.applies.length;
    await expect(
      runDestroy(s.deps, { services: services(s), confirm: async () => true, undoHost: true }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        '"inventory" runs on the server OpsCrew created for "shop", whose setup (Docker, the deploy user, SSH and the firewall) belongs to that app, so `--undo-host` would undo it for "shop" too. Nothing was changed.',
    });
    expect(s.handler.requests).toEqual([]);
    expect(s.host.applies).toHaveLength(applies);
    expect(s.host.facts.deployUser?.keys).toEqual([...BEFORE, s.key.publicKeyOpenSsh]);
  });
});
