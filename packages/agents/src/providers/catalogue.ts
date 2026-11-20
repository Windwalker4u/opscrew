/**
 * The providers' facts as a catalogue (`opscrew providers --json`): the cloud server providers
 * from their definitions (ADR 0029) and built-in price lists, Cloudflare from its connector, the
 * registrars from the domain connectors, how to create each credential in `opscrew init`'s words,
 * and what design picks for a small app. It reads no network, no credential and no project, so
 * one OpsCrew version always gives the same catalogue.
 */
import {
  CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
  cloudflareConnector,
} from "@opscrew/connector-cloudflare";
import type {
  CloudProviderDefinition,
  ComputeCatalog,
  Currency,
  Money,
  ProviderTokenRule,
  RegistrarId,
} from "@opscrew/contracts";
import { isSecretEnvName } from "@opscrew/core";
import type { SiteDetection } from "@opscrew/detect";
import {
  type CloudProvider,
  type DeployProvider,
  isCloudProvider,
  type ProjectFacts,
  type ProviderCatalogue,
  ProviderCatalogueSchema,
  type Requirements,
} from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { buildDesignOptions } from "../design/options";
import { buildServerlessOption } from "../design/serverless";
import { usableOffer } from "../design/sizing";
import {
  OTHER_REGISTRAR_IDS,
  REGISTRAR_ENV,
  REGISTRAR_NAMES,
  registrarLinks,
} from "../domain/registrars";
import {
  CLOUDFLARE_HOSTING_FIX,
  cloudflareFix,
  REGISTRAR_FIX,
  registrarCredentialsFix,
} from "../init/checks";
import { providerProfile } from "./profiles";

/** OpsCrew's guide page `page` (`docs/guide/<page>.md`). */
function guide(page: string): string {
  return `https://docs.opscrew.dev/${page}/`;
}

/** The Cloudflare dashboard, which the Cloudflare connector names in its texts. */
const CLOUDFLARE_DASHBOARD = "https://dash.cloudflare.com/";

/** Each registrar's plain sign-up page, linked from its home page (Cloudflare's from its own). */
const SIGNUP_PAGES: Readonly<Record<RegistrarId, string>> = {
  cloudflare: "https://dash.cloudflare.com/sign-up",
  porkbun: "https://porkbun.com/account/create",
  namecheap: "https://www.namecheap.com/myaccount/signup/",
  godaddy: "https://sso.godaddy.com/account/create",
};

/** Cloudflare's plans, and the Workers pricing its hosting has. */
const CLOUDFLARE_PRICING = {
  plans: "https://www.cloudflare.com/plans/",
  workers: "https://developers.cloudflare.com/workers/platform/pricing/",
};

/** Each registrar's domain pricing page (GoDaddy's for its v3 API, which OpsCrew buys through). */
const PRICING_PAGES: Readonly<Record<RegistrarId, string>> = {
  cloudflare: "https://www.cloudflare.com/domains/",
  porkbun: "https://porkbun.com/products/domains",
  namecheap: "https://www.namecheap.com/domains/",
  godaddy: "https://developer.godaddy.com/en/docs/api-users/domains/pricing",
};

/** Cloudflare's hosting (`cloudflare-workers`), with its deploy token. */
const CLOUDFLARE_HOSTING = providerProfile("cloudflare-workers");

/**
 * What `opscrew init` says when the deploy token of Cloudflare's hosting is missing, with no domain
 * to name its account.
 */
const DEPLOY_TOKEN_FIX = `Create a second token at ${CLOUDFLARE_TOKEN_PAGE} with only ${CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS.join(", ")} for your domain's account, and set ${CLOUDFLARE_HOSTING.deployTokenVar} to it: \`opscrew provision\` stores it as a GitHub secret for the deploy workflow, which uploads each version with it.`;

/** A small web app that keeps its data in PostgreSQL, as analyze would describe it. */
const WEB_APP_WITH_POSTGRES: ProjectFacts = {
  name: "web-app",
  languages: ["typescript"],
  packageManager: "npm",
  frameworks: [],
  appKind: "fullstack",
  platformExport: { platform: "none", evidence: [] },
  build: {},
  runtimeVersions: {},
  envVars: [],
  services: [{ kind: "postgres", evidence: [] }],
  docker: {},
  monorepo: false,
  appDir: ".",
  git: {},
};

/** A static site whose files are in a folder of their own, as detection would describe it. */
const STATIC_SITE: SiteDetection = {
  dir: ".",
  tool: "none",
  render: "static",
  outputDir: "public",
  spa: false,
  serverNeeds: [],
};

/**
 * Design offers a site Cloudflare's hosting first (free for static files), then GitHub Pages
 * (public repositories, no custom headers).
 */
const STATIC_SITE_TARGET = "cloudflare-workers";

/**
 * The interview's answers for a small app: under 1,000 users a month in central Europe (the
 * interview's default region), standard uptime, data that matters. No budget limits the choice,
 * so design recommends by the app's need alone. Design reads no answer's date for a first design.
 */
function smallApp(provider: DeployProvider, currency: Currency): Requirements {
  return {
    schemaVersion: 1,
    answeredAt: "1970-01-01T00:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: Number.MAX_SAFE_INTEGER, currency },
    provider,
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "none",
    keepExternalServices: {},
  };
}

/**
 * A label for a variable no text names: the provider and the rest of its name, after OpsCrew's own
 * prefix (`CNTB_OAUTH2_USER`, `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`).
 */
function derivedLabel(name: string, provider: string): string {
  const own = name.replace(/^OPSCREW_/, "");
  return `${provider} ${own
    .slice(own.indexOf("_") + 1)
    .toLowerCase()
    .replaceAll("_", " ")}`;
}

/**
 * One credential variable. `rule` is the token format of a provider whose variables all hold the
 * one token: its title labels them, and its pattern is theirs when it matches the token alone,
 * as its source means without flags (no group within a wider match, only the `g` flag).
 */
function variable(name: string, provider: string, rule?: ProviderTokenRule) {
  const alone = rule !== undefined && rule.group === undefined && rule.pattern.flags === "g";
  return {
    name,
    label: rule?.title ?? derivedLabel(name, provider),
    secret: isSecretEnvName(name),
    ...(alone ? { pattern: rule.pattern.source } : {}),
  };
}

/** A size at one price, in the locations that price holds in. */
interface Size {
  id: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  monthly: number;
  hourly?: number;
  setupFee?: Money;
  locations: string[];
}

/** A cloud server provider's entry, read from its definition and its built-in price list. */
async function cloudServer(definition: CloudProviderDefinition, catalog: ComputeCatalog) {
  const { credentials, regions, offering, texts } = definition;
  const offered = [...new Set(Object.values(regions.locations).flat())];
  const offers = (await catalog.listOffers()).filter(
    (offer) => usableOffer(offer) && offered.includes(offer.location),
  );
  // One size per type and price, in the locations that price holds in.
  const sizes = new Map<string, Size>();
  for (const offer of offers) {
    const key = JSON.stringify([
      offer.id,
      offer.monthly.amount,
      offer.hourly?.amount,
      offer.setupFee?.amount,
    ]);
    const size = sizes.get(key);
    if (size !== undefined) size.locations.push(offer.location);
    else {
      sizes.set(key, {
        id: offer.id,
        vcpu: offer.vcpus,
        memoryMb: Math.round(offer.memoryGb * 1024),
        diskGb: offer.diskGb,
        monthly: offer.monthly.amount,
        ...(offer.hourly === undefined ? {} : { hourly: offer.hourly.amount }),
        ...(offer.setupFee === undefined ? {} : { setupFee: offer.setupFee }),
        locations: [offer.location],
      });
    }
  }
  // A location's region: one that maps to it as its own (without a note saying it is outside).
  const regionOf = (location: string) => {
    const mapping = Object.entries(regions.locations).filter(([, list]) => list.includes(location));
    return (mapping.find(([region]) => !Object.hasOwn(regions.notes, region)) ?? mapping[0])?.[0];
  };
  const rule =
    credentials.mode === "any" && credentials.tokenRules.length === 1
      ? credentials.tokenRules[0]
      : undefined;
  const [first] = offers;
  return {
    kind: "cloud-server",
    id: definition.id,
    name: definition.displayName,
    consoleUrl: definition.consoleUrl,
    ...(definition.signupUrl === undefined ? {} : { signupUrl: definition.signupUrl }),
    pricingUrl: definition.pricingUrl,
    currency: offering.currency,
    credentials: {
      mode: credentials.mode,
      variables: credentials.envVars.map((name) => variable(name, definition.displayName, rule)),
      createUrl: credentials.createUrl,
      steps: [texts.init.fix, texts.init.scopeNote.trim()].filter((step) => step !== ""),
    },
    guideUrl: guide(definition.id),
    billing: offering.billing,
    locations: offered.map((id) => ({
      id,
      name: regions.locationNames[id] ?? id,
      region: regionOf(id),
    })),
    sizes: [...sizes.values()],
    // Validated as OpsCrew's dated list: never a price read live.
    priceSource: { kind: first?.source, asOf: first?.asOf },
  };
}

/** The size design recommends on `provider` for a small web app with PostgreSQL. */
async function serverWithDatabase(
  provider: CloudProvider,
  currency: Currency,
  catalog: ComputeCatalog,
) {
  const options = await buildDesignOptions({
    facts: WEB_APP_WITH_POSTGRES,
    requirements: smallApp(provider, currency),
    catalog,
  });
  const recommended = options.find((option) => option.recommended);
  return {
    provider,
    size: recommended?.target.serverType,
    location: recommended?.target.location,
  };
}

/** Where design sends a static site, its price, and the catalogue provider whose token it needs. */
function staticSite() {
  const option = buildServerlessOption({
    choice: { provider: STATIC_SITE_TARGET, site: STATIC_SITE },
    requirements: smallApp(STATIC_SITE_TARGET, "USD"),
    externalServices: [],
  });
  const { cost } = option;
  return {
    target: STATIC_SITE_TARGET,
    provider: cost.breakdown[0]?.provider,
    monthly: cost.monthly,
    priceSource: { kind: cost.source, asOf: cost.asOf },
  };
}

/**
 * Cloudflare: the token OpsCrew asks for, for the app's DNS, its HTTPS rules and its hosting; then
 * Cloudflare's hosting, which needs the deploy token too.
 */
function cloudflare() {
  const connector = cloudflareConnector({
    env: {},
    fetch: () => Promise.reject(new Error("The provider catalogue reads no network.")),
  });
  const { envVars, createUrl } = connector.credentials;
  const name = connector.displayName;
  const shared = {
    kind: "cloudflare",
    name,
    consoleUrl: CLOUDFLARE_DASHBOARD,
    signupUrl: SIGNUP_PAGES.cloudflare,
  };
  const variables = envVars.map((variableName) => variable(variableName, name));
  const steps = [cloudflareFix(), CLOUDFLARE_HOSTING_FIX];
  return [
    {
      ...shared,
      id: connector.id,
      pricingUrl: CLOUDFLARE_PRICING.plans,
      credentials: { mode: "any", variables, createUrl, steps },
      guideUrl: guide("cloudflare"),
    },
    {
      ...shared,
      id: CLOUDFLARE_HOSTING.id,
      // Told apart from the token's entry, which shares Cloudflare's name.
      name: `${name} hosting`,
      pricingUrl: CLOUDFLARE_PRICING.workers,
      credentials: {
        mode: "all",
        variables: [...variables, variable(CLOUDFLARE_HOSTING.deployTokenVar, name)],
        createUrl,
        steps: [...steps, DEPLOY_TOKEN_FIX],
      },
      guideUrl: guide("cloudflare-hosting"),
    },
  ];
}

/** A registrar OpsCrew buys domains through: Cloudflare Registrar's steps add to the token. */
function registrar(id: RegistrarId) {
  const name = REGISTRAR_NAMES[id];
  const other = id === "cloudflare" ? undefined : id;
  return {
    kind: "registrar",
    id,
    name,
    consoleUrl: other === undefined ? CLOUDFLARE_DASHBOARD : registrarLinks(other).domains,
    signupUrl: SIGNUP_PAGES[id],
    pricingUrl: PRICING_PAGES[id],
    credentials: {
      mode: "all",
      variables: REGISTRAR_ENV[id].map((variableName) => variable(variableName, name)),
      createUrl: registrarLinks(id).api,
      steps: [other === undefined ? REGISTRAR_FIX : `${registrarCredentialsFix(other)}.`],
    },
    guideUrl: guide("domains"),
  };
}

/**
 * The catalogue `opscrew providers --json` prints, for OpsCrew `opscrewVersion`, validated with
 * `ProviderCatalogueSchema`. `cloudProviders` are the registry's. A provider no plan can name yet
 * (its id is not among plan-schema's) gets no suggested size: design plans only for those.
 */
export async function providerCatalogue(
  opscrewVersion: string,
  cloudProviders: readonly CloudProviderDefinition[] = CLOUD_PROVIDERS,
): Promise<ProviderCatalogue> {
  const clouds = await Promise.all(
    cloudProviders.map(async (definition) => {
      // Without credentials, a provider's connector answers from its built-in price list.
      const catalog = definition.connector({ env: {} }).catalog();
      return { definition, catalog, entry: await cloudServer(definition, catalog) };
    }),
  );
  return ProviderCatalogueSchema.parse({
    catalogueVersion: 1,
    opscrewVersion,
    providers: [
      ...clouds.map(({ entry }) => entry),
      ...cloudflare(),
      registrar("cloudflare"),
      ...OTHER_REGISTRAR_IDS.map(registrar),
    ],
    suggestions: {
      serverWithDatabase: await Promise.all(
        clouds.flatMap(({ definition: { id, offering }, catalog }) =>
          isCloudProvider(id) ? [serverWithDatabase(id, offering.currency, catalog)] : [],
        ),
      ),
      staticSite: staticSite(),
    },
  });
}
