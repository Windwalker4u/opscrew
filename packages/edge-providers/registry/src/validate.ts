import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { isRecord, OpsCrewError, zodIssues } from "@opscrew/core";
import { z } from "zod";

type Definition = EdgeProviderDefinition;

const capabilities = z.object({
  originAuth: z.enum(["cloudflare-aop", "mtls-client-cert", "shared-header"]),
  originIpFiltering: z.enum(["compact-cidrs", "dynamic-ips"]),
  realIpHeader: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/, "must be a valid HTTP header name such as CF-Connecting-IP"),
});

const terraform = z.object({
  dnsRecordResourceType: z.string().min(1).optional(),
});

const texts = z.object({
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
  });

/**
 * Checks an edge provider definition against the contract (ADR 0038) and returns it unchanged.
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
