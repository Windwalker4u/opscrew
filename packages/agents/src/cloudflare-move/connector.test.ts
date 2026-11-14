import { stackPlanHash } from "@opscrew/connector-portainer";
import { type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  besideConnector,
  CLOUD_NEXT_TUNNEL_DIR,
  removeBesideConnector,
  takeOverConnector,
  waitForNoConnection,
} from "./connector";
import {
  B_TUNNEL,
  B_WEBHOOK_TUNNEL,
  type ConnectorWorld,
  connectorWorld,
  fakeConnectors,
  fakeNextStacks,
  scripted,
} from "./connector.fakes";

async function failure(run: Promise<unknown>): Promise<OpsCrewError> {
  const error = await run.catch((e: unknown) => e);
  if (!(error instanceof OpsCrewError)) throw new Error(`expected a stop, got ${String(error)}`);
  return error;
}

/** The kinds and hashes of the approvals asked so far. */
function asked(w: ConnectorWorld) {
  return w.handler.requests.map((r) => [r.kind, r.planHash]);
}

/** The host plans applied, with the token each was sent. */
function applied(w: ConnectorWorld) {
  return w.host.applies.map(({ plan, options }) => ({
    params: plan.steps.map((step) => step.params),
    token: options.secrets?.tunnelToken,
  }));
}

const PORTAINER_TUNNEL = { web: { mode: "tunnel" as const }, redeploy: "cloudflare" as const };

describe.skipIf(!findExecutable("git"))("besideConnector", () => {
  it("runs B's connector as root beside A's on the user's own server, its token only on standard input", async () => {
    const w = await connectorWorld({ kind: "own" });
    await besideConnector(w.session, w.environment, w.tunnels);
    expect(applied(w)).toEqual([
      {
        params: [
          expect.objectContaining({
            next: true,
            runAs: "root",
            dir: "/srv/opscrew/cloudflared-next/shop",
            tunnelId: B_TUNNEL,
            needsToken: true,
          }),
        ],
        token: w.tokens.tunnel,
      },
    ]);
    const [plan] = w.host.applies.map((a) => a.plan) as [HostPlan];
    expect(asked(w)).toEqual([["host-apply", hostPlanHash(plan)]]);
    expect(w.handler.requests[0]?.title).toBe(
      "Run the new Cloudflare account's tunnel connector beside the current one on your server",
    );
    expect(w.tunnel.connections).toHaveLength(1);
    expect(await w.leaks(hostPlanHash(plan))).toBe(false);

    // Up to date: B's tunnel is connected, so the run asks nothing and reaches no server.
    const inspections = w.host.inspections;
    await besideConnector(w.session, w.environment, w.tunnels);
    expect(w.host.applies).toHaveLength(1);
    expect(w.host.inspections).toBe(inspections);
    expect(asked(w)).toHaveLength(1);
    expect(w.deps.reporter.text()).toContain(
      "The new Cloudflare account's tunnel connector runs beside the current one on your server; nothing on it changes.",
    );
  });

  it("runs as the deploy login in its own folder on a cloud server with Portainer on a subdomain", async () => {
    const w = await connectorWorld({ kind: "cloud" });
    await besideConnector(w.session, w.environment, w.tunnels);
    expect(applied(w)).toEqual([
      {
        params: [
          expect.objectContaining({
            next: true,
            runAs: "login",
            dir: CLOUD_NEXT_TUNNEL_DIR,
            tunnelId: B_TUNNEL,
          }),
        ],
        token: w.tokens.tunnel,
      },
    ]);
    expect(CLOUD_NEXT_TUNNEL_DIR).toBe("/home/deploy/opscrew/cloudflared-next");
    expect(await w.leaks()).toBe(false);
  });

  it("runs the beside stacks in Portainer through one stack plan approved by its hash", async () => {
    const w = await connectorWorld({ kind: "portainer", ...PORTAINER_TUNNEL });
    const stacks = fakeNextStacks();
    await besideConnector(w.session, w.environment, w.tunnels, { nextStacks: stacks.api });
    const [first] = stacks.applies;
    expect(first?.plan.changes.map((c) => [c.params.name, c.state, c.params.action])).toEqual([
      ["opscrew-shop-tunnel-next", "change", "create"],
      ["opscrew-shop-portainer-tunnel-next", "change", "create"],
    ]);
    expect(first?.tokens).toEqual({
      "opscrew-shop-tunnel-next": w.tokens.tunnel,
      "opscrew-shop-portainer-tunnel-next": w.tokens.portainer_tunnel,
    });
    const hash = stackPlanHash(first?.plan as never);
    expect(asked(w)).toEqual([["stack-apply", hash]]);
    expect(w.deps.audit.entries.map((e) => [e.action, e.phase, e.target])).toEqual(
      expect.arrayContaining([
        ["stack apply started", "cloudflare-move", hash],
        ["stack change tunnel-connector-stack", "cloudflare-move", hash],
      ]),
    );
    expect(w.portainer.mutations()).toEqual([]);
    expect(await w.leaks(JSON.stringify(first?.plan), hash)).toBe(false);

    // Up to date: the plan changes nothing, so nothing is asked or applied.
    await besideConnector(w.session, w.environment, w.tunnels, { nextStacks: stacks.api });
    expect(stacks.applies).toHaveLength(1);
    expect(asked(w)).toHaveLength(1);
  });

  it("runs only the webhook's beside stack in Portainer's Caddy and proxy modes", async () => {
    for (const web of [{ mode: "caddy" as const }, { mode: "proxy" as const, port: 8080 }]) {
      const w = await connectorWorld({ kind: "portainer", web, redeploy: "cloudflare" });
      const stacks = fakeNextStacks();
      await besideConnector(w.session, w.environment, w.tunnels, { nextStacks: stacks.api });
      expect(stacks.applies[0]?.tokens).toEqual({
        "opscrew-shop-portainer-tunnel-next": w.tokens.portainer_tunnel,
      });
    }
  });

  it("does nothing for an app with no tunnel, and stops before any change without the beside stacks", async () => {
    const none = await connectorWorld({
      kind: "portainer",
      web: { mode: "proxy", port: 8080 },
      redeploy: "updater",
    });
    expect(none.tunnels).toEqual([]);
    await besideConnector(none.session, none.environment, none.tunnels);
    await removeBesideConnector(none.session, none.environment);
    expect(none.portainer.calls).toEqual([]);

    const w = await connectorWorld({ kind: "portainer", ...PORTAINER_TUNNEL });
    const error = await failure(besideConnector(w.session, w.environment, w.tunnels));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(w.portainer.calls).toEqual([]);
    expect(asked(w)).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("takeOverConnector", () => {
  it("restarts the main connector with B's token, then removes the beside one, B's tunnel never without a connection", async () => {
    const w = await connectorWorld({ kind: "own" });
    await besideConnector(w.session, w.environment, w.tunnels);
    await takeOverConnector(w.session, w.environment, w.tunnels);
    expect(applied(w).slice(1)).toEqual([
      {
        params: [
          expect.objectContaining({
            rewrite: true,
            runAs: "root",
            dir: "/srv/opscrew/cloudflared/shop",
            tunnelId: B_TUNNEL,
          }),
        ],
        token: w.tokens.tunnel,
      },
      {
        params: [expect.objectContaining({ remove: true, next: true, runAs: "root" })],
        token: undefined,
      },
    ]);
    // Beside alone, then both, then the main connector alone.
    expect(w.host.connected).toEqual([1, 2, 1]);
    expect(w.tunnel.connections.map((c) => c.id)).toEqual(["main"]);
    expect(asked(w).map(([kind]) => kind)).toEqual(["host-apply", "host-apply", "host-apply"]);
    expect(await w.leaks()).toBe(false);

    // Done: the beside connector is gone, so the main one is not restarted again.
    await takeOverConnector(w.session, w.environment, w.tunnels);
    expect(w.host.applies).toHaveLength(3);
    expect(asked(w)).toHaveLength(3);
  });

  it("names both hashes when a script approved the restart but not the removal", async () => {
    const w = await connectorWorld({ kind: "cloud" });
    await besideConnector(w.session, w.environment, w.tunnels);
    const first = scripted(w.session, []);
    const refused = await failure(takeOverConnector(first.session, w.environment, w.tunnels));
    const restart = first.handler.requests[0]?.planHash as string;
    expect(refused.hint).toContain(`--approve ${restart}`);

    const second = scripted(w.session, [restart]);
    const stopped = await failure(takeOverConnector(second.session, w.environment, w.tunnels));
    const removal = second.handler.requests[1]?.planHash as string;
    expect(stopped.code).toBe("APPROVAL_REFUSED");
    expect(stopped.message).toContain(
      "serves the new account's tunnel now, and the host plan that removes the one beside it was not approved",
    );
    expect(stopped.hint).toContain(`--approve ${restart} --approve ${removal}`);
    expect(w.tunnel.connections.map((c) => c.id).sort()).toEqual(["beside", "main"]);

    // The run with both: the main connector restarts once more while the beside one serves.
    const third = scripted(w.session, [restart, removal]);
    await takeOverConnector(third.session, w.environment, w.tunnels);
    expect(w.host.connected.at(-1)).toBe(1);
    expect(w.host.applies.at(-1)?.plan.steps[0]?.params).toMatchObject({
      remove: true,
      dir: CLOUD_NEXT_TUNNEL_DIR,
      runAs: "login",
    });
    expect(w.host.applies[1]?.plan.steps[0]?.params).toMatchObject({
      dir: "/home/deploy/opscrew/cloudflared",
      runAs: "login",
      rewrite: true,
    });
    expect(Math.min(...w.host.connected)).toBeGreaterThan(0);
    expect(await w.leaks(refused.hint ?? "", stopped.message, stopped.hint ?? "")).toBe(false);
  });

  it("in Portainer restarts the main connectors with B's tokens, then removes the beside stacks", async () => {
    const w = await connectorWorld({ kind: "portainer", ...PORTAINER_TUNNEL });
    const stacks = fakeNextStacks();
    await besideConnector(w.session, w.environment, w.tunnels, { nextStacks: stacks.api });
    const main = fakeConnectors();
    const order: string[] = [];
    const options = {
      nextStacks: {
        ...stacks.api,
        apply: async (...args: Parameters<typeof stacks.api.apply>) => {
          order.push("beside stacks");
          return stacks.api.apply(...args);
        },
      },
      connectors: {
        ...main.connectors,
        restart: async (tunnels: Parameters<typeof main.connectors.restart>[0]) => {
          order.push("main connectors");
          await main.connectors.restart(tunnels);
        },
      },
    };
    await takeOverConnector(w.session, w.environment, w.tunnels, options);
    expect(order).toEqual(["main connectors", "beside stacks"]);
    expect(main.restarts).toEqual([w.tunnels]);
    expect(stacks.applies[1]?.plan.changes.map((c) => [c.params.name, c.params.action])).toEqual([
      ["opscrew-shop-tunnel-next", "remove"],
      ["opscrew-shop-portainer-tunnel-next", "remove"],
    ]);
    expect(stacks.running.size).toBe(0);
    expect(asked(w).map(([kind]) => kind)).toEqual(["stack-apply", "stack-apply"]);

    // A run again: the removal changes nothing.
    await takeOverConnector(w.session, w.environment, w.tunnels, options);
    expect(stacks.applies).toHaveLength(2);
    expect(await w.leaks()).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("removeBesideConnector", () => {
  it("removes the beside connector on the server, never the main one, and skips once it is gone", async () => {
    const w = await connectorWorld({ kind: "own" });
    await besideConnector(w.session, w.environment, w.tunnels);
    await removeBesideConnector(w.session, w.environment);
    expect(applied(w)[1]).toEqual({
      params: [
        expect.objectContaining({
          remove: true,
          next: true,
          dir: "/srv/opscrew/cloudflared-next/shop",
        }),
      ],
      token: undefined,
    });
    expect(w.tunnel.connections).toEqual([]);
    await removeBesideConnector(w.session, w.environment);
    expect(w.host.applies).toHaveLength(2);
    expect(asked(w)).toHaveLength(2);
    expect(w.deps.reporter.text()).toContain(
      "No connector of the new Cloudflare account runs beside the current one on your server; nothing on it changes.",
    );
  });

  it("removes the beside stacks from Portainer through one stack plan", async () => {
    const w = await connectorWorld({ kind: "portainer", ...PORTAINER_TUNNEL });
    const stacks = fakeNextStacks();
    await besideConnector(w.session, w.environment, w.tunnels, { nextStacks: stacks.api });
    await removeBesideConnector(w.session, w.environment, { nextStacks: stacks.api });
    expect(stacks.running.size).toBe(0);
    await removeBesideConnector(w.session, w.environment, { nextStacks: stacks.api });
    expect(stacks.applies).toHaveLength(2);
    expect(asked(w).map(([kind]) => kind)).toEqual(["stack-apply", "stack-apply"]);
  });
});

describe.skipIf(!findExecutable("git"))("waitForNoConnection", () => {
  it("returns once B's tunnel has no connection, asking B's account with B's token", async () => {
    const w = await connectorWorld({ kind: "own" });
    await besideConnector(w.session, w.environment, w.tunnels);
    const sleep = w.session.services.sleep as (ms: number) => Promise<void>;
    let polls = 0;
    const session = {
      ...w.session,
      services: {
        ...w.session.services,
        sleep: async (ms: number) => {
          polls++;
          if (polls === 2) w.tunnel.connections = [];
          await sleep(ms);
        },
      },
    };
    await waitForNoConnection(session, w.session.accounts.b, B_TUNNEL);
    expect(polls).toBe(2);
    // A tunnel Cloudflare no longer has counts as closed.
    await waitForNoConnection(
      session,
      w.session.accounts.b,
      "00000000-0000-4000-8000-0000000000bb",
    );
    const reads = w.cloudflare.calls.filter((call) => call.path.includes("/cfd_tunnel/"));
    const bId = w.cloudflare.account("New").id;
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((call) => call.method === "GET" && call.accountId === bId)).toBe(true);
  });

  it("stops plainly when the connections don't close in time", async () => {
    const w = await connectorWorld({ kind: "portainer", ...PORTAINER_TUNNEL });
    w.webhookTunnel.connections.push({
      id: "other",
      colo_name: "fra08",
      opened_at: "2026-11-20T10:00:00.000Z",
      origin_ip: "192.0.2.80",
    });
    const error = await failure(
      waitForNoConnection(w.session, w.session.accounts.b, B_WEBHOOK_TUNNEL),
    );
    expect(error.message).toContain(
      "Cloudflare still reports active connections for the app's Cloudflare Tunnel after 3 minutes",
    );
    expect(error.message).toContain("Nothing in Cloudflare was deleted.");
    expect(error.hint).toContain("Run `opscrew cloudflare move` again in a few minutes");
    expect(w.clock.now()).toBeGreaterThanOrEqual(180_000);
    expect(await w.leaks(error.message)).toBe(false);
  });
});
