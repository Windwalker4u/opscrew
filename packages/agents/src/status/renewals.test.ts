import { type DeployPlan, type Renewal, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { registrarLinks } from "../domain/registrars";
import {
  type DomainProject,
  domainProject,
  domainTestPlan,
  TOKEN,
  usd,
  visibleText,
} from "../testing";
import { renewalStatusReport } from "./renewals";

const DOMAIN = "example.com";
const NEXT = "2026-11-30T12:00:00.000Z";
const eur = (amount: number) => ({ amount, currency: "EUR" as const });

/** A plan whose domain OpsCrew bought at `provider`, renewing on {@link NEXT}. */
function renewalPlan(renewal: Partial<Renewal> = {}): DeployPlan {
  const plan = domainTestPlan({ domain: DOMAIN });
  const provider = renewal.provider ?? "cloudflare";
  const autoRenew = renewal.autoRenew ?? true;
  return {
    ...plan,
    dns: {
      ...plan.dns,
      zone: DOMAIN,
      registration: {
        registrar: provider,
        expiresAt: NEXT,
        autoRenew,
        privacy: true,
        dnssec: true,
      },
    },
    cost: {
      ...plan.cost,
      renewals: [{ item: DOMAIN, provider, price: usd(10.44), next: NEXT, autoRenew, ...renewal }],
    },
  };
}

/** Runs `opscrew status`'s renewal section at `now` against the project's plan on disk. */
async function report(project: DomainProject, now: string, token?: string | null) {
  const { deps, services } = await project.run({ now, token });
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const result = await renewalStatusReport(deps, plan, { services });
  return { deps, result, plan: await readArtifact("plan", deps.paths.files.plan) };
}

describe("opscrew status: the renewals of the domains OpsCrew bought (FR-3113)", () => {
  it("calls no registrar while every renewal is more than 30 days away", async () => {
    const project = await domainProject({ plan: renewalPlan() });
    const pb = project.other("porkbun");
    const before = await readArtifact("plan", (await project.run()).deps.paths.files.plan);

    // no Cloudflare token either: nothing is needed yet
    const { result, plan } = await report(project, "2026-10-30T11:59:59.000Z", null);

    expect(result.lines).toEqual([]);
    expect(project.cf.events).toEqual([]);
    expect(pb.count("getDomain")).toBe(0);
    expect(plan).toEqual(before);
  });

  it("records a renewal the registrar charged by now, and moves the dates on", async () => {
    const project = await domainProject({ plan: renewalPlan() });
    project.cf.own(DOMAIN, { expiresAt: "2027-11-30T12:00:00Z", autoRenew: true });

    const { deps, result, plan } = await report(project, "2026-11-20T09:00:00.000Z");

    expect(project.cf.events).toEqual(["accounts", `getDomain ${DOMAIN}`]);
    expect(result.lines).toEqual([
      "example.com was renewed at Cloudflare until 2027-11-30: OpsCrew recorded the renewal ($10.44) in opscrew/plan.yaml.",
    ]);
    expect(plan.cost.oneTime).toEqual([
      // seen before its date: the registrar charged it by the time of the read
      {
        item: "example.com, renewal (1 year)",
        provider: "cloudflare",
        price: eur(9.49),
        at: "2026-11-20T09:00:00.000Z",
      },
    ]);
    expect(plan.cost.renewals).toEqual([
      {
        item: DOMAIN,
        provider: "cloudflare",
        price: usd(10.44),
        next: "2027-11-30T12:00:00.000Z",
        autoRenew: true,
      },
    ]);
    expect(plan.dns.registration?.expiresAt).toBe("2027-11-30T12:00:00.000Z");
    expect(plan.updatedAt).toBe("2026-11-20T09:00:00.000Z");
    expect(visibleText(deps)).not.toContain(TOKEN);

    // the next run reads the registrar again only 30 days before the new date
    project.cf.events.length = 0;
    const again = await report(project, "2026-11-21T09:00:00.000Z");
    expect(again.result.lines).toEqual([]);
    expect(project.cf.events).toEqual([]);
    expect(again.plan.cost.oneTime).toHaveLength(1);
  });

  it("records a renewal seen after its date has passed, at the old date", async () => {
    const project = await domainProject({ plan: renewalPlan({ provider: "porkbun" }) });
    project.other("porkbun").own(DOMAIN, { expiresAt: "2027-11-30T12:00:00Z", autoRenew: true });

    const { plan } = await report(project, "2026-12-03T09:00:00.000Z");

    expect(plan.cost.oneTime).toEqual([
      { item: "example.com, renewal (1 year)", provider: "porkbun", price: eur(9.49), at: NEXT },
    ]);
    expect(plan.cost.renewals?.[0]?.next).toBe("2027-11-30T12:00:00.000Z");
  });

  it("says nothing and changes nothing while a renewal due with auto-renew on is not charged yet", async () => {
    const project = await domainProject({ plan: renewalPlan() });
    project.cf.own(DOMAIN, { expiresAt: NEXT, autoRenew: true });
    const before = await readArtifact("plan", (await project.run()).deps.paths.files.plan);

    const { result, plan } = await report(project, "2026-11-20T09:00:00.000Z");

    expect(result.lines).toEqual([]);
    expect(plan).toEqual(before);
  });

  it.each([
    ["cloudflare", "Turn it on with `opscrew domain auto-renew on`."],
    ["porkbun", "Turn it on with `opscrew domain auto-renew on`."],
    ["namecheap", `Turn it on at ${registrarLinks("namecheap").domains}.`],
    ["godaddy", `Turn it on at ${registrarLinks("godaddy").domains}.`],
  ] as const)("warns with the date and how to turn auto-renew on at %s", async (id, how) => {
    const project = await domainProject({ plan: renewalPlan({ provider: id, autoRenew: false }) });
    const registrar = id === "cloudflare" ? project.cf : project.other(id);
    registrar.own(DOMAIN, { expiresAt: NEXT, autoRenew: false });

    const { result } = await report(project, "2026-11-20T09:00:00.000Z");

    expect(result.lines).toEqual([
      `Warning: auto-renew is off for example.com, so it expires on 2026-11-30 unless you renew it. ${how}`,
    ]);
  });

  it("follows auto-renew turned off at the registrar, and says when the domain expired", async () => {
    const project = await domainProject({ plan: renewalPlan() });
    project.cf.own(DOMAIN, { expiresAt: NEXT, autoRenew: false });

    const { result, plan } = await report(project, "2026-12-01T09:00:00.000Z");

    expect(result.lines).toEqual([
      "Warning: auto-renew is off for example.com, so it expired on 2026-11-30 unless you renewed it since. Turn it on with `opscrew domain auto-renew on`.",
    ]);
    expect(plan.cost.renewals?.[0]?.autoRenew).toBe(false);
    expect(plan.dns.registration?.autoRenew).toBe(false);
  });

  it("says plainly when a registrar can't be read, and goes on with the others", async () => {
    const base = renewalPlan();
    const plan: DeployPlan = {
      ...base,
      cost: {
        ...base.cost,
        renewals: [
          {
            item: "example.net",
            provider: "porkbun",
            price: usd(11.08),
            next: NEXT,
            autoRenew: false,
          },
          ...(base.cost.renewals ?? []),
        ],
      },
    };
    const project = await domainProject({ plan });
    const pb = project.other("porkbun");
    pb.failures.getDomain = () => new Error("connect ETIMEDOUT");
    project.cf.own(DOMAIN, { expiresAt: "2027-11-30T12:00:00Z", autoRenew: true });

    const { result, plan: after } = await report(project, "2026-11-20T09:00:00.000Z");

    expect(result.lines).toEqual([
      "OpsCrew could not check the renewal of example.net at Porkbun: connect ETIMEDOUT. Run `opscrew status` again once Porkbun can be reached.",
      `Warning: auto-renew is off for example.net, so it expires on 2026-11-30 unless you renew it. Turn it on at ${registrarLinks("porkbun").domains}.`,
      "example.com was renewed at Cloudflare until 2027-11-30: OpsCrew recorded the renewal ($10.44) in opscrew/plan.yaml.",
    ]);
    expect(after.cost.renewals?.map((renewal) => renewal.next)).toEqual([
      NEXT,
      "2027-11-30T12:00:00.000Z",
    ]);
  });

  it("says what to set when the registrar's credentials are missing here", async () => {
    const project = await domainProject({ plan: renewalPlan() });
    const { deps } = await project.run({ now: "2026-11-20T09:00:00.000Z", token: null });
    const plan = await readArtifact("plan", deps.paths.files.plan);

    // the collaborators built from the environment, which has no Cloudflare token
    const result = await renewalStatusReport(deps, plan, { services: {} });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(
      /^OpsCrew could not check the renewal of example\.com at Cloudflare: .*CLOUDFLARE_API_TOKEN/,
    );
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("says when the registrar no longer lists the domain", async () => {
    const project = await domainProject({ plan: renewalPlan() });

    const { result } = await report(project, "2026-11-20T09:00:00.000Z");

    expect(result.lines).toEqual([
      "Cloudflare does not list example.com in your account, so OpsCrew could not check its renewal. Check the Cloudflare dashboard (https://dash.cloudflare.com, Domain Registration).",
    ]);
  });
});

it("keeps an old plan without renewals as it is", async () => {
  const project = await domainProject({ plan: domainTestPlan({ domain: DOMAIN }) });

  const { result } = await report(project, "2026-11-20T09:00:00.000Z");

  expect(result.lines).toEqual([]);
  expect(project.cf.events).toEqual([]);
});
