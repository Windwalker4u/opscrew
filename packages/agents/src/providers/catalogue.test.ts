import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CloudProviderDefinition } from "@opscrew/contracts";
import { FAKE_SECRET_KINDS, fakeSecret } from "@opscrew/core/testing";
import { ProviderCatalogueSchema } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCatalogue } from "./catalogue";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GUIDE = fileURLToPath(new URL("../../../../docs/guide/", import.meta.url));

describe("the provider catalogue", () => {
  it("parses with its schema and is the same every time", async () => {
    const catalogue = await providerCatalogue("1.2.3");
    expect(ProviderCatalogueSchema.parse(catalogue)).toEqual(catalogue);
    expect(catalogue).toMatchObject({ catalogueVersion: 1, opscrewVersion: "1.2.3" });
    expect(await providerCatalogue("1.2.3")).toEqual(catalogue);
  });

  it("reads no credential: secrets in the environment never reach it", async () => {
    const secrets = FAKE_SECRET_KINDS.map((kind) => fakeSecret(kind));
    const names = [
      ...CLOUD_PROVIDERS.flatMap(({ credentials }) => credentials.envVars),
      "CLOUDFLARE_API_TOKEN",
      "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
      "PORKBUN_API_KEY",
      "PORKBUN_SECRET_API_KEY",
      "NAMECHEAP_API_USER",
      "NAMECHEAP_API_KEY",
      "GODADDY_API_TOKEN",
    ];
    names.forEach((name, i) => {
      vi.stubEnv(name, secrets[i % secrets.length] as string);
    });
    const text = JSON.stringify(await providerCatalogue("1.2.3"));
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it("calls no network", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("no network in this test")));
    vi.stubGlobal("fetch", fetch);
    await providerCatalogue("1.2.3");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has every cloud server provider of the registry, from its definition and price list", async () => {
    const { providers, suggestions } = await providerCatalogue("1.2.3");
    const clouds = providers.filter((provider) => provider.kind === "cloud-server");
    expect(clouds.map((provider) => provider.id)).toEqual(CLOUD_PROVIDERS.map(({ id }) => id));
    for (const definition of CLOUD_PROVIDERS) {
      const entry = clouds.find((provider) => provider.id === definition.id);
      expect(entry).toMatchObject({
        name: definition.displayName,
        consoleUrl: definition.consoleUrl,
        signupUrl: definition.signupUrl,
        pricingUrl: definition.pricingUrl,
        currency: definition.offering.currency,
        billing: definition.offering.billing,
        priceSource: { kind: "static" },
        credentials: {
          mode: definition.credentials.mode,
          createUrl: definition.credentials.createUrl,
        },
      });
      expect(entry?.credentials.variables.map((variable) => variable.name)).toEqual(
        definition.credentials.envVars,
      );
      // The words `opscrew init` gives when the credentials are missing.
      expect(entry?.credentials.steps.join(" ")).toBe(
        `${definition.texts.init.fix}${definition.texts.init.scopeNote}`,
      );
      // Design's recommended size is one the catalogue lists, where it lists it.
      const suggested = suggestions.serverWithDatabase.find((s) => s.provider === definition.id);
      expect(
        entry?.sizes.some(
          (size) =>
            size.id === suggested?.size && size.locations.includes(suggested?.location ?? ""),
        ),
        definition.id,
      ).toBe(true);
    }
  });

  it("gives each size's price where it holds and design's choice for a small app", async () => {
    const { providers, suggestions } = await providerCatalogue("1.2.3");
    const hetzner = providers.find((provider) => provider.id === "hetzner");
    if (hetzner?.kind !== "cloud-server") throw new Error("no Hetzner entry");
    // Hetzner prices a type per location group: one size per price.
    expect(hetzner.sizes.filter((size) => size.id === "cpx02")).toEqual([
      expect.objectContaining({ monthly: 5.99, locations: ["fsn1", "nbg1", "hel1"] }),
      expect.objectContaining({ monthly: 7.49, locations: ["sin"] }),
    ]);
    // Never an ARM type: design picks x86 only.
    expect(hetzner.sizes.some((size) => size.id.startsWith("cax"))).toBe(false);
    expect(hetzner.locations).toContainEqual({ id: "hel1", name: "Helsinki", region: "eu-north" });
    expect(suggestions.serverWithDatabase).toEqual([
      { provider: "hetzner", size: "cx33", location: "nbg1" },
      { provider: "digitalocean", size: "s-2vcpu-4gb", location: "fra1" },
      { provider: "contabo", size: "V153", location: "EU" },
    ]);
    expect(suggestions.staticSite).toMatchObject({
      target: "cloudflare-workers",
      provider: "cloudflare",
      monthly: { amount: 0, currency: "USD" },
      priceSource: { kind: "static" },
    });
  });

  it("gives a size's setup fee where creating the server charges one", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    const sizes = (id: string) => {
      const provider = providers.find((entry) => entry.id === id);
      return provider?.kind === "cloud-server" ? provider.sizes : [];
    };
    const v153 = sizes("contabo").find((size) => size.id === "V153");
    expect(v153?.setupFee).toEqual({ amount: 2, currency: "EUR" });
    expect(sizes("contabo").find((size) => size.id === "V154")?.setupFee).toBeUndefined();
    const cx23 = sizes("hetzner").find((size) => size.id === "cx23");
    expect(cx23).toBeDefined();
    expect(cx23?.setupFee).toBeUndefined();
  });

  it("gives a token's format where the value alone has one, and marks the secrets", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    const variables = Object.fromEntries(
      providers.flatMap((provider) =>
        provider.credentials.variables.map((variable) => [variable.name, variable]),
      ),
    );
    expect(variables.DIGITALOCEAN_TOKEN?.pattern).toBeDefined();
    const pattern = new RegExp(`^${variables.DIGITALOCEAN_TOKEN?.pattern}$`);
    expect(pattern.test(`dop_v1_${"a".repeat(64)}`)).toBe(true);
    // Hetzner's rule finds the token after its variable's name only: it says nothing of the value.
    expect(variables.HCLOUD_TOKEN).toEqual({
      name: "HCLOUD_TOKEN",
      label: "Hetzner Cloud API token",
      secret: true,
    });
    expect(variables.CNTB_OAUTH2_USER).toMatchObject({ secret: false });
    expect(variables.CNTB_OAUTH2_PASS).toMatchObject({ secret: true });
    expect(variables.NAMECHEAP_API_USER).toMatchObject({ secret: false });
  });

  it("has Cloudflare's token and the registrars, with init's words for each", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    expect(
      providers
        .filter((provider) => provider.kind !== "cloud-server")
        .map(({ kind, id }) => `${kind} ${id}`),
    ).toEqual([
      "cloudflare cloudflare",
      "cloudflare cloudflare-workers",
      "registrar cloudflare",
      "registrar porkbun",
      "registrar namecheap",
      "registrar godaddy",
    ]);
    const cloudflare = providers.find(
      ({ kind, id }) => kind === "cloudflare" && id === "cloudflare",
    );
    expect(cloudflare?.credentials.variables.map((variable) => variable.name)).toEqual([
      "CLOUDFLARE_API_TOKEN",
    ]);
    const steps = cloudflare?.credentials.steps.join(" ") ?? "";
    for (const permission of ["Zone → DNS → Edit", "Zone → Config Rules → Edit", "Workers"]) {
      expect(steps).toContain(permission);
    }
    const porkbun = providers.find((provider) => provider.id === "porkbun");
    expect(porkbun?.credentials).toMatchObject({
      mode: "all",
      createUrl: "https://porkbun.com/account/api",
      steps: [
        "Create API credentials at https://porkbun.com/account/api and set PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY.",
      ],
    });
  });

  it("has Cloudflare's hosting, which needs both tokens, with init's words for each", async () => {
    const { providers, suggestions } = await providerCatalogue("1.2.3");
    const hosting = providers.find(
      ({ kind, id }) => kind === "cloudflare" && id === "cloudflare-workers",
    );
    expect(hosting).toMatchObject({
      name: "Cloudflare hosting",
      consoleUrl: "https://dash.cloudflare.com/",
      signupUrl: "https://dash.cloudflare.com/sign-up",
      pricingUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
      guideUrl: "https://docs.opscrew.dev/cloudflare-hosting/",
      credentials: {
        mode: "all",
        variables: [
          { name: "CLOUDFLARE_API_TOKEN", label: "Cloudflare api token", secret: true },
          {
            name: "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN",
            label: "Cloudflare deploy token",
            secret: true,
          },
        ],
        createUrl: "https://dash.cloudflare.com/profile/api-tokens",
      },
    });
    const [token, hostingPermissions, deployToken] = hosting?.credentials.steps ?? [];
    expect(token).toContain("Zone → DNS → Edit");
    expect(hostingPermissions).toContain("Account → Workers Scripts → Edit");
    expect(deployToken).toBe(
      "Create a second token at https://dash.cloudflare.com/profile/api-tokens with only Account → Workers Scripts → Edit for your domain's account, and set OPSCREW_CLOUDFLARE_DEPLOY_TOKEN to it: `opscrew provision` stores it as a GitHub secret for the deploy workflow, which uploads each version with it.",
    );
    // Design's static site goes there.
    expect(suggestions.staticSite.target).toBe(hosting?.id);
  });

  it("links each provider's plain pricing page", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    for (const provider of providers) {
      const url = new URL(provider.pricingUrl);
      expect(url.protocol, provider.id).toBe("https:");
      expect(url.search, provider.id).toBe("");
      expect(url.hash, provider.id).toBe("");
    }
    const pricing = Object.fromEntries(providers.map((p) => [`${p.kind} ${p.id}`, p.pricingUrl]));
    expect(pricing).toEqual({
      "cloud-server hetzner": "https://www.hetzner.com/cloud",
      "cloud-server digitalocean": "https://www.digitalocean.com/pricing",
      "cloud-server contabo": "https://contabo.com/en/vps/",
      "cloudflare cloudflare": "https://www.cloudflare.com/plans/",
      "cloudflare cloudflare-workers":
        "https://developers.cloudflare.com/workers/platform/pricing/",
      "registrar cloudflare": "https://www.cloudflare.com/domains/",
      "registrar porkbun": "https://porkbun.com/products/domains",
      "registrar namecheap": "https://www.namecheap.com/domains/",
      "registrar godaddy": "https://developer.godaddy.com/en/docs/api-users/domains/pricing",
    });
  });

  it("links plain sign-up pages, never one with a referral or affiliate id", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    for (const provider of providers) {
      const url = new URL(provider.signupUrl ?? "");
      expect(url.protocol, provider.id).toBe("https:");
      expect(url.search, provider.id).toBe("");
      expect(url.hash, provider.id).toBe("");
      expect(provider.signupUrl, provider.id).not.toMatch(/ref|aff|partner|utm_/i);
    }
  });

  it("links each provider's guide page", async () => {
    const { providers } = await providerCatalogue("1.2.3");
    for (const { guideUrl } of providers) {
      const page = /^https:\/\/docs\.opscrew\.dev\/([a-z0-9-]+)\/$/.exec(guideUrl)?.[1];
      expect(existsSync(`${GUIDE}${page}.md`), guideUrl).toBe(true);
    }
  });

  it("lists a provider added to the registry, with no code of its own", async () => {
    const [hetzner] = CLOUD_PROVIDERS as [CloudProviderDefinition];
    const acme: CloudProviderDefinition = {
      ...hetzner,
      id: "acme",
      displayName: "Acme Cloud",
      signupUrl: "https://acme.example/signup",
    };
    const { providers, suggestions } = await providerCatalogue("1.2.3", [...CLOUD_PROVIDERS, acme]);
    const entry = providers.find((provider) => provider.id === "acme");
    expect(entry).toMatchObject({
      kind: "cloud-server",
      name: "Acme Cloud",
      signupUrl: "https://acme.example/signup",
      guideUrl: "https://docs.opscrew.dev/acme/",
      credentials: { variables: [{ name: "HCLOUD_TOKEN", label: "Hetzner Cloud API token" }] },
    });
    expect(entry?.kind === "cloud-server" && entry.sizes.length).toBeGreaterThan(0);
    // No plan can name it yet, so design suggests no size there.
    expect(suggestions.serverWithDatabase.map(({ provider }) => provider)).toEqual(
      CLOUD_PROVIDERS.map(({ id }) => id),
    );
  });
});
