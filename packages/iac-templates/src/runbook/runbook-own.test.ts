import { describe, expect, it } from "vitest";
import { homePlan, testContext, testPlan } from "../__fixtures__/plans";
import type { RenderContext } from "../types";
import { renderRunbook } from "./index";

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;

const ctx: RenderContext = testContext({
  projectId: "shop-0123456789ab",
  serverIpv4: IPV4,
  serverIpv6: IPV6,
});

function runbook(o: Parameters<typeof testPlan>[0], context: RenderContext = ctx): string {
  return renderRunbook(testPlan({ provider: "own", ...o }), context).content;
}

describe("renderRunbook for a server the user owns", () => {
  it("shows no server price and says OpsCrew snapshots the data, the server's backups the user's", () => {
    const text = runbook({ domain: "shop.example.com" });
    expect(text).toContain("no server price: you already pay for this server");
    expect(text).not.toMatch(/€|\$\d|per month/);
    expect(text).toContain("## Backups");
    expect(text).toContain("takes a snapshot of the app's data on this server");
    expect(text).toContain("OpsCrew cannot back up the server itself");
    expect(text).toContain("pg_dump");
    expect(text).not.toMatch(/Hetzner|DigitalOcean|Droplet/);
  });

  it("never shows the server's address, in any mode (FR-902)", () => {
    const direct = runbook({});
    const proxiedPlan = testPlan({ provider: "own", domain: "shop.example.com" });
    const dnsOnly = renderRunbook(
      { ...proxiedPlan, dns: { ...proxiedPlan.dns, proxied: false } },
      ctx,
    ).content;
    const proxied = runbook({ domain: "shop.example.com" });
    const tunnel = runbook({ access: "tunnel", domain: "shop.example.com" });
    for (const text of [direct, dnsOnly, proxied, tunnel]) {
      expect(text).not.toContain(IPV4);
      expect(text).not.toContain(IPV6);
      expect(text).toContain("deploy@<server>");
      expect(text).toContain("`<server>` is the address you gave OpsCrew");
    }
    expect(direct).toContain("| App | `http://<server>` (your server's address) |");
    expect(direct).toContain(
      "| IPv4 / IPv6 | kept out of this repository: `opscrew status` shows them |",
    );
    expect(dnsOnly).toContain("| App | https://shop.example.com |");
    expect(proxied).toContain("kept private behind Cloudflare");
  });

  it("explains the tunnel and its SSH hostname in tunnel mode", () => {
    const text = runbook({ access: "tunnel", arch: "arm64", domain: "shop.example.com" });
    expect(text).toContain(
      "| SSH for deploys | `ssh-shop.example.com`, through the tunnel and Cloudflare Access",
    );
    expect(text).toContain("none needed: the server is reached through a Cloudflare Tunnel");
    expect(text).toContain("connects to `ssh-shop.example.com`");
    expect(text).toContain("built on GitHub's arm64 runner");
    expect(text).toContain("No inbound web port is open");
    expect(text).toContain("allows only SSH.");
    expect(text).toContain("tunnel, Access applications and DNS records");
  });

  it("explains how to undo OpsCrew's host changes and that the server is never deleted", () => {
    const text = runbook({ domain: "shop.example.com" });
    expect(text).toContain("`opscrew destroy --undo-host`");
    expect(text).toContain("It **never** deletes, rebuilds or reinstalls your server.");
    expect(text).toContain("`--confirm shop` in scripts");
    expect(text).toContain("/etc/opscrew/host.json");
  });

  it("says that switching between direct access and the tunnel runs in two steps", () => {
    for (const access of ["public", "tunnel"] as const) {
      const text = runbook({ access, domain: "shop.example.com" });
      expect(text).toContain(
        "**Switching between direct access and the tunnel** runs in two steps",
      );
      expect(text).toContain("first removes the current way in");
    }
  });

  it("tells how to reach Portainer without ever containing the password", () => {
    const local = runbook({ domain: "shop.example.com", portainer: { access: "local" } });
    expect(local).toContain("## Portainer");
    expect(local).toContain(
      "ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key -N -L 9443:127.0.0.1:9443 deploy@<server>",
    );
    expect(local).toContain("`~/.opscrew/projects/shop-0123456789ab/portainer_password`");
    expect(local).toContain("| Portainer | through an SSH tunnel only |");
    expect(local).not.toContain("portainer.example.com");

    const subdomain = runbook({
      access: "tunnel",
      domain: "shop.example.com",
      portainer: PORTAINER,
    });
    expect(subdomain).toContain("https://portainer.example.com, behind Cloudflare Access");
    expect(subdomain).toContain("one-time PIN");

    expect(runbook({ domain: "shop.example.com" })).not.toContain("Portainer");
  });

  it("uses the server's SSH port in every direct SSH command when it is not 22", () => {
    const key = "~/.opscrew/projects/shop-0123456789ab/deploy_key";
    for (const access of ["public", "tunnel"] as const) {
      const text = runbook(
        access === "public"
          ? { portainer: { access: "local" } }
          : { access, domain: "shop.example.com", portainer: { access: "local" } },
        { ...ctx, sshPort: 2222 },
      );
      const server = "<server>";
      expect(text).toContain(`ssh -p 2222 -i ${key} deploy@${server}`);
      expect(text).toContain(`ssh -p 2222 -i ${key} -N -L 9443:127.0.0.1:9443 deploy@${server}`);
      expect(text).not.toMatch(/ssh -i /);
    }
    const plain = runbook({ domain: "shop.example.com", portainer: { access: "local" } });
    expect(
      runbook(
        { domain: "shop.example.com", portainer: { access: "local" } },
        { ...ctx, sshPort: 22 },
      ),
    ).toBe(plain);
    expect(plain).not.toContain("-p ");
  });

  describe("a server at home", () => {
    const home = (o: Parameters<typeof homePlan>[0] = {}) =>
      renderRunbook(homePlan(o), ctx).content;

    it("has a home section only for a home app", () => {
      expect(home()).toContain("## Hosting at home");
      for (const text of [
        runbook({}),
        runbook({ domain: "shop.example.com" }),
        runbook({ access: "tunnel", domain: "shop.example.com" }),
      ]) {
        expect(text).not.toContain("## Hosting at home");
        expect(text).not.toContain("opscrew-dns-updater");
      }
    });

    it("names the forwards, never an address", () => {
      const text = home();
      expect(text).toContain(
        "Forward TCP 80 and TCP 443 to the server's address on your home network",
      );
      expect(text).toContain("DHCP");
      expect(text).toContain("Don't forward SSH");
      expect(text).toContain(
        "its public IPv4 address on its own interface, no forwards are needed",
      );
      // Proxied over IPv4: only an A record, so no IPv6 firewall rule.
      expect(text).not.toContain("router's IPv6 firewall");
      expect(home({ proxied: false })).toContain(
        "allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall",
      );
      const v6 = home({ ipv4: false });
      expect(v6).toContain("served over IPv6 behind Cloudflare's proxy");
      expect(v6).toContain(
        "allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall",
      );
      expect(v6).not.toContain("Forward TCP 80 and TCP 443");
      for (const o of [{}, { ipv4: false }, { proxied: false }, { dnsElsewhere: true }]) {
        const t = home(o);
        expect(t).not.toContain(IPV4);
        expect(t).not.toContain(IPV6);
        expect(t).not.toMatch(/\b(?:192\.168|10)\.\d+\.\d+/);
      }
    });

    it("names the updater's files and units and says what its token can reach", () => {
      const text = home();
      expect(text).toContain("`opscrew-dns-updater@shop.timer`");
      expect(text).toContain("every 2 minutes");
      expect(text).toContain("`/etc/opscrew/dns-updater/shop.json`");
      expect(text).toContain("`/etc/opscrew/dns-updater/shop.token`");
      expect(text).toContain("`/var/lib/opscrew-dns-updater/shop/`");
      expect(text).toContain("but its token can change any record in example.com");
      expect(text).toContain("the deploy runner included");
      expect(text).toContain("`OPSCREW_DNS_UPDATER_TOKEN`");
      expect(text).toContain("`opscrew rotate dns-updater`");
      expect(text).toContain("journalctl -u opscrew-dns-updater@shop.service");
      const elsewhere = home({ dnsElsewhere: true });
      expect(elsewhere).not.toContain("opscrew-dns-updater");
      expect(elsewhere).toContain("there is no address updater");
    });

    it("explains SSH from the home network, the outside check and console recovery", () => {
      const text = home();
      expect(text).toContain("`inet opscrew`");
      expect(text).toContain("`server.sshFrom`");
      expect(text).toContain("answers SSH only on your home network");
      expect(text).toContain("`.github/workflows/opscrew-outside-check.yml`");
      expect(text).toContain("A request from inside your network is not proof");
      expect(text).toContain("Cloudflare answered on port 80");
      expect(home({ proxied: false })).not.toContain("Cloudflare answered on port 80");
      expect(text).toContain("### If SSH stops answering after your network changed");
      expect(text).toContain("sudo nft delete table inet opscrew");
      expect(text).toContain("`opscrew interview --answers <file>` with the new network");
      expect(text).toContain("this app's A record at Cloudflare");
      expect(home({ proxied: false })).toContain("A (and AAAA, while your connection has IPv6)");
      expect(home({ ipv4: false })).toContain("this app's AAAA record");
    });

    it("uses the environment's commands", () => {
      const text = renderRunbook(homePlan(), { ...ctx, environments: ["prod", "staging"] }).content;
      expect(text).toContain("`opscrew rotate dns-updater --env prod`");
      expect(text).toContain("`opscrew verify --env prod`");
    });

    it("matches the snapshot", () => {
      expect(home()).toMatchSnapshot("home");
    });
  });

  it("matches the snapshots", () => {
    expect(runbook({ domain: "example.com", www: true })).toMatchSnapshot("public");
    expect(
      runbook({
        access: "tunnel",
        arch: "arm64",
        domain: "shop.example.com",
        portainer: PORTAINER,
      }),
    ).toMatchSnapshot("tunnel with Portainer");
  });
});
