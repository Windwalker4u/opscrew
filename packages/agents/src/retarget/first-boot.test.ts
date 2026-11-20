import { readFile } from "node:fs/promises";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import type { CloudProvider } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { providerProfile } from "../providers";
import { readDeployPublicKey } from "../shared";
import {
  FakeFirstBoot,
  type FirstBootOptions,
  firstBootErrors,
  HOST_KEY,
  type MoveHarness,
  moveHarness,
  NEW_HOST_KEY,
  ScriptedRunner,
} from "../testing";
import { caught, drive, everythingPrinted, run } from "./__fixtures__/assert";

const QUOTED = fakeSecret("hcloud-token", "move-first-boot");

/**
 * A move to `to` whose new server's first boot `boot` scripts: its SSH port, the deploy user's
 * probe and cloud-init's result, its host key and its provider's restart and install. The old
 * server answers as the harness's.
 */
async function movingTo(
  to: CloudProvider,
  boot: FirstBootOptions,
  options: { interactive?: boolean } = {},
): Promise<{ h: MoveHarness; server: FakeFirstBoot }> {
  const h = await moveHarness({
    from: to === "hetzner" ? "digitalocean" : "hetzner",
    to,
    ...options,
  });
  const n = h.newServer.ipv4;
  const server = new FakeFirstBoot({
    errors: firstBootErrors(QUOTED),
    base: h.hosts.remote,
    ...boot,
  });
  const { tcpConnect, remote } = h.services;
  const given = h.services.servers?.[to];
  if (tcpConnect === undefined || remote === undefined || given === undefined) {
    throw new Error("the harness reaches its servers through its own fakes");
  }
  h.services.tcpConnect = (host, port, timeout) =>
    (host === n ? server.tcpConnect : tcpConnect)(host, port, timeout);
  h.services.remote = (host) => (host === n ? server.remote : remote)(host);
  const api = server.servers;
  h.services.servers = {
    ...h.services.servers,
    [to]: { ...given, restart: api.restart, reinstall: api.reinstall },
  };
  const scans = server.runner();
  const runner = h.deps.runner;
  h.deps.runner = new ScriptedRunner((command, args, opts) =>
    command === "ssh-keyscan" && args[args.length - 1] === n
      ? scans.run(command, args, opts)
      : runner.run(command, args, opts),
  );
  return { h, server };
}

describe.skipIf(!findExecutable("git"))("a move's new server whose first boot failed", () => {
  describe.each(["digitalocean", "contabo", "hetzner"] as const)("on %s", (to) => {
    const profile = providerProfile(to);
    const named = `the new ${profile.displayName} ${profile.serverNoun} shop`;

    it("is restarted and installed again after the app's name, and the move goes on", async () => {
      const { h, server } = await movingTo(to, { network: false });
      const n = h.newServer.ipv4;
      const result = await run(h);
      expect(result).toMatchObject({ step: "switched", done: true });
      expect(server.calls).toEqual([`restart ${h.newServer.id}`, `reinstall ${h.newServer.id}`]);
      const titles = h.handler.requests.map((r) => r.title);
      expect(titles).toEqual(
        expect.arrayContaining([`Restart ${named}`, `Install ${named} again`]),
      );
      // The new side's image and the first-boot file with the deploy key.
      const publicKey = await readDeployPublicKey(h.deps, "test");
      expect(server.installed?.image).toBe(profile.defaultImage);
      expect(server.installed?.userData.startsWith("#cloud-config\n")).toBe(true);
      expect(server.installed?.userData).toContain(`      - ${publicKey}`);
      // The new key replaced the old pin with no question.
      const known = await readFile(h.paths.files.knownHosts, "utf8");
      expect(known).toContain(`${n} ${NEW_HOST_KEY}`);
      expect(known).not.toContain(`${n} ${HOST_KEY}`);
      expect(titles).not.toContain("Trust the server's new SSH host key");
      const printed = everythingPrinted(h);
      expect(printed).not.toContain(QUOTED);
      expect(printed).not.toContain("apt-get");
    });

    it("in a script stops without --confirm, nothing restarted, and goes on with it", async () => {
      const { h, server } = await movingTo(to, { network: false }, { interactive: false });
      const error = await caught(drive(h));
      expect(error.code).toBe("APPROVAL_REFUSED");
      expect(error.hint).toContain("in a script, run `opscrew retarget --confirm shop`.");
      expect(server.calls).toEqual([]);

      h.cli.confirm = "shop";
      await drive(h);
      expect(server.calls).toEqual([`restart ${h.newServer.id}`, `reinstall ${h.newServer.id}`]);
    });
  });
});
