import type { Money } from "@opscrew/contracts";
import { z } from "zod";
import { PlanServiceSchema } from "./components";
import { DeployProviderSchema, IsoDateTimeSchema, MoneySchema, ServiceKindSchema } from "./enums";

/** Allowed difference between the breakdown sum and the monthly total (rounding to cents). */
const SUM_TOLERANCE = 0.01 + 1e-9;

/**
 * How an item is billed: `hourly`, each started hour up to its monthly cap (Hetzner, DigitalOcean);
 * `monthly`, the full monthly price at each term's start (Contabo); `free`, nothing (a second app on
 * a server another app pays for).
 */
export const BillingSchema = z.enum(["hourly", "monthly", "free"]);
export type Billing = z.infer<typeof BillingSchema>;

/**
 * The provider that bills an item, by OpsCrew's id for it (`hetzner`, `digitalocean`, `contabo`,
 * `cloudflare`, …): after a move, an environment's ended items are the old provider's.
 */
export const CostProviderSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: "must be a provider id in lower case, for example hetzner",
});

/** One running item of a cost estimate. */
export const CostItemSchema = z.strictObject({
  item: z.string().min(1),
  provider: CostProviderSchema.optional(),
  /** The price for a whole month; for an `hourly` item, its monthly cap. */
  monthly: MoneySchema,
  billing: BillingSchema.optional(),
  /** The price of one hour; required when `billing` is `hourly`. */
  hourly: MoneySchema.optional(),
  /** When the item started to be billed. */
  since: IsoDateTimeSchema.optional(),
});
export type CostItem = z.infer<typeof CostItemSchema>;

/** A one-time fee, for example a provider's setup fee. */
export const OneTimeCostSchema = z.strictObject({
  item: z.string().min(1),
  provider: CostProviderSchema.optional(),
  price: MoneySchema,
  /** When it was charged. */
  at: IsoDateTimeSchema,
});
export type OneTimeCost = z.infer<typeof OneTimeCostSchema>;

/** An item that is no longer billed: removed between `since` and `until`. */
export const EndedCostSchema = z.strictObject({
  item: z.string().min(1),
  provider: CostProviderSchema.optional(),
  monthly: MoneySchema,
  billing: BillingSchema,
  /** Required when `billing` is `hourly`. */
  hourly: MoneySchema.optional(),
  since: IsoDateTimeSchema,
  until: IsoDateTimeSchema,
});
export type EndedCost = z.infer<typeof EndedCostSchema>;

/**
 * Monthly cost estimate. The breakdown amounts sum to `monthly.amount` (within 0.01) and every
 * amount uses the same currency as `monthly`. `breakdown` lists the running items; `oneTime` the
 * one-time fees and `ended` the items removed, of the current and the previous calendar month.
 */
export const CostEstimateSchema = z
  .strictObject({
    monthly: MoneySchema,
    breakdown: z.array(CostItemSchema),
    oneTime: z.array(OneTimeCostSchema).optional(),
    ended: z.array(EndedCostSchema).optional(),
    pricesIncludeVat: z.boolean(),
    /** `live` when read from the provider API, `static` for a dated fallback price list. */
    source: z.enum(["live", "static"]),
    asOf: IsoDateTimeSchema,
  })
  .superRefine((cost, ctx) => {
    const currency = cost.monthly.currency;
    const sameCurrency = (money: Money | undefined, path: (string | number)[]) => {
      if (money === undefined || money.currency === currency) return;
      ctx.addIssue({
        code: "custom",
        path: [...path, "currency"],
        message: `must be ${currency}, the currency of the monthly total`,
      });
    };
    const hourlyWhenBilledHourly = (
      line: { billing?: Billing; hourly?: Money },
      path: (string | number)[],
    ) => {
      if (line.billing === "hourly" && line.hourly === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "hourly"],
          message: "is required when billing is hourly",
        });
      }
    };
    let sum = 0;
    cost.breakdown.forEach((line, i) => {
      sum += line.monthly.amount;
      sameCurrency(line.monthly, ["breakdown", i, "monthly"]);
      sameCurrency(line.hourly, ["breakdown", i, "hourly"]);
      hourlyWhenBilledHourly(line, ["breakdown", i]);
    });
    cost.oneTime?.forEach((fee, i) => {
      sameCurrency(fee.price, ["oneTime", i, "price"]);
    });
    cost.ended?.forEach((line, i) => {
      sameCurrency(line.monthly, ["ended", i, "monthly"]);
      sameCurrency(line.hourly, ["ended", i, "hourly"]);
      hourlyWhenBilledHourly(line, ["ended", i]);
      if (Date.parse(line.until) < Date.parse(line.since)) {
        ctx.addIssue({
          code: "custom",
          path: ["ended", i, "until"],
          message: "must not be before since",
        });
      }
    });
    if (Math.abs(sum - cost.monthly.amount) > SUM_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["monthly", "amount"],
        message: `must equal the sum of the breakdown (${(Math.round(sum * 100) / 100).toFixed(2)})`,
      });
    }
  });
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/** One deployment option offered by the Architect (not persisted). */
export const DesignOptionSchema = z.strictObject({
  /** For example `hetzner-single-cpx22-nbg1` or `digitalocean-single-s-2vcpu-4gb-fra1`. */
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  target: z.strictObject({
    provider: DeployProviderSchema,
    location: z.string().min(1),
    serverType: z.string().min(1),
    vcpus: z.int().positive(),
    memoryGb: z.number().positive(),
    diskGb: z.number().positive(),
    cpuType: z.enum(["shared", "dedicated"]),
    architecture: z.enum(["x86", "arm"]),
  }),
  /** The services that run as containers next to the app, as the plan lists them. */
  services: z.array(PlanServiceSchema),
  externalServices: z.array(ServiceKindSchema),
  backups: z.boolean(),
  cost: CostEstimateSchema,
  fitsBudget: z.boolean(),
  recommended: z.boolean(),
  tradeoffs: z.array(z.string().min(1)),
});
export type DesignOption = z.infer<typeof DesignOptionSchema>;

/** A list of design options: at least one, unique ids, exactly one recommended. */
export const DesignOptionListSchema = z
  .array(DesignOptionSchema)
  .min(1)
  .superRefine((options, ctx) => {
    const ids = new Set<string>();
    options.forEach((option, i) => {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `duplicate option id "${option.id}"`,
        });
      }
      ids.add(option.id);
    });
    const recommended = options.filter((o) => o.recommended).length;
    if (recommended !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `exactly one option must be recommended (found ${recommended})`,
      });
    }
  });
