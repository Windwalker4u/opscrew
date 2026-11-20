/**
 * A move onto a server of the user's own that another app runs on (feature 030, spec US7 scenario
 * 4, plan 17.): `--to own` with `server.shares` naming that app takes its server's login and
 * pinned host key (`ownFirstApp`), keeps no reference to it, and moves as to any server of the
 * user's, beside the apps there; a tunnel or a server at home is refused in `ownFirstApp`'s words.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AppRecord, HostFactsSchema } from "@opscrew/connector-ssh-host";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { sharedAccessWarning } from "../design/own";
import {
  knownHostsName,
  type OwnServerConnectionInput,
  readServerAddresses,
  recordOwnServer,
  type SharesReference,
  serverAddressesFile,
  updateServerAddresses,
} from "../shared";
import { firstAppPaths } from "../shares/reference";
import {
  ED25519,
  ED25519_FINGERPRINT,
  FakeHostServer,
  type MoveHarness,
  moveHarness,
  OLD_IPV4,
  OLD_IPV6,
  ownRunner,
  preparedServerFacts,
  ScriptedRunner,
  secondAppRecord,
  TOKENS,
  targetOf,
} from "../testing";
import { everythingSeen, printed } from "./__fixtures__/beside";
import { NEW_IPV4 } from "./__fixtures__/pairs";
import { runRetarget } from "./run";
import { startMove } from "./start";
import type { RetargetOptions, RetargetSummary } from "./types";

/** The app on the user's server, which the move names. */
const FIRST = "blog";

/** What the first app's plan and record look like. */
interface OwnFirstOptions {
  /** Its plan's target, over a plain own target. */
  target?: object;
  /** Its plan's environment (a server at home runs its deploys on a runner of its own). */
  environment?: object;
  /** Its record, over the default login with a key file. */
  record?: Partial<OwnServerConnectionInput>;
}

/**
 * A live app `shop` on a Hetzner server, and `blog` provisioned on this computer on a server of
 * the user's at {@link NEW_IPV4}: its plan (served as `shop` is), its login with a key file of the
 * user's (synthetic content, never read), the server's host key pinned for it, and the server
 * holding `blog`'s record beside a stale record of `shop`.
 */
async function ownFirstStart(o: OwnFirstOptions = {}) {
  const h = await moveHarness();
  const keys = ownRunner();
  const previous = h.deps.runner;
  h.deps.runner = new ScriptedRunner(async (command, args, options) =>
    command === "ssh-keyscan"
      ? keys.run(command, args, options)
      : previous.run(command, args, options),
  );
  const ref: SharesReference = {
    root: await mkdtemp(join(tmpdir(), "opscrew-own-first-")),
    environment: "prod",
  };
  const paths = firstAppPaths(h.deps.paths, ref);
  const plan = DeployPlanSchema.parse({
    ...h.plan,
    app: { ...h.plan.app, name: FIRST },
    target: { ...targetOf("own"), ...o.target },
    ...(o.environment === undefined ? {} : { environment: o.environment }),
  });
  await writeArtifact("plan", paths.files.plan, plan);
  const keyPath = join(ref.root, "..", "keys-of-the-user", "id_ed25519");
  const key = fakeSecret("private-key-pem", "the-user-s-own-key");
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, key, { mode: 0o600 });
  await recordOwnServer(paths, {
    host: NEW_IPV4,
    port: 22,
    user: "admin",
    agent: false,
    keyPath,
    reachable: true,
    serve: plan.dns.proxied ? "proxy" : "dns-only",
    hostKey: ED25519_FINGERPRINT,
    publicIpv4: NEW_IPV4,
    ...o.record,
  });
  await updateServerAddresses(paths, (current) => ({
    ...current,
    deployment: { ipv4: NEW_IPV4 },
  }));
  await mkdir(dirname(paths.files.knownHosts), { recursive: true });
  await writeFile(paths.files.knownHosts, `${knownHostsName(NEW_IPV4)} ssh-ed25519 ${ED25519}\n`);
  const { shares: _, ...blog } = secondAppRecord({ app: FIRST });
  const facts = preparedServerFacts(h.paths.projectId);
  const server = new FakeHostServer(
    HostFactsSchema.parse({
      ...facts,
      apps: [...facts.apps, { name: FIRST, record: blog satisfies AppRecord }],
    }),
  );
  const options: RetargetOptions = {
    services: { ...h.services, own: { host: server, homeDir: h.root } },
    to: "own",
    sharedServer: ref,
  };
  return { ...h, ref, paths, keyPath, key, options };
}

type OwnFirstStart = Awaited<ReturnType<typeof ownFirstStart>>;

/** The move's state on this computer and in the repository: what a refusal leaves as it was. */
async function snapshot(h: MoveHarness): Promise<string> {
  const local = await readFile(serverAddressesFile(h.paths), "utf8").catch(() => "");
  return `${await readFile(h.paths.files.plan, "utf8")}\n${local}`;
}

/** No address, key file content or token in anything the run showed, planned or recorded. */
async function expectNoLeaks(h: OwnFirstStart): Promise<void> {
  const shown = await printed(h);
  for (const secret of [NEW_IPV4, OLD_IPV4, OLD_IPV6, h.key, TOKENS.hetzner, TOKENS.cloudflare]) {
    expect(shown).not.toContain(secret);
  }
  // The user's key is read by its path only, by ssh: its content is nowhere.
  expect(await everythingSeen(h)).not.toContain(h.key);
}

describe.skipIf(!findExecutable("git"))(
  "a move onto a server of the user's that another app runs on",
  () => {
    it("takes that app's login and pinned host key, keeps no reference, and warns of the shared access", async () => {
      const h = await ownFirstStart();
      let summary: RetargetSummary | undefined;
      const session = await startMove(h.deps, h.plan, {
        ...h.options,
        confirmStart: async (s) => {
          summary = s;
          return true;
        },
      });
      // A plain own target: the app is one more app on the user's server, naming no first app.
      expect(session.plan.target).toEqual({
        provider: "own",
        mode: "vps-compose",
        arch: "amd64",
        access: "public",
        edge: "caddy",
      });
      expect(session.plan.retarget).toMatchObject({
        step: "started",
        from: { target: h.plan.target },
      });
      expect(summary?.extraMonthly.amount).toBe(0);
      const local = await readServerAddresses(h.paths);
      expect(local.own).toEqual({
        host: NEW_IPV4,
        port: 22,
        user: "admin",
        agent: false,
        keyPath: h.keyPath,
        reachable: true,
        serve: "proxy",
        hostKey: ED25519_FINGERPRINT,
        publicIpv4: NEW_IPV4,
      });
      expect(local.own?.shares).toBeUndefined();
      expect(await readFile(h.paths.files.knownHosts, "utf8")).toContain(
        `${knownHostsName(NEW_IPV4)} ssh-ed25519 ${ED25519}`,
      );
      // The summary says what the apps there share; the stale record of the moving app is not one.
      const text = h.reporter.text();
      expect(text).toContain(sharedAccessWarning(FIRST));
      await expectNoLeaks(h);
    });

    it.each([
      {
        what: "a first app served through a Cloudflare Tunnel",
        record: { reachable: false, serve: "tunnel" } as const,
        says: `"${FIRST}" is served through a Cloudflare Tunnel, and this app can take a server's login only from an app served at the server's public address.`,
      },
      {
        what: "a first app on a server at home",
        target: { home: { ipv4: true } },
        environment: { runner: "server" },
        record: { reachable: undefined, publicIpv4: undefined, home: {} },
        says: `"${FIRST}" runs on a server at your home, and this app can take a server's login only from an app on a server reached at its public address.`,
      },
    ])("refuses $what in ownFirstApp's words, before any change", async (refusal) => {
      const h = await ownFirstStart(refusal);
      const before = await snapshot(h);
      const error = await runRetarget(h.deps, h.options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect((error as OpsCrewError).message).toBe(`${refusal.says} Nothing was changed.`);
      expect((error as OpsCrewError).hint).toContain(
        "Answer the interview's server questions with your server's own login instead",
      );
      expect(await snapshot(h)).toBe(before);
      expect(JSON.stringify(error)).not.toContain(NEW_IPV4);
      await expectNoLeaks(h);
    });
  },
);
