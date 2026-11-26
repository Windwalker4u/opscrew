import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { isRecord, OpsCrewError, zodIssues } from "@opscrew/core";
import { PlainUrlSchema } from "@opscrew/plan-schema";
import { z } from "zod";

type Definition = EdgeProviderDefinition;

const headerName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, "must be a valid HTTP header name such as CF-Connecting-IP");

const capabilities = z.object({
  dns: z.boolean(),
  originAuth: z.enum(["cloudflare-aop", "mtls-client-cert", "shared-header"]),
  originAuthHeader: headerName.optional(),
  originIpFiltering: z.enum(["compact-cidrs", "dynamic-ips"]),
  realIpHeader: headerName,
});

const credentials = z
  .object({
    envVars: z.array(z.string().min(1)).min(1, "names no environment variable"),
    labels: z.record(z.string(), z.string().min(1)),
    createUrl: PlainUrlSchema,
    envPrefixes: z.array(z.string().min(1)),
  })
  .superRefine((value, ctx) => {
    for (const name of value.envVars) {
      if (value.labels[name] === undefined) {
        ctx.addIssue({ code: "custom", path: ["labels"], message: `has no label for ${name}` });
      }
    }
  });

const terraform = z.object({
  provider: z.object({
    name: z.string().min(1),
    source: z.string().min(1),
    version: z.string().min(1),
  }),
  credentialsComment: z.string().min(1),
  dnsRecordResourceType: z.string().min(1).optional(),
  module: z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a lower-case folder name"),
      files: z.record(z.string().min(1), z.string().min(1)),
    })
    .optional(),
});

const texts = z.object({
  originProtectionNote: z.string().min(1),
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
    capabilities,
    credentials,
    terraform,
    texts,
  })
  .superRefine((definition, ctx) => {
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
    if (
      definition.capabilities.originAuth === "shared-header" &&
      definition.capabilities.originAuthHeader === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "originAuthHeader"],
        message: 'is required when originAuth is "shared-header"',
      });
    }
    if (
      definition.capabilities.originAuth !== "shared-header" &&
      definition.capabilities.originAuthHeader !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities", "originAuthHeader"],
        message: 'must be omitted unless originAuth is "shared-header"',
      });
    }
    if (definition.capabilities.dns && definition.terraform.dnsRecordResourceType === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["terraform", "dnsRecordResourceType"],
        message: "is required when capabilities.dns is true",
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
