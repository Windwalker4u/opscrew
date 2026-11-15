/**
 * Test helpers for the finish (plan 7.), after the switch: the cloud server with both buckets on
 * R2 whose `app.env` the fake server answers, the app in the user's Portainer reached through the
 * fake, and any app's plans (several environments, GitHub Pages, a hosting account) prepared with
 * their committed roots and states.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { portainerClient } from "@opscrew/connector-portainer";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { ApprovalGate, fingerprintSha256, MemoryApprovalStore } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { pagesVerificationRootDir, portainerStackName } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import { pagesVerificationStateFile, r2Endpoint } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { recordPortainerConnection } from "../shared/server-record";
import { fakeCertificate, fakePortainer, PORTAINER_URL, ScriptedApprovalHandler } from "../testing";
import { fakeClock } from "./connector.fakes";
import { FinishEngine, finishWorld } from "./finish-removal.fakes";
import { moveHarness, recordedMove, ZONE } from "./session.fakes";
import { shadowFiles, shadowRoots } from "./shadow";
import { addressState } from "./shadow.fakes";
import { FINISH_COMMAND } from "./texts";
import type { MoveEnvironment, MoveSession } from "./types";

/** B's origin certificate and its key, and the app's client certificate and its key. */
export const B_PEM = pem("the certificate issued in New");
export const ORIGIN_KEY = fakeSecret("private-key-pem", "b-origin");
const PULL_PEM = pem("the app's client certificate");
const PULL_KEY = fakeSecret("private-key-pem", "client");
/** The app's own value on the server, besides its bucket's settings. */
const APP_KEY = fakeSecret("generic-password", "app-key");
/** A's tunnel token, as the app's stack in Portainer holds it before the finish. */
export const A_TUNNEL_TOKEN = fakeSecret("cloudflare-token", "a-tunnel");
const PORTAINER_TOKEN = fakeSecret("generic-password", "finish-portainer-api-key");
const REPO_TOKEN = fakeSecret("github-pat", "finish repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "finish ghcr read token");
const CERT = fakeCertificate("finish portainer");
/** The user's own value of the app in Portainer, from its env file. */
const STRIPE = fakeSecret("stripe-live-key", "finish portainer");

function pem(text: string): string {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(text).toString("base64")}\n-----END CERTIFICATE-----\n`;
}

/** A bucket's key as the environment holds it. */
function keyOf(
  env: Record<string, string | undefined>,
  vars: { accessKeyId: string; secretAccessKey: string },
) {
  return {
    accessKeyId: env[vars.accessKeyId] ?? "",
    secretAccessKey: env[vars.secretAccessKey] ?? "",
  };
}

/** Each account's bucket keys, as the environment holds them. */
function bucketKeys(env: Record<string, string | undefined>) {
  return {
    a: { storage: keyOf(env, STORAGE_KEY_VARS), backups: keyOf(env, OFFSITE_KEY_VARS) },
    b: { storage: keyOf(env, NEW_STORAGE_KEY_VARS), backups: keyOf(env, NEW_OFFSITE_KEY_VARS) },
  };
}

/** The app's settings as a deploy writes them, with the bucket's key and endpoint of `account`. */
export function appEnv(
  login: { accessKeyId: string; secretAccessKey: string },
  account: string,
): string {
  return [
    `APP_KEY=${APP_KEY}`,
    `AWS_ACCESS_KEY_ID=${login.accessKeyId}`,
    `AWS_ENDPOINT_URL_S3=${r2Endpoint(account)}`,
    "AWS_REGION=auto",
    `AWS_SECRET_ACCESS_KEY=${login.secretAccessKey}`,
    "S3_BUCKET=shop-uploads",
    "",
  ].join("\n");
}

/**
 * The cloud server with both buckets on R2, prepared, after the switch: its server's `app.env` on
 * A's bucket (`cat` answers it; a successful deploy writes GitHub's; `onCommand` sees every other
 * command first), B's record and origin certificate taken already, the recovery copy's age key
 * known.
 */
export async function serverPointWorld() {
  const w = await finishWorld("cloud", { buckets: true, step: "prepared" });
  const { a, b } = bucketKeys(w.deps.env);
  const server = {
    appEnv: appEnv(a.storage, w.old.id),
    onCommand: (_command: string) => {},
  };
  const inner = w.session.services.remote as (host: string) => RemoteExec;
  w.session.services.remote = (host) => ({
    host,
    run: async (command, options): Promise<CommandResult> => {
      if (command === "cat /srv/apps/shop/app.env") {
        return { exitCode: 0, stdout: server.appEnv, stderr: "" };
      }
      server.onCommand(command);
      return inner(host).run(command, options);
    },
  });
  w.github.deploy = () => {
    server.appEnv = w.github.secrets.get("OPSCREW_APP_ENV") ?? "";
  };
  const { paths } = w.environment;
  await writeFile(join(paths.stateDir, "recovery.json"), '{"recipients":["age1recipient"]}\n');
  const host = `shop.${ZONE}`;
  await writeFile(
    paths.files.cloudflareRecord,
    JSON.stringify({
      zoneId: w.bZone.id,
      hostnames: {},
      createdEntrypoints: [],
      tls: {
        origin: {
          id: "b-origin",
          hostnames: [host],
          expiresAt: "2041-10-16T23:53:00.000Z",
          sha256: fingerprintSha256(B_PEM),
          superseded: [],
        },
        client: {
          id: "client",
          expiresAt: "2041-10-16T23:53:00.000Z",
          sha256: fingerprintSha256(PULL_PEM),
          enabled: [host],
          retiring: [],
        },
      },
    }),
  );
  const values = generatedValuesFile({ paths });
  await mkdir(dirname(values), { recursive: true });
  await writeFile(
    values,
    JSON.stringify({
      originTls: {
        ORIGIN_TLS_KEY: ORIGIN_KEY,
        ORIGIN_TLS_CERT: B_PEM,
        ORIGIN_PULL_KEY: PULL_KEY,
        ORIGIN_PULL_CERT: PULL_PEM,
      },
    }),
  );
  const secrets = [
    ...Object.values(a).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
    ...Object.values(b).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
    ORIGIN_KEY,
    PULL_KEY,
    APP_KEY,
  ];
  /** True when a key, the app's values or the origin's key was said, asked or audited. */
  const leaks = (...texts: string[]) => {
    const said = [
      ...texts,
      w.deps.reporter.text(),
      JSON.stringify(w.deps.audit.entries),
      JSON.stringify(w.handler.requests),
    ].join("\n");
    return w.leaks(...texts) || secrets.some((secret) => said.includes(secret));
  };
  return { ...w, a, b, server, leaks };
}

/** The app in the user's Portainer after the switch, prepared, with both buckets on R2. */
export async function portainerFinishWorld() {
  const w = await finishWorld("portainer", { buckets: true, step: "prepared" });
  const { paths, plan } = w.environment;
  const portainer = fakePortainer({ token: PORTAINER_TOKEN });
  await recordPortainerConnection(paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "tunnel" },
  });
  await writeFile(join(w.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  Object.assign(w.deps.env, {
    PORTAINER_API_KEY: PORTAINER_TOKEN,
    [REPOSITORY_TOKEN_VAR]: REPO_TOKEN,
    [REGISTRY_TOKEN_VAR]: GHCR_TOKEN,
    OPSCREW_APP_ENV_FILE: "production.env",
  });
  w.session.services.portainer = {
    client: (endpoint, token, clientDeps) =>
      portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
    inspectCertificate: async () => CERT,
    randomUUID: () => "6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e",
    wait: { now: () => 0, sleep: async () => undefined },
  };
  // The main root's state as provision left it: its outputs hold A's tunnel token.
  const main = w.rootOf("main");
  const { environmentState } = shadowFiles(main);
  await w.engine.init(main.dir, { backendConfig: { path: environmentState } });
  w.engine.stateOutputs.set(environmentState, { tunnel_token: A_TUNNEL_TOKEN });
  // The recovery copy's age key, which the off-server copies are encrypted to.
  await writeFile(join(paths.stateDir, "recovery.json"), '{"recipients":["age1recipient"]}\n');
  const keys = bucketKeys(w.deps.env);
  /** The app's stack's values in Portainer, by name. */
  const appStack = (): Record<string, string> => {
    const stack = portainer.stacks.find((one) => one.Name === portainerStackName(plan));
    return Object.fromEntries((stack?.Env ?? []).map((one) => [one.name, one.value]));
  };
  /** True when a key or token was said, asked, audited or saved in a stack plan file. */
  const leaks = async (...texts: string[]) => {
    const dir = paths.files.plansDir;
    const files = await readdir(dir).catch(() => [] as string[]);
    const saved = await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
    const said = [
      ...texts,
      ...saved,
      w.deps.reporter.text(),
      JSON.stringify(w.deps.audit.entries),
      JSON.stringify(w.handler.requests),
    ].join("\n");
    const secrets = [
      ...Object.values(keys.a).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
      ...Object.values(keys.b).flatMap((one) => [one.accessKeyId, one.secretAccessKey]),
      A_TUNNEL_TOKEN,
      PORTAINER_TOKEN,
      REPO_TOKEN,
      GHCR_TOKEN,
      STRIPE,
    ];
    return w.leaks(...texts) || secrets.some((secret) => said.includes(secret));
  };
  return { ...w, portainer, keys, appStack, leaks };
}

/** GitHub's verification record of a Pages site, as its root's state holds it. */
const CHALLENGE = "cloudflare_dns_record.challenge";

/**
 * The app with `plans` (by environment, prod's first) after the switch, each prepared, New's zone
 * active: each root's committed values with New's ids, each environment's state and B's shadow
 * state of each of its roots (a Pages site's verification root's too), and a session of the finish
 * (interactive, every approval granted and recorded) with a {@link FinishEngine}.
 */
export async function appWorld(plans: Record<string, DeployPlan>) {
  const h = await moveHarness({
    bZone: true,
    plans: (cloudflare) =>
      Object.fromEntries(
        Object.entries(plans).map(([name, plan]) => {
          const recorded = recordedMove(plan, cloudflare);
          const move = { ...recorded.cloudflareMove, step: "prepared" };
          return [name, DeployPlanSchema.parse({ ...recorded, cloudflareMove: move })];
        }),
      ),
  });
  const bZone = h.cloudflare.zone(ZONE, "New");
  h.cloudflare.activate(bZone);
  const fresh = h.cloudflare.account("New");
  const engine = new FinishEngine();
  const handler = new ScriptedApprovalHandler(() => true);
  const first = await h.open({
    command: FINISH_COMMAND,
    services: { ...h.services, ...fakeClock(), engine: async () => engine },
  });
  const approvals = new ApprovalGate({
    handler,
    store: new MemoryApprovalStore(),
    audit: first.deps.audit,
    clock: first.deps.clock,
  });
  const session: MoveSession = {
    ...first,
    deps: { ...first.deps, approvals, interactive: true },
  };
  const write = async (file: string, content: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  for (const { plan, paths } of session.environments) {
    const dirs = [plan.infra.dir];
    if (plan.target.provider === "github-pages") {
      dirs.push(pagesVerificationRootDir(plan));
      await write(pagesVerificationStateFile(paths), addressState([CHALLENGE]));
    }
    for (const dir of dirs) {
      await write(join(h.root, dir, "main.tf"), "# the app's root\n");
      const values = {
        app: plan.app.name,
        cloudflare_zone_id: bZone.id,
        cloudflare_account_id: fresh.id,
      };
      await write(join(h.root, dir, "terraform.tfvars.json"), `${JSON.stringify(values)}\n`);
    }
  }
  /** The covered environment `name`. */
  const environmentOf = (name: string): MoveEnvironment => {
    const found = session.environments.find((one) => one.environment === name);
    if (found === undefined) throw new Error(`${name} is not covered`);
    return found;
  };
  for (const environment of session.environments) {
    for (const root of await shadowRoots(session, environment)) {
      await write(root.statePath, addressState([`module.dns.cloudflare_dns_record.${root.name}`]));
    }
  }
  return { ...h, session, engine, handler, bZone, fresh, environmentOf };
}
