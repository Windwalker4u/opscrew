/**
 * Test helpers for B's connector beside A's: the move's harness with the app on the user's own
 * server in tunnel mode, on a cloud server with Portainer on a subdomain, or in the user's
 * Portainer; B's tunnels in the two-account fake; a host adapter whose connectors connect them;
 * and the beside stacks a Portainer connector would plan and apply.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeTunnel } from "@opscrew/connector-cloudflare/testing";
import {
  portainerClient,
  type StackChange,
  type StackPlan,
  stackPlanHash,
} from "@opscrew/connector-portainer";
import type { ApplyOptions, ApplyResult, HostFacts, HostPlan } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { ApprovalGate, canonicalJson, MemoryApprovalStore, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, type PortainerWeb } from "@opscrew/plan-schema";
import { recordPortainerConnection, updateServerAddresses } from "../shared/server-record";
import {
  FakeHostServer,
  type FakePortainerOptions,
  fakeCertificate,
  fakePortainer,
  freshFacts,
  ownPlan,
  PORTAINER_URL,
  portainerPlan,
  ScriptedApprovalHandler,
  testPlan,
  unusedRemote,
} from "../testing";
import type { MoveTunnel } from "./connector";
import type { NextStacksApi, NextStacksInput } from "./connector-stacks";
import { moveHarness, unencrypted, ZONE } from "./session.fakes";
import type { MoveSession } from "./types";

/** B's tunnel of the app, and B's tunnel in front of Portainer's webhook. */
export const B_TUNNEL = "7a2e1d3f-2222-4b6c-8d4e-123456789abc";
export const B_WEBHOOK_TUNNEL = "7a2e1d3f-3333-4b6c-8d4e-123456789abc";
/** Where B's connectors connect from (never said). */
const ORIGIN_IP = "192.0.2.80";
const PORTAINER_TOKEN = fakeSecret("generic-password", "portainer-api-key");
const CERT = fakeCertificate("move portainer");

/** Where the app runs. */
export type ConnectorTarget =
  | { kind: "own" }
  | { kind: "cloud" }
  | { kind: "portainer"; web: PortainerWeb; redeploy: "updater" | "cloudflare" };

/** A cloud server's plan with Portainer on a subdomain, behind its own tunnel. */
function cloudSubdomainPlan(): DeployPlan {
  const base = testPlan({ domain: `shop.${ZONE}`, deployed: true });
  return DeployPlanSchema.parse({
    ...base,
    dns: { ...base.dns, zone: ZONE },
    portainer: {
      enabled: true,
      version: "2.33.1",
      access: "subdomain",
      hostname: `portainer.${ZONE}`,
      allowedEmails: ["owner@example.com"],
    },
  });
}

function planFor(target: ConnectorTarget): DeployPlan {
  if (target.kind === "own") return ownPlan({ access: "tunnel", deployed: true });
  if (target.kind === "cloud") return cloudSubdomainPlan();
  return portainerPlan({ web: target.web, redeploy: target.redeploy, deployed: true });
}

/** A connection of a connector to a tunnel of the fake. */
function connection(id: string) {
  return { id, colo_name: "fra08", opened_at: "2026-11-20T10:00:00.000Z", origin_ip: ORIGIN_IP };
}

/**
 * The host adapter over a fake server whose connectors connect B's tunnel: the beside connector
 * (`next`) as `beside`, the main connector once it has B's tunnel id as `main`; removing the beside
 * one disconnects it. Each apply notes how many of B's tunnel's connections there are after it.
 */
export class ConnectorHost extends FakeHostServer {
  /** B's tunnel's connections after each apply. */
  readonly connected: number[] = [];

  constructor(
    facts: HostFacts,
    private readonly tunnel: FakeTunnel,
  ) {
    super(facts);
  }

  override async apply(
    remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const result = await super.apply(remote, plan, options);
    for (const step of plan.steps) {
      const { next, remove, rewrite, tunnelId } = step.params;
      const project = `${plan.app}-tunnel-next`;
      if (next === true && remove === true) {
        this.facts = {
          ...this.facts,
          containers: this.facts.containers.filter((c) => c.project !== project),
        };
        this.disconnect("beside");
      } else if (next === true) {
        const name = `${project}-cloudflared-1`;
        this.facts = {
          ...this.facts,
          containers: [...this.facts.containers, { name, project, ports: "", running: true }],
        };
        this.connect("beside");
      } else if (rewrite === true && tunnelId === this.tunnel.id) {
        this.connect("main");
      }
    }
    this.connected.push(this.tunnel.connections.length);
    return result;
  }

  private connect(id: string): void {
    if (!this.tunnel.connections.some((c) => c.id === id)) {
      this.tunnel.connections.push(connection(id));
    }
  }

  private disconnect(id: string): void {
    this.tunnel.connections = this.tunnel.connections.filter((c) => c.id !== id);
  }
}

/** One apply of {@link fakeNextStacks}: the plan and the tokens it was sent, by stack name. */
export interface NextStacksApply {
  plan: StackPlan;
  tokens: Readonly<Record<string, string>>;
}

/**
 * The beside stacks as the Portainer connector would plan and apply them: a stack runs with the
 * fingerprint of the token it was last sent; a plan is in place when every stack runs with the
 * given one (or, to remove, when none runs); its apply refuses another hash and a missing token.
 */
export function fakeNextStacks() {
  const running = new Map<string, string>();
  const asked = new WeakMap<StackPlan, NextStacksInput>();
  const applies: NextStacksApply[] = [];
  const api: NextStacksApi = {
    plan: (facts, input) => {
      if (facts.environment?.id !== input.environmentId) throw new Error("inspect first");
      const changes: StackChange[] =
        input.stacks === "remove"
          ? [...running.keys()].map((name) => ({
              id: "tunnel-connector-stack",
              title: `Remove the stack ${name}`,
              state: "change",
              params: { action: "remove", name },
            }))
          : input.stacks.map(({ name, compose }) => {
              const fingerprint = input.fingerprints[name]?.TUNNEL_TOKEN;
              const params = { name, composeSha256: sha256Hex(compose), envKeys: ["TUNNEL_TOKEN"] };
              return fingerprint !== undefined && running.get(name) === fingerprint
                ? {
                    id: "tunnel-connector-stack",
                    title: `The stack ${name}`,
                    state: "in-place",
                    params: { ...params, action: "keep" },
                  }
                : {
                    id: "tunnel-connector-stack",
                    title: `Create the stack ${name}`,
                    state: "change",
                    params: { ...params, action: running.has(name) ? "update" : "create" },
                  };
            });
      const plan: StackPlan = {
        schemaVersion: 1,
        purpose: input.stacks === "remove" ? "teardown" : "setup",
        app: input.app,
        environmentId: input.environmentId,
        changes,
        findings: [],
        record: { stacks: [], volumes: [] },
        valuesDigest: sha256Hex(canonicalJson(input.fingerprints)),
      };
      asked.set(plan, input);
      return plan;
    },
    apply: async (_client, plan, options) => {
      if (stackPlanHash(plan) !== options.approvedHash) throw new Error("stack plan hash mismatch");
      const input = asked.get(plan);
      if (input === undefined) throw new Error("only a plan made here is applied");
      applies.push({ plan, tokens: options.secrets.nextTunnelTokens });
      const applied: string[] = [];
      for (const change of plan.changes.filter((c) => c.state === "change")) {
        const name = String(change.params.name);
        if (change.params.action === "remove") running.delete(name);
        else {
          if (options.secrets.nextTunnelTokens[name] === undefined) throw new Error("no token");
          running.set(name, input.fingerprints[name]?.TUNNEL_TOKEN ?? "");
        }
        applied.push(change.id);
      }
      return { applied };
    },
  };
  return { api, running, applies };
}

/** The main connectors' restarts a Portainer finish asks for (rotate's, faked). */
export function fakeConnectors() {
  const restarts: (readonly MoveTunnel[])[] = [];
  return {
    restarts,
    connectors: {
      check: async () => {},
      restart: async (tunnels: readonly MoveTunnel[]) => {
        restarts.push(tunnels);
      },
    },
  };
}

/** A clock that only `sleep` moves. */
export function fakeClock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

/**
 * The app on `target` in a move of {@link ZONE} from Old to New, prepared up to the connector: B's
 * tunnels in New (none connected yet) with their tokens, the server's or Portainer's login
 * recorded, and a session whose services hold the fake host and Portainer (`o.portainer`: the fake
 * Portainer's options).
 */
export async function connectorWorld(
  target: ConnectorTarget,
  o: { portainer?: Omit<FakePortainerOptions, "token"> } = {},
) {
  const plan = unencrypted(planFor(target));
  const h = await moveHarness({
    plans: () => ({ prod: plan }),
    ...(target.kind === "portainer" ? { env: { PORTAINER_API_KEY: PORTAINER_TOKEN } } : {}),
  });
  const b = h.cloudflare.account("New");
  const tunnel: FakeTunnel = { id: B_TUNNEL, name: "shop", connections: [] };
  const webhookTunnel: FakeTunnel = {
    id: B_WEBHOOK_TUNNEL,
    name: "shop-portainer",
    connections: [],
  };
  b.tunnels.push(tunnel, webhookTunnel);
  const tokens = {
    tunnel: fakeSecret("cloudflare-token", "b-tunnel"),
    portainer_tunnel: fakeSecret("cloudflare-token", "b-webhook-tunnel"),
  };
  const tunnels: MoveTunnel[] =
    target.kind === "portainer"
      ? [
          ...(target.web.mode === "tunnel"
            ? [{ module: "tunnel" as const, tunnelId: B_TUNNEL, token: tokens.tunnel }]
            : []),
          ...(target.redeploy === "cloudflare"
            ? [
                {
                  module: "portainer_tunnel" as const,
                  tunnelId: B_WEBHOOK_TUNNEL,
                  token: tokens.portainer_tunnel,
                },
              ]
            : []),
        ]
      : [{ module: "tunnel", tunnelId: B_TUNNEL, token: tokens.tunnel }];
  if (target.kind === "own") {
    await updateServerAddresses(h.deps.paths, (current) => ({
      ...current,
      own: { host: "192.0.2.50", port: 22, user: "admin", agent: true },
    }));
  }
  const portainer = fakePortainer({ ...o.portainer, token: PORTAINER_TOKEN });
  if (target.kind === "portainer") {
    await recordPortainerConnection(h.deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: CERT.fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: target.redeploy,
      web: target.web,
    });
  }
  const host = new ConnectorHost(
    target.kind === "own"
      ? freshFacts({ user: "admin", privilege: "sudo" })
      : freshFacts({ user: "deploy", privilege: "none" }),
    tunnel,
  );
  const clock = fakeClock();
  const opened = await h.open({
    to: "New",
    services: {
      ...h.services,
      host,
      remote: unusedRemote,
      ...clock,
      portainer: {
        client: (endpoint, token, clientDeps) =>
          portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
        inspectCertificate: async () => CERT,
      },
    },
  });
  // Every approval granted and recorded, as in a terminal where the user approves each plan.
  const { session, handler } = scripted(opened, "all");
  const [environment] = session.environments;
  if (environment === undefined) throw new Error("the app's environment is covered");
  const secrets = [...Object.values(tokens), PORTAINER_TOKEN];
  /** Every saved plan's text (host and stack plans). */
  const savedPlans = async () => {
    const dir = environment.paths.files.plansDir;
    const files = await readdir(dir).catch(() => [] as string[]);
    return Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
  };
  /** True when a token reached anything said, audited, asked, sent to Cloudflare or saved. */
  const leaks = async (...texts: string[]) => {
    const asked = JSON.stringify(handler.requests);
    const saved = (await savedPlans()).join("\n");
    const all = [...texts, asked, saved, JSON.stringify(host.applies.map((a) => a.plan))];
    return (
      h.leaks(...all) ||
      secrets.some((secret) => all.some((text) => text.includes(secret))) ||
      [h.deps.reporter.text(), JSON.stringify(h.deps.audit.entries)].some((text) =>
        secrets.some((secret) => text.includes(secret)),
      )
    );
  };
  return {
    ...h,
    plan,
    session,
    handler,
    environment,
    host,
    portainer,
    tunnel,
    webhookTunnel,
    tunnels,
    tokens,
    clock,
    leaks,
  };
}

export type ConnectorWorld = Awaited<ReturnType<typeof connectorWorld>>;

/**
 * `session` as a terminal's where the user approves every plan (`all`), or as a script's run
 * with `--approve <hash>` (`approve`; none without it): not interactive, its approval handler
 * granting only that hash. Its requests are recorded.
 */
export function scripted(session: MoveSession, approve: string | undefined | "all") {
  const all = approve === "all";
  const handler = new ScriptedApprovalHandler(
    (request) => all || (request.planHash !== undefined && request.planHash === approve),
  );
  const { deps } = session;
  const approvals = new ApprovalGate({
    handler,
    store: new MemoryApprovalStore(),
    audit: deps.audit,
    clock: deps.clock,
  });
  return {
    session: {
      ...session,
      approve: all ? undefined : approve,
      deps: { ...deps, approvals, interactive: all },
    },
    handler,
  };
}
