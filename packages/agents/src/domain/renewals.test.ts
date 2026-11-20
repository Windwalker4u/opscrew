import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  buyable,
  type DomainProject,
  domainProject,
  domainTestPlan,
  RUN_NOW,
  testRequirements,
  usd,
} from "../testing";
import { buyDomain } from "./buy";
import { domainStatus, setDomainAutoRenew } from "./manage";
import type { OtherRegistrarId } from "./registrars";

const DOMAIN = "example.com";
const eur = (amount: number) => ({ amount, currency: "EUR" as const });

/** A project whose plan has no domain yet, with `DOMAIN` for sale at every registrar. */
async function saleProject(options: Parameters<typeof domainProject>[0] = {}) {
  const project = await domainProject({ plan: domainTestPlan(), ...options });
  project.cf.checks.set(DOMAIN, buyable(DOMAIN, 10.44, 12.5));
  return project;
}

/** `id`'s fake, selling `DOMAIN` at `firstYear` (renewal `renewal`) with the money to pay. */
function sellAt(project: DomainProject, id: OtherRegistrarId, firstYear: number, renewal: number) {
  const fake = project.other(id);
  fake.checks.set(DOMAIN, buyable(DOMAIN, firstYear, renewal));
  fake.account = { ok: true, message: "The API access works.", balance: usd(50) };
  if (id === "godaddy") {
    fake.quoteExtras = { token: "quote-token-1", expiresAt: "2026-10-11T12:10:00.000Z" };
  }
  return fake;
}

async function planOf(project: DomainProject): Promise<DeployPlan> {
  const { deps } = await project.run();
  return readArtifact("plan", deps.paths.files.plan);
}

describe("opscrew domain buy: the purchase and its renewal in the plan's cost (FR-3113)", () => {
  it("records a purchase at Cloudflare in oneTime, in the cost's currency, and its renewal as quoted", async () => {
    const project = await saleProject();
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    const plan = await planOf(project);
    expect(plan.cost.oneTime).toEqual([
      // $10.44 at the fixed rate of the cost's other conversions
      { item: "example.com, 1 year", provider: "cloudflare", price: eur(9.49), at: RUN_NOW },
    ]);
    expect(plan.cost.renewals).toEqual([
      {
        item: DOMAIN,
        provider: "cloudflare",
        price: usd(12.5),
        next: "2027-10-11T12:00:05.000Z",
        autoRenew: true,
      },
    ]);
    // the cost's estimate is unchanged
    expect(plan.cost.monthly).toEqual(eur(7.09));
    expect(plan.cost.breakdown).toHaveLength(1);
  });

  it("records several years at Cloudflare with the approved bound, and auto-renew off", async () => {
    const project = await saleProject();
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, years: 2, autoRenew: false, services });

    const plan = await planOf(project);
    expect(plan.cost.oneTime).toEqual([
      { item: "example.com, 2 years", provider: "cloudflare", price: eur(22.73), at: RUN_NOW },
    ]);
    expect(plan.cost.renewals).toEqual([
      {
        item: DOMAIN,
        provider: "cloudflare",
        price: usd(12.5),
        next: "2028-10-11T12:00:05.000Z",
        autoRenew: false,
      },
    ]);
  });

  it.each([
    ["porkbun", 11.08, 12.5, eur(10.07), true],
    // Namecheap's and GoDaddy's APIs cannot set auto-renew: the account's own setting (off) is kept
    ["namecheap", 9.58, 14.98, eur(8.71), false],
    ["godaddy", 11.99, 22.99, eur(10.9), false],
  ] as const)(
    "records a purchase at %s with that registrar's id, charge and renewal",
    async (id, firstYear, renewal, price, autoRenew) => {
      const project = await saleProject();
      sellAt(project, id, firstYear, renewal);
      const { deps, services } = await project.run();

      await buyDomain(deps, { domain: DOMAIN, registrar: id, services });

      const plan = await planOf(project);
      expect(plan.cost.oneTime).toEqual([
        { item: "example.com, 1 year", provider: id, price, at: RUN_NOW },
      ]);
      expect(plan.cost.renewals).toEqual([
        {
          item: DOMAIN,
          provider: id,
          price: usd(renewal),
          next: "2027-10-11T12:00:05.000Z",
          autoRenew,
        },
      ]);
    },
  );

  it("keeps the purchase's charge in the cost's own currency (USD at DigitalOcean)", async () => {
    const base = domainTestPlan();
    const plan: DeployPlan = {
      ...base,
      cost: {
        ...base.cost,
        monthly: usd(6),
        breakdown: [{ item: "server", monthly: usd(6) }],
      },
    };
    const project = await saleProject({ plan });
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    expect((await planOf(project)).cost.oneTime?.[0]?.price).toEqual(usd(10.44));
  });

  it("adds neither twice when a rerun finishes a purchase an earlier run recorded", async () => {
    const project = await saleProject();
    const first = await project.run();
    await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
    const recorded = await planOf(project);
    // as when the setup after the plan was written failed: the note is still there
    await project.writeRecord({
      domain: DOMAIN,
      accountId: "acc-1",
      requestedAt: RUN_NOW,
      years: 1,
      autoRenew: true,
      total: usd(10.44),
      renewal: usd(12.5),
      registrar: "cloudflare",
    });

    const rerun = await project.run({ now: "2026-10-11T12:30:00.000Z" });
    await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services });

    expect(project.cf.registerCalls).toHaveLength(1);
    const plan = await planOf(project);
    expect(plan.cost.oneTime).toEqual(recorded.cost.oneTime);
    expect(plan.cost.renewals).toEqual(recorded.cost.renewals);
  });

  it("adds neither twice when the rerun comes in a later month than the finish that recorded it", async () => {
    const project = await saleProject();
    // sent on 2026-10-11; the registrar finished the order later
    project.cf.own(DOMAIN);
    const note = {
      domain: DOMAIN,
      accountId: "acc-1",
      requestedAt: RUN_NOW,
      years: 1,
      autoRenew: true,
      total: usd(10.44),
      renewal: usd(12.5),
      registrar: "cloudflare",
      outcome: "accepted",
    };
    await project.writeRecord(note);
    const first = await project.run({ now: "2026-11-15T09:00:00.000Z" });
    await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
    const recorded = await planOf(project);
    expect(recorded.cost.oneTime?.map((fee) => fee.at)).toEqual([RUN_NOW]);
    // that run died before it removed its note
    await project.writeRecord(note);

    const rerun = await project.run({ now: "2026-12-15T09:00:00.000Z" });
    await buyDomain(rerun.deps, { domain: DOMAIN, services: rerun.services });

    const plan = await planOf(project);
    // no second fee; the first, of October, is older than the months a plan keeps in December
    expect(plan.cost.oneTime).toBeUndefined();
    expect(plan.cost.renewals).toEqual(recorded.cost.renewals);
  });

  it("keeps a purchase finished more than a month after it started, in the oldest month kept", async () => {
    const project = await saleProject();
    // the registrar finished the order an earlier run sent on 2026-10-11
    project.cf.own(DOMAIN);
    await project.writeRecord({
      domain: DOMAIN,
      accountId: "acc-1",
      requestedAt: RUN_NOW,
      years: 1,
      autoRenew: true,
      total: usd(10.44),
      renewal: usd(12.5),
      registrar: "cloudflare",
      outcome: "accepted",
    });

    const late = await project.run({ now: "2026-12-15T09:00:00.000Z" });
    await buyDomain(late.deps, { domain: DOMAIN, services: late.services });

    expect(project.cf.registerCalls).toHaveLength(0);
    expect((await planOf(project)).cost.oneTime).toEqual([
      {
        item: "example.com, 1 year",
        provider: "cloudflare",
        price: eur(9.49),
        at: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  it("records nothing for a domain the account already had (bought elsewhere)", async () => {
    const project = await saleProject();
    project.cf.own(DOMAIN);
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    const plan = await planOf(project);
    expect(plan.dns.registration).toMatchObject({ registrar: "cloudflare" });
    expect(plan.cost.oneTime).toBeUndefined();
    expect(plan.cost.renewals).toBeUndefined();
  });

  it("records nothing without a plan, as it records no registration then", async () => {
    const project = await domainProject({ requirements: testRequirements() });
    project.cf.checks.set(DOMAIN, buyable(DOMAIN));
    const { deps, services } = await project.run();

    const result = await buyDomain(deps, { domain: DOMAIN, services });

    expect(result).toMatchObject({ recorded: { plan: false, requirements: true } });
    const plan = await readArtifact("plan", deps.paths.files.plan).catch(() => undefined);
    expect(plan).toBeUndefined();
  });

  it("keeps the renewals whole when the plan's write prunes old one-time fees", async () => {
    const base = domainTestPlan();
    const old = {
      item: "Setup fee",
      provider: "contabo",
      price: eur(5),
      at: "2026-08-01T00:00:00Z",
    };
    const project = await saleProject({
      plan: { ...base, cost: { ...base.cost, oneTime: [old] } },
    });
    const { deps, services } = await project.run();

    await buyDomain(deps, { domain: DOMAIN, services });

    const plan = await planOf(project);
    expect(plan.cost.oneTime?.map((fee) => fee.item)).toEqual(["example.com, 1 year"]);
    expect(plan.cost.renewals?.map((renewal) => renewal.item)).toEqual([DOMAIN]);
  });
});

/** A project with `DOMAIN` bought through OpsCrew (Cloudflare, expiring 2027-10-11). */
async function boughtProject(): Promise<DomainProject> {
  const project = await saleProject();
  const first = await project.run();
  await buyDomain(first.deps, { domain: DOMAIN, services: first.services });
  project.cf.events.length = 0;
  return project;
}

/** Cloudflare renewed `DOMAIN` by a year, as its auto-renew does. */
function renewAtCloudflare(project: DomainProject): void {
  const current = project.cf.domains.get(DOMAIN);
  if (current === undefined) throw new Error("not bought");
  project.cf.domains.set(DOMAIN, { ...current, expiresAt: "2028-10-11T12:00:05Z" });
}

describe("opscrew domain status: a renewal the registrar charged (FR-3113)", () => {
  it("records the renewal once its date is within 30 days, and moves the expiry on", async () => {
    const project = await boughtProject();
    renewAtCloudflare(project);
    const { deps, services } = await project.run({ now: "2027-09-20T08:00:00.000Z" });

    await domainStatus(deps, { services });

    const plan = await planOf(project);
    expect(plan.cost.oneTime).toEqual([
      // the purchase of 2026-10 is pruned by now
      {
        item: "example.com, renewal (1 year)",
        provider: "cloudflare",
        price: eur(11.36),
        // seen before its date: charged by now
        at: "2027-09-20T08:00:00.000Z",
      },
    ]);
    expect(plan.cost.renewals).toEqual([
      expect.objectContaining({ next: "2028-10-11T12:00:05.000Z", autoRenew: true }),
    ]);
    expect(plan.dns.registration?.expiresAt).toBe("2028-10-11T12:00:05.000Z");
    expect(deps.reporter.text()).toContain(
      "example.com was renewed at Cloudflare until 2028-10-11: OpsCrew recorded the renewal ($12.50) in opscrew/plan.yaml.",
    );

    // the next run finds nothing new
    const again = await project.run({ now: "2027-09-21T08:00:00.000Z" });
    await domainStatus(again.deps, { services: again.services });
    expect((await planOf(project)).cost.oneTime).toHaveLength(1);
  });

  it("records it with `--account` when the token can use several accounts", async () => {
    const project = await boughtProject();
    renewAtCloudflare(project);
    project.cf.accounts = [
      { id: "acc-1", name: "Shop" },
      { id: "acc-2", name: "Other" },
    ];
    const { deps, services } = await project.run({ now: "2027-09-20T08:00:00.000Z" });

    await domainStatus(deps, { account: "acc-1", services });

    expect((await planOf(project)).cost.renewals?.[0]?.next).toBe("2028-10-11T12:00:05.000Z");
  });

  it("records a renewal Porkbun charged once", async () => {
    const base = domainTestPlan({ domain: DOMAIN });
    const next = "2027-10-11T12:00:05.000Z";
    const project = await domainProject({
      plan: {
        ...base,
        dns: {
          ...base.dns,
          zone: DOMAIN,
          registration: {
            registrar: "porkbun",
            expiresAt: next,
            autoRenew: true,
            privacy: true,
            dnssec: true,
          },
        },
        cost: {
          ...base.cost,
          renewals: [
            { item: DOMAIN, provider: "porkbun", price: usd(12.5), next, autoRenew: true },
          ],
        },
      },
    });
    project.other("porkbun").own(DOMAIN, { expiresAt: "2028-10-11T12:00:05Z", autoRenew: true });
    const now = "2027-10-01T08:00:00.000Z";

    for (const _run of [1, 2]) {
      const { deps, services } = await project.run({ now });
      await domainStatus(deps, { registrar: "porkbun", services });
    }

    const plan = await planOf(project);
    expect(plan.cost.oneTime).toEqual([
      { item: "example.com, renewal (1 year)", provider: "porkbun", price: eur(11.36), at: now },
    ]);
    expect(plan.cost.renewals?.[0]?.next).toBe("2028-10-11T12:00:05.000Z");
    expect(plan.dns.registration?.expiresAt).toBe("2028-10-11T12:00:05.000Z");
  });

  it("changes nothing in the plan before the 30 days", async () => {
    const project = await boughtProject();
    renewAtCloudflare(project);
    const before = await planOf(project);
    const { deps, services } = await project.run({ now: "2027-09-01T08:00:00.000Z" });

    await domainStatus(deps, { services });

    expect(await planOf(project)).toEqual(before);
  });
});

describe("opscrew domain auto-renew: the renewal follows it", () => {
  it("records auto-renew off in the cost's renewal too", async () => {
    const project = await boughtProject();
    const { deps, services } = await project.run();

    await setDomainAutoRenew(deps, { on: false, services });

    const plan = await planOf(project);
    expect(plan.dns.registration?.autoRenew).toBe(false);
    expect(plan.cost.renewals).toEqual([expect.objectContaining({ autoRenew: false })]);
  });
});

it("leaves an old plan without renewals as it is when domain status runs", async () => {
  const project = await domainProject();
  project.cf.own(DOMAIN);
  const { deps, services } = await project.run();
  const plan = domainTestPlan({ domain: DOMAIN });
  await writeArtifact("plan", deps.paths.files.plan, {
    ...plan,
    dns: {
      ...plan.dns,
      zone: DOMAIN,
      registration: { registrar: "cloudflare", autoRenew: true, privacy: true, dnssec: false },
    },
  });
  const before = await readArtifact("plan", deps.paths.files.plan);

  await domainStatus(deps, { services });

  expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(before);
});
