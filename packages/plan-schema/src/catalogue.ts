/**
 * The providers' facts as a catalogue (`opscrew providers --json`): the cloud server providers,
 * Cloudflare and the domain registrars OpsCrew works with, what each one's credentials are and
 * how they are created, the cloud servers' sizes and prices from OpsCrew's dated built-in price
 * lists, and what design picks for a small app. For tools, such as a guided start; OpsCrew itself
 * never reads it back.
 */
import { z } from "zod";
import {
  CurrencySchema,
  EnvVarNameSchema,
  IsoDateTimeSchema,
  MoneySchema,
  RegionSchema,
  RegistrarSchema,
  ServerlessProviderSchema,
} from "./enums";

/** An `https://` URL. */
const HttpsUrlSchema = z.url({ protocol: /^https$/, error: "must be an https:// URL" });

/**
 * A provider's sign-up page: an `https://` URL with no query string or fragment, so never one with
 * a referral or affiliate id.
 */
export const SignupUrlSchema = HttpsUrlSchema.refine((url) => {
  const { search, hash } = new URL(url);
  return search === "" && hash === "";
}, "must have no query string or fragment: a plain sign-up page, never one with a referral or affiliate id");

/** Where a price comes from: OpsCrew's dated built-in price list, never one read live. */
const PriceSourceSchema = z.strictObject({
  kind: z.literal("static"),
  /** The day the list was read. */
  asOf: IsoDateTimeSchema,
});

/** One environment variable of a provider's credentials. */
const CredentialVariableSchema = z.strictObject({
  name: EnvVarNameSchema,
  label: z.string().min(1),
  /** True when OpsCrew treats its value as a secret (masked in every message, never stored). */
  secret: z.boolean(),
  /**
   * The format `opscrew scan` recognises the value by, as a regular expression's source (it means
   * the same without flags); absent when the value has no format OpsCrew knows.
   */
  pattern: z.string().min(1).optional(),
});

/** A provider's credentials and how to create them. */
const CatalogueCredentialsSchema = z.strictObject({
  /** `any`: the first of `variables` that is set is the token; `all`: every one is needed. */
  mode: z.enum(["any", "all"]),
  variables: z.array(CredentialVariableSchema).min(1),
  /** Where the user creates them. */
  createUrl: HttpsUrlSchema,
  /** How to create them, in the words `opscrew init` uses. */
  steps: z.array(z.string().min(1)).min(1),
});

/** What every provider of the catalogue has. */
const entry = {
  /** Its id in plans and commands; unique together with `kind`. */
  id: z.string().min(1),
  name: z.string().min(1),
  consoleUrl: HttpsUrlSchema,
  signupUrl: SignupUrlSchema.optional(),
  pricingUrl: HttpsUrlSchema.optional(),
  currency: CurrencySchema.optional(),
  credentials: CatalogueCredentialsSchema,
  /** OpsCrew's guide page about it. */
  guideUrl: HttpsUrlSchema,
};

/** A cloud server provider: where OpsCrew creates the app's server. */
const CloudServerEntrySchema = z.strictObject({
  kind: z.literal("cloud-server"),
  ...entry,
  /** The currency of its prices, which exclude VAT or sales tax. */
  currency: CurrencySchema,
  /**
   * How it bills a server: by the hour up to the monthly price, counted by each started hour or
   * by the second, or the full monthly price at the start of each term; `setupFee` when creating
   * a server can charge a one-time fee.
   */
  billing: z.discriminatedUnion("model", [
    z.strictObject({
      model: z.literal("hourly"),
      counts: z.enum(["started-hour", "second"]),
      setupFee: z.boolean(),
    }),
    z.strictObject({ model: z.literal("monthly"), setupFee: z.boolean() }),
  ]),
  /** The locations OpsCrew offers, each in the region of OpsCrew's it serves. */
  locations: z
    .array(z.strictObject({ id: z.string().min(1), name: z.string().min(1), region: RegionSchema }))
    .min(1),
  /** The sizes design can choose, each at one price in the `locations` that price holds in. */
  sizes: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        vcpu: z.number().int().positive(),
        memoryMb: z.number().int().positive(),
        diskGb: z.number().positive(),
        /** The price of a month, in `currency`; for hourly billing, the monthly cap. */
        monthly: z.number().nonnegative(),
        /** The price of an hour, for hourly billing. */
        hourly: z.number().nonnegative().optional(),
        /** A one-time fee creating a server of this size can charge (`billing.setupFee`). */
        setupFee: MoneySchema.optional(),
        locations: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  /** Where the sizes' prices come from. */
  priceSource: PriceSourceSchema,
});

/** Cloudflare: the app's DNS, its HTTPS rules, and Cloudflare's hosting for a site. */
const CloudflareEntrySchema = z.strictObject({ kind: z.literal("cloudflare"), ...entry });

/** A registrar OpsCrew buys domains through. */
const RegistrarEntrySchema = z.strictObject({
  kind: z.literal("registrar"),
  ...entry,
  id: RegistrarSchema,
});

/** What design picks for a small app. */
const SuggestionsSchema = z.strictObject({
  /**
   * Per cloud server provider, the size design recommends for a small web app with PostgreSQL, in
   * the location it picks for central Europe; its price is the size's in `sizes`.
   */
  serverWithDatabase: z.array(
    z.strictObject({
      provider: z.string().min(1),
      size: z.string().min(1),
      location: z.string().min(1),
    }),
  ),
  /** Where design sends a static site, and what it costs there. */
  staticSite: z.strictObject({
    target: ServerlessProviderSchema,
    /** The catalogue provider whose credentials it needs. */
    provider: z.string().min(1),
    monthly: MoneySchema,
    priceSource: PriceSourceSchema,
  }),
});

/** The catalogue `opscrew providers --json` prints. */
export const ProviderCatalogueSchema = z.strictObject({
  catalogueVersion: z.literal(1),
  /** The OpsCrew version that printed it: the same version always prints the same catalogue. */
  opscrewVersion: z.string().min(1),
  providers: z
    .array(
      z.discriminatedUnion("kind", [
        CloudServerEntrySchema,
        CloudflareEntrySchema,
        RegistrarEntrySchema,
      ]),
    )
    .min(1),
  suggestions: SuggestionsSchema,
});
export type ProviderCatalogue = z.infer<typeof ProviderCatalogueSchema>;
export type CatalogueProvider = ProviderCatalogue["providers"][number];
