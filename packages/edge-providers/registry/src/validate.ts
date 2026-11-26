import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { isRecord, OpsCrewError, zodIssues } from "@opscrew/core";
import { PlainUrlSchema } from "@opscrew/plan-schema";
import { z } from "zod";

function fn<T>() {
  return z.custom<T>((value) => typeof value === "function", "must be a function");
}

type Definition = EdgeProviderDefinition;
const regex = z.instanceof(RegExp);
const lines = z.array(z.string());

const tokenRule = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  pattern: regex.refine((pattern) => pattern.global, "must be a global regular expression"),
  group: z.number().int().optional(),
  description: z.string().min(1),
});

const credentials = z
  .object({
    envVars: z.array(z.string().min(1)).min(1, "names no environment variable"),
    labels: z.record(z.string(), z.string().min(1)),
    mode: z.enum(["any", "all"]),
    createUrl: PlainUrlSchema,
    tokenRules: z.array(tokenRule),
    envPrefixes: lines,
    apiPattern: regex,
  })
  .superRefine((value, ctx) => {
    for (const name of value.envVars) {
      if (value.labels[name] === undefined) {
        ctx.addIssue({ code: "custom", path: ["labels"], message: `has no label for ${name}` });
      }
    }
  });

const capabilities = z.object({
  dns: z.boolean(),
  edge: z.boolean(),
  apexCnameFlattening: z.boolean(),
  originAuth: z.enum(["cloudflare-aop", "mtls-client-cert", "shared-header"]),
  originIpFiltering: z.enum(["compact-cidrs", "dynamic-ips"]),
  realIpHeader: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/, "must be a valid HTTP header name such as CF-Connecting-IP"),
  cloudflareOnlyFeatures: z.boolean(),
});

const terraform = z.object({
  provider: z.object({
    name: z.string().min(1),
    source: z.string().min(1),
    version: z.string().min(1),
  }),
  credentialsComment: z.string().min(1),
  dnsModuleName: z.string().min(1).optional(),
  edgeModuleName: z.string().min(1).optional(),
  dnsRecordResourceType: z.string().min(1).optional(),
  mirroredAttributes: z.record(z.string(), lines),
});

const pricing = z.object({
  freeTier: z.string().min(1),
  summary: z.string().min(1),
});

const texts = z.object({
  interview: z.object({
    label: z.string().min(1),
    hint: z.string().min(1),
  }),
  design: z.object({
    cloudflareOnlyNote: z.string().min(1).optional(),
    originProtectionNote: z.string().min(1),
  }),
  runbook: z.object({
    console: z.string().min(1),
  }),
  secops: z.object({
    edgeLabel: z.string().min(1),
    edgeTlsHint: z.string().min(1),
  }),
});

const definitionSchema: z.ZodType<Definition> = z
  .object({
    contractVersion: z.literal(EDGE_PROVIDER_CONTRACT_VERSION, {
      error: `must be ${EDGE_PROVIDER_CONTRACT_VERSION}, the edge contract version this OpsCrew reads`,
    }),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lower-case identifier"),
    displayName: z.string().min(1),
    name: z.string().min(1),
    consoleUrl: PlainUrlSchema,
    signupUrl: PlainUrlSchema,
    pricingUrl: PlainUrlSchema,
    capabilities,
    credentials,
    connector: fn<Definition["connector"]>(),
    terraform,
    pricing,
    texts,
  })
  .superRefine((definition, ctx) => {
    if (!definition.capabilities.dns && !definition.capabilities.edge) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "must provide at least one of dns or edge",
      });
    }
    if (!definition.capabilities.dns && definition.terraform.dnsModuleName !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["terraform", "dnsModuleName"],
        message: "must be omitted when capabilities.dns is false",
      });
    }
    if (definition.capabilities.dns && definition.terraform.dnsRecordResourceType === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["terraform", "dnsRecordResourceType"],
        message: "is required when capabilities.dns is true",
      });
    }
    if (definition.capabilities.cloudflareOnlyFeatures && definition.id !== "cloudflare") {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "cloudflareOnlyFeatures"],
        message: 'may be true only on the "cloudflare" definition',
      });
    }
    if (
      definition.capabilities.originIpFiltering === "dynamic-ips" &&
      definition.capabilities.originAuth !== "shared-header"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "originAuth"],
        message: 'must be "shared-header" when originIpFiltering is "dynamic-ips"',
      });
    }
  });

/**
 * Checks an edge/DNS provider definition against the contract (ADR 0038) and returns it unchanged.
 * Throws an `INTERNAL` error naming the provider's id and the parts that fail.
 */
export function validateEdgeProvider(candidate: unknown): EdgeProviderDefinition {
  const parsed = definitionSchema.safeParse(candidate);
  if (parsed.success) return candidate as EdgeProviderDefinition;
  const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : undefined;
  const which =
    id === undefined
      ? "An edge provider definition without an id"
      : `The edge provider definition "${id}"`;
  throw new OpsCrewError("INTERNAL", `${which} is not valid: ${zodIssues(parsed.error)}.`, {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}
