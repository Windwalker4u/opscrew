/**
 * Test helpers for the finish in the user's Portainer: the app (its connector in web mode `tunnel`,
 * its files and the snapshots' copies on R2) after the switch, prepared, its Portainer reached
 * through the fake with no stack of the app's yet, the tokens its stacks need, and its main root's
 * state as provision left it, with A's tunnel token.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { portainerClient } from "@opscrew/connector-portainer";
import { fakeSecret } from "@opscrew/core/testing";
import { portainerStackName } from "@opscrew/iac-templates";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../provision/portainer";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import { recordPortainerConnection } from "../shared/server-record";
import { fakeCertificate, fakePortainer, PORTAINER_URL } from "../testing";
import { finishWorld } from "./finish-removal.fakes";
import { shadowFiles } from "./shadow";

/** A's tunnel token, as the app's stack holds it before the finish. */
export const A_TUNNEL_TOKEN = fakeSecret("cloudflare-token", "a-tunnel");
const PORTAINER_TOKEN = fakeSecret("generic-password", "finish-portainer-api-key");
const REPO_TOKEN = fakeSecret("github-pat", "finish repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "finish ghcr read token");
const CERT = fakeCertificate("finish portainer");
/** The user's own value of the app, from its env file. */
const STRIPE = fakeSecret("stripe-live-key", "finish portainer");

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
  const env = w.deps.env;
  const keys = {
    a: { storage: keyOf(env, STORAGE_KEY_VARS), backups: keyOf(env, OFFSITE_KEY_VARS) },
    b: { storage: keyOf(env, NEW_STORAGE_KEY_VARS), backups: keyOf(env, NEW_OFFSITE_KEY_VARS) },
  };
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
