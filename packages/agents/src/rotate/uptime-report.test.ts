/**
 * `opscrew rotate` and the server's uptime report (feature 046, User Story 4): the new date of a
 * rotated credential reaches the report's config on the server through the server's host plan,
 * approved by its hash; a declined plan warns that the old date stays there.
 */
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readReportKey } from "../check/key";
import { planProvisionUptime, provisionUptime } from "../check/uptime";
import {
  FakeReportServer,
  fakeUptimeAccount,
  uptimePlan,
  WEBHOOK_URL,
} from "../check/uptime.fakes";
import { recordServerAddress } from "../shared/server-record";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  unusedRemote,
} from "../testing";
import { credentialsRecordFile, recordRotation } from "./record";
import { updateReportDates } from "./uptime-report";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const FIRST_DEPLOY = "2026-01-02T03:04:05Z";

/** The `shop` app's prod plan on Hetzner, checked by the Worker with the credentials' ages. */
function plan(credentials = true): DeployPlan {
  const base = uptimePlan("cloudflare");
  return DeployPlanSchema.parse({
    ...base,
    observability: {
      check: { enabled: true, runner: "cloudflare", webhook: "slack", credentials },
    },
    deployment: { ...base.deployment, firstDeployAt: FIRST_DEPLOY },
  });
}

/** The environment provisioned with the Worker: its entry, and the server's report running. */
async function provisioned(
  options: { answer?: () => boolean; credentials?: boolean; interactive?: boolean } = {},
) {
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    env: { OPSCREW_CHECK_WEBHOOK: WEBHOOK_URL },
    clock: { now: () => NOW },
  });
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  await ensureDeployKey(deps.paths, deps.redactor);
  const deployPlan = plan(options.credentials);
  await writeArtifact("plan", deps.paths.files.plan, deployPlan);
  const server = new FakeReportServer();
  const { client } = fakeUptimeAccount();
  const services = { sharedCloudflare: client, serverHost: server, remote: unusedRemote };
  const step = await planProvisionUptime(deps, {
    plan: deployPlan,
    github: async () => ({ owner: "acme", repo: "shop" }),
    services,
    command: "opscrew provision",
    ask: false,
  });
  await provisionUptime(deps, step, { command: "opscrew provision", phase: "provision" });
  handler.requests.length = 0;
  // A terminal by default, where the prompt asks; `interactive: false` is a script.
  deps.interactive = options.interactive ?? true;
  return { deps, handler, server, services };
}

/** The `credential=` lines of the server's config, as the last applied step set them. */
function credentialLines(server: FakeReportServer): string[] {
  return String(server.applies.at(-1)?.plan.steps[0]?.params.credentials).split("\n");
}

/** The rotation record with `deploy-key` rotated at `at`, as `recordRotation` writes it. */
async function rotatedAt(deps: Awaited<ReturnType<typeof provisioned>>["deps"], at: string) {
  await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
    schemaVersion: 1,
    environments: { prod: { "deploy-key": { rotatedAt: at, generation: 2 } } },
  });
}

describe("updateReportDates", () => {
  it("writes the new date into the server's config through its host plan, approved by its hash", async () => {
    const s = await provisioned();
    expect(credentialLines(s.server)).toContain(`deploy-key ${FIRST_DEPLOY} first-deploy`);
    await rotatedAt(s.deps, NOW.toISOString());
    await updateReportDates(s.deps, ["deploy-key"], s.services);

    const [request] = s.handler.requests;
    expect(request).toMatchObject({
      kind: "host-apply",
      title: "Report the checks of the server to the Cloudflare uptime Worker",
    });
    expect(s.server.applies).toHaveLength(2);
    expect(s.server.applies.at(-1)?.options.approvedHash).toBe(request?.planHash);
    expect(credentialLines(s.server)).toContain(`deploy-key ${NOW.toISOString()} rotated`);
    // The key goes to the adapter only, never into the plan, a line or the approval.
    const key = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(s.server.applies.at(-1)?.options.secrets).toEqual({ uptimeReportKey: key?.value });
    const seen = JSON.stringify([s.deps.reporter.lines, s.deps.audit.entries, s.handler.requests]);
    expect(seen).not.toContain(key?.value);
  });

  it("warns that the old date stays on the server when the plan is declined", async () => {
    let approve = true;
    const s = await provisioned({ answer: () => approve });
    await rotatedAt(s.deps, NOW.toISOString());
    approve = false;
    await updateReportDates(s.deps, ["deploy-key"], s.services);
    expect(s.server.applies).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain(
      "The uptime report on the server keeps the old date of deploy-key, so its daily check may still say it is old.",
    );
    expect(s.deps.reporter.text()).toContain("opscrew provision --approve ");
  });

  it("in a script, saves the host plan and names its own --approve, never asking with the rotation's hash", async () => {
    const s = await provisioned({ interactive: false });
    await rotatedAt(s.deps, NOW.toISOString());
    await updateReportDates(s.deps, ["deploy-key"], s.services);
    // No approval is asked, so no --approve the user gave for the rotation meets this plan.
    expect(s.handler.requests).toEqual([]);
    expect(s.server.applies).toHaveLength(1);
    const text = s.deps.reporter.text();
    const hash = /Saved the host plan \(hash ([0-9a-f]{64})\)/.exec(text)?.[1];
    expect(hash).toBeDefined();
    expect(text).toContain(
      `The uptime report on the server keeps the old date of deploy-key, so its daily check may still say it is old. Run \`opscrew provision --approve ${hash}\` to put the new date there.`,
    );
    expect(text).not.toContain("approve it too");
  });

  it("reads no server for a credential the report doesn't date, or with the credentials' ages off", async () => {
    const s = await provisioned();
    await updateReportDates(s.deps, ["cloudflare"], s.services);
    const off = await provisioned({ credentials: false });
    await rotatedAt(off.deps, NOW.toISOString());
    await updateReportDates(off.deps, ["deploy-key"], off.services);
    expect([...s.handler.requests, ...off.handler.requests]).toEqual([]);
    expect([s.server.applies, off.server.applies].map((applies) => applies.length)).toEqual([1, 1]);
  });
});

describe("recordRotation", () => {
  it("then updates the server's uptime report, and warns where this computer didn't set it up", async () => {
    const deps = await createTestPhaseDeps({ clock: { now: () => NOW } });
    await ensureDeployKey(deps.paths, deps.redactor);
    await writeArtifact("plan", deps.paths.files.plan, plan());
    await recordRotation(deps, ["deploy-key"]);
    expect(deps.reporter.text()).toContain(
      "The uptime report on the server keeps the old date of deploy-key, so its daily check may still say it is old: this computer did not set the report up. Run `opscrew provision` on the computer that did to put the new date there.",
    );
  });
});
