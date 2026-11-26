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
  cicdProvider: z.string().regex(/^[a-z][a-z0-9-]*$/),
  registryId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  defaultHost: z.string().min(1),
  defaultRegistryHost: z.string().min(1),
  credentials: z.object({
    envVars: z.array(z.string().min(1)).min(1),
    labels: z.record(z.string(), z.string().min(1)),
    cliCommand: z.string().min(1).optional(),
    createUrl: z.url(),
    scopes: z.array(z.string().min(1)).min(1),
    tokenRules: z.array(TokenRuleSchema),
  }),
  capabilities: z.object({
    environments: z.boolean(),
    protectedEnvironments: z.boolean(),
    mergeRequestPreviews: z.boolean(),
    containerRegistry: z.boolean(),
    selfHostedRunners: z.boolean(),
    staticSitePages: z.boolean(),
    selfManagedHosts: z.boolean(),
  }),
  texts: z.object({
    changeRequestNoun: z.string().min(1),
    pipelineNoun: z.string().min(1),
    defaultWorkflowPath: z.string().min(1),
    remoteFixHint: z.string().min(1),
    tokenFixHint: z.string().min(1),
    secopsDocsUrl: z.url(),
  }),
  parseRemote: z.custom<GitPlatformDefinition["parseRemote"]>((v) => typeof v === "function"),
  containerImage: z.custom<GitPlatformDefinition["containerImage"]>((v) => typeof v === "function"),
  resolveToken: z.custom<GitPlatformDefinition["resolveToken"]>((v) => typeof v === "function"),
  createConnector: z.custom<GitPlatformDefinition["createConnector"]>(
    (v) => typeof v === "function",
  ),
});

/** Validates a git platform definition at registry load time (ADR 0029 D3). */
export function validateGitPlatform(definition: GitPlatformDefinition): GitPlatformDefinition {
  const parsed = DefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INTERNAL",
      `Invalid git platform definition "${String((definition as { id?: unknown })?.id ?? "unknown")}": ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  for (const envVar of definition.credentials.envVars) {
    if (!definition.credentials.labels[envVar]) {
      throw new OpsCrewError(
        "INTERNAL",
        `Git platform "${definition.id}" is missing a credentials label for ${envVar}.`,
      );
    }
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
