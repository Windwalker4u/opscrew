import { GIT_PLATFORM_CONTRACT_VERSION, type GitPlatformDefinition } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";

const TokenRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  pattern: z.instanceof(RegExp),
  group: z.number().int().positive().optional(),
  description: z.string().min(1),
});

const DefinitionSchema = z.object({
  contractVersion: z.literal(GIT_PLATFORM_CONTRACT_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string().min(1),
  credentials: z.object({
    envVars: z.array(z.string().min(1)).min(1),
    tokenRules: z.array(TokenRuleSchema),
  }),
  texts: z.object({
    remoteFixHint: z.string().min(1),
  }),
  parseRemote: z.custom<GitPlatformDefinition["parseRemote"]>((v) => typeof v === "function"),
});

/** Validates a git platform definition at registry load time (ADR 0039 D3). */
export function validateGitPlatform(definition: GitPlatformDefinition): GitPlatformDefinition {
  const parsed = DefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INTERNAL",
      `Invalid git platform definition "${String((definition as { id?: unknown })?.id ?? "unknown")}": ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  for (const rule of definition.credentials.tokenRules) {
    if (!rule.pattern.flags.includes("g")) {
      throw new OpsCrewError(
        "INTERNAL",
        `Git platform "${definition.id}" token rule "${rule.id}" must use the /g flag.`,
      );
    }
  }
  return definition;
}
