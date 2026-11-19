import { canonicalJson, OpsCrewError, sha256Hex, zodIssues } from "@opscrew/core";
import { z } from "zod";
import type { PortainerFacts, PortainerFinding, PortainerStackFacts } from "./facts";
import { findings as finding } from "./findings";
import {
  AppNameSchema,
  DEPLOY_COMPOSE_FILE,
  isDeployBranch,
  isDrillScratchVolume,
  NEXT_STACK_CHANGE_IDS,
  NEXT_STACKS,
  type NextStackChangeId,
  nextStackName,
  OpsCrewNameSchema,
  type OpsCrewNames,
  opscrewNames,
  ROLE_NAMES,
  ROLES,
  type Role,
  stackName,
  VolumeNameSchema,
} from "./names";

/** Version of the stack plan format (`StackPlan.schemaVersion`). */
export const STACK_PLAN_SCHEMA_VERSION = 1;

/**
 * Stack plan changes, in the order a setup applies them (teardown: updater, connector, volumes,
 * app, registry); `tunnel-next-stack` and `tunnel-connector-next-stack` only in the beside
 * stacks' plan ({@link planNextStacks}), `drill-stack` only in a restore drill's (`planDrillStack`).
 */
export const STACK_CHANGE_IDS = [
  "registry",
  "app-stack",
  "updater-stack",
  "tunnel-connector-stack",
  "volumes",
  "tunnel-next-stack",
  "tunnel-connector-next-stack",
  "drill-stack",
] as const;
export type StackChangeId = (typeof STACK_CHANGE_IDS)[number];

// --- Schemas --------------------------------------------------------------------------------------

const EnvKeySchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "must be an environment variable name" });

export const ComposeTextSchema = z
  .string()
  .min(1)
  .max(64 * 1024)
  .refine((text) => !text.includes("\0"), { message: "must not contain NUL bytes" });

/** A connector's Compose file (rendered by `@opscrew/iac-templates`): only `${TUNNEL_TOKEN}`. */
const TunnelComposeSchema = ComposeTextSchema.refine(
  (text) => composeVariables(text).join(",") === "TUNNEL_TOKEN",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation, not a JavaScript template.
  { message: "must use ${TUNNEL_TOKEN} and no other variable" },
);

const LoginNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, {
  message: "must be a user name",
});

const RepositoryUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (text) => {
      try {
        const url = new URL(text);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === ""
        );
      } catch {
        return false;
      }
    },
    { message: "must be an https:// repository URL without a login" },
  );

const PortSchema = z.int().min(1).max(65535);

/**
 * What OpsCrew created in Portainer (`.opscrew/server.json` → `portainer.created`), with the
 * same rules as `server.json`.
 */
export const CreatedRecordSchema = z
  .strictObject({
    stacks: z
      .array(
        z.strictObject({
          id: z.int().positive(),
          name: OpsCrewNameSchema,
          role: z.enum(ROLE_NAMES),
        }),
      )
      .max(3),
    /** The registry entry OpsCrew added (administrator token only). */
    registryId: z.int().positive().optional(),
    /** The app stack's named volumes (deleted only with data deletion). */
    volumes: z.array(VolumeNameSchema).max(64),
  })
  .superRefine((record, ctx) => {
    const seen = { ids: new Set<number>(), names: new Set<string>(), roles: new Set<string>() };
    record.stacks.forEach((stack, i) => {
      if (seen.ids.has(stack.id) || seen.names.has(stack.name) || seen.roles.has(stack.role)) {
        ctx.addIssue({ code: "custom", path: ["stacks", i], message: "lists a stack twice" });
      }
      seen.ids.add(stack.id);
      seen.names.add(stack.name);
      seen.roles.add(stack.role);
    });
  });
export type CreatedRecord = z.infer<typeof CreatedRecordSchema>;

/** A non-secret parameter of a change (names, ids, hashes, env keys, the stack file of a string stack). */
const ParamValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export type StackParamValue = z.infer<typeof ParamValueSchema>;

/** One Portainer change, shown to the user and bound by the plan hash. */
const StackChangeSchema = z.strictObject({
  id: z.enum(STACK_CHANGE_IDS),
  /** Plain English, e.g. "Create the Git stack opscrew-shop from the branch opscrew-deploy". */
  title: z.string().min(1),
  state: z.enum(["in-place", "change", "blocked"]),
  /** Why it is blocked, what is already there, or what to know before applying. */
  reason: z.string().optional(),
  /** Non-secret parameters only; secrets are supplied at apply. */
  params: z.record(z.string(), ParamValueSchema),
});
export type StackChange = z.infer<typeof StackChangeSchema>;

const FindingSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  hint: z.string(),
});

/**
 * The hashed plan approved as `stack-apply` (data-model "Stack plan"); unknown keys are refused
 * so the hash covers everything.
 */
export const StackPlanSchema = z.strictObject({
  schemaVersion: z.literal(STACK_PLAN_SCHEMA_VERSION),
  purpose: z.enum(["setup", "teardown", "drill"]),
  app: AppNameSchema,
  environmentId: z.int().positive(),
  changes: z.array(StackChangeSchema).max(8),
  findings: z.array(FindingSchema),
  /** What OpsCrew had created before this plan; apply returns the record after it. */
  record: CreatedRecordSchema,
  /** Teardown only: whether the recorded volumes are deleted. */
  deleteData: z.boolean().optional(),
  /**
   * SHA-256 over the keyed fingerprints of the values this plan sends (`valueFingerprints`), when
   * the desired stacks gave them; apply recomputes it from the secrets and refuses a mismatch.
   */
  valuesDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type StackPlan = z.infer<typeof StackPlanSchema>;

const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "must be a valueFingerprints() result",
});
const FingerprintsSchema = z.record(EnvKeySchema, FingerprintSchema);

/** `valueFingerprints()` of the values on this computer, per stack, and of the webhook id. */
const DesiredValueFingerprintsSchema = z.strictObject({
  /** The app stack's `Env` (every key in `envKeys`). */
  app: FingerprintsSchema.optional(),
  /** The updater stack's `Env` (every `${VAR}` of its stack file). */
  updater: FingerprintsSchema.optional(),
  /** The connector stack's `Env` (`TUNNEL_TOKEN`). */
  connector: FingerprintsSchema.optional(),
  /** `valueFingerprint(key, "webhook", webhookId)`. */
  webhook: FingerprintSchema.optional(),
  /**
   * `valueFingerprint(key, "repositoryToken", token)`: needed when a change sends the repository
   * token (the app stack created, updated or redeployed from a private repository).
   */
  repositoryToken: FingerprintSchema.optional(),
  /**
   * `valueFingerprint(key, "registryToken", token)`: needed when a change sends the registry
   * token (the registry entry added, or its token replaced).
   */
  registryToken: FingerprintSchema.optional(),
});
export type DesiredValueFingerprints = z.infer<typeof DesiredValueFingerprintsSchema>;

/** What OpsCrew wants in Portainer for one app (see contracts/portainer-adapter.md). */
const DesiredStacksSchema = z
  .strictObject({
    /** OpsCrew stack names derive from it: `opscrew-<app>`, `opscrew-<app>-updater`, … */
    app: AppNameSchema,
    environmentId: z.int().positive(),
    repository: z.strictObject({
      /** `https://` without a login (the token is supplied at apply). */
      url: RepositoryUrlSchema,
      /** The environment's deploy branch (iac-templates' `portainerDeployBranch`). */
      branch: z.string().refine(isDeployBranch, {
        message:
          "must be an OpsCrew deploy branch (opscrew-deploy, or opscrew-deploy-<environment>)",
      }),
      composeFile: z.literal(DEPLOY_COMPOSE_FILE),
      private: z.boolean(),
      /** User name sent with the read-only token (default `x-access-token`). */
      username: LoginNameSchema.optional(),
    }),
    /** The app's variables (values supplied at apply). */
    envKeys: z
      .array(EnvKeySchema)
      .max(500)
      .refine((keys) => new Set(keys).size === keys.length, { message: "lists a variable twice" }),
    /** The image's registry; with `private`, Portainer needs a registry entry to pull it. */
    registry: z
      .strictObject({
        url: z.literal("ghcr.io"),
        private: z.boolean(),
        /**
         * User name of the registry entry's login (default: the entry's name, as Portainer refuses
         * two entries with the same URL and user name; GHCR checks only the token).
         */
        username: LoginNameSchema.optional(),
      })
      .optional(),
    redeploy: z.enum(["updater", "cloudflare"]),
    /** Rendered by `@opscrew/iac-templates`; its `${VARS}` are supplied at apply (`updaterEnv`). */
    updater: z.strictObject({ compose: ComposeTextSchema }).optional(),
    /** Rendered by `@opscrew/iac-templates`; it may only use `${TUNNEL_TOKEN}`. */
    tunnelConnector: z.strictObject({ compose: TunnelComposeSchema }).optional(),
    /** Host ports the app stack publishes (80 and 443 for Caddy, or the proxy port); checked free. */
    ports: z.array(PortSchema).max(16).optional(),
    /** Docker names of the app stack's named volumes (`opscrew-<app>_<volume>`), recorded at apply. */
    volumes: z.array(VolumeNameSchema).max(64).optional(),
    /**
     * The scheduled drills' scratch volumes (`opscrew-<app>_<service>_drill`, empty between runs)
     * the app stack no longer has and no container uses (their schedule was turned off): the plan
     * removes those the record lists, unless Portainer shows one as another project's.
     */
    scratchVolumes: z.array(VolumeNameSchema).max(64).optional(),
    /** What OpsCrew created before (`server.json` → `portainer.created`); absent on the first run. */
    record: CreatedRecordSchema.optional(),
    /**
     * Keyed fingerprints of the local values, so a changed value (or webhook) plans an update
     * naming the keys only, and the plan is bound to them (`valuesDigest`; apply refuses a plan
     * that sends values without it). When given: `app`, `webhook`, and `updater` (updater mode) or
     * `connector` (cloudflare mode). Compare them with a client made with the same `valueKey`.
     */
    valueFingerprints: DesiredValueFingerprintsSchema.optional(),
    /**
     * Tokens to send again (rotation; Portainer never shows them back, so this is explicit):
     * `repository` plans a Git update of the app stack (private repository only), `registry` a
     * token update of the registry entry OpsCrew added (private image, administrator token). Each
     * needs the token's fingerprint in `valueFingerprints`.
     */
    replaceTokens: z
      .strictObject({ repository: z.boolean().optional(), registry: z.boolean().optional() })
      .optional(),
  })
  .refine(
    (desired) =>
      (desired.volumes ?? []).every((name) => name.startsWith(`opscrew-${desired.app}_`)),
    {
      message: "each volume must be one of the app stack's (opscrew-<app>_<name>)",
      path: ["volumes"],
    },
  )
  .refine(
    (desired) =>
      (desired.scratchVolumes ?? []).every(
        (name) =>
          isDrillScratchVolume(`opscrew-${desired.app}`, name) &&
          !(desired.volumes ?? []).includes(name),
      ),
    {
      message:
        "each must be a scheduled drill's scratch volume (opscrew-<app>_<service>_drill) the app stack no longer has",
      path: ["scratchVolumes"],
    },
  )
  .refine((desired) => desired.redeploy !== "updater" || desired.updater !== undefined, {
    message: "the updater stack's Compose file is required in updater mode",
    path: ["updater"],
  })
  .refine((desired) => desired.redeploy !== "cloudflare" || desired.tunnelConnector !== undefined, {
    message: "the connector stack's Compose file is required in cloudflare mode",
    path: ["tunnelConnector"],
  })
  // With fingerprints, every part the mode uses is given, so no changed value goes unnoticed.
  .refine((desired) => desired.valueFingerprints?.app !== undefined || !desired.valueFingerprints, {
    message: "is required with valueFingerprints (the app stack's values)",
    path: ["valueFingerprints", "app"],
  })
  .refine(
    (desired) => desired.valueFingerprints?.webhook !== undefined || !desired.valueFingerprints,
    {
      message: "is required with valueFingerprints (the app stack's webhook id)",
      path: ["valueFingerprints", "webhook"],
    },
  )
  .refine(
    (desired) =>
      desired.redeploy !== "updater" ||
      desired.valueFingerprints?.updater !== undefined ||
      !desired.valueFingerprints,
    {
      message: "is required with valueFingerprints in updater mode (the updater's values)",
      path: ["valueFingerprints", "updater"],
    },
  )
  .refine(
    (desired) =>
      desired.redeploy !== "cloudflare" ||
      desired.valueFingerprints?.connector !== undefined ||
      !desired.valueFingerprints,
    {
      message: "is required with valueFingerprints in cloudflare mode (the connector's token)",
      path: ["valueFingerprints", "connector"],
    },
  )
  // A replaced token is always sent bound to the approved one.
  .refine((desired) => desired.replaceTokens?.repository !== true || desired.repository.private, {
    message: "needs a private repository (a public one has no token to replace)",
    path: ["replaceTokens", "repository"],
  })
  .refine(
    (desired) =>
      desired.replaceTokens?.repository !== true ||
      desired.valueFingerprints?.repositoryToken !== undefined,
    {
      message: "is required to replace the repository token (the plan is bound to the new token)",
      path: ["valueFingerprints", "repositoryToken"],
    },
  )
  .refine(
    (desired) => desired.replaceTokens?.registry !== true || desired.registry?.private === true,
    {
      message: "needs a private image (a public one has no registry entry to update)",
      path: ["replaceTokens", "registry"],
    },
  )
  .refine(
    (desired) =>
      desired.replaceTokens?.registry !== true ||
      desired.valueFingerprints?.registryToken !== undefined,
    {
      message: "is required to replace the registry token (the plan is bound to the new token)",
      path: ["valueFingerprints", "registryToken"],
    },
  );
export type DesiredStacks = z.infer<typeof DesiredStacksSchema>;

// --- Hash ----------------------------------------------------------------------------------------

/** SHA-256 (lower-case hex) of the canonical JSON of the plan: the hash `stack-apply` binds. */
export function stackPlanHash(plan: StackPlan): string {
  return sha256Hex(canonicalJson(plan));
}

/** The `${VARS}` (and `$VARS`) a Compose file interpolates, sorted; `$$` escapes are skipped. */
export function composeVariables(compose: string): string[] {
  const found = new Set<string>();
  const text = compose.replace(/\$\$/g, "");
  for (const match of text.matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?+-][^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = match[1] ?? match[2];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/**
 * The values a plan's changes send to Portainer: env keys per stack, the webhook id, and the
 * repository and registry tokens.
 */
export interface SentValues {
  app?: string[];
  updater?: string[];
  connector?: string[];
  /** The beside stacks' env keys, by stack name. */
  next?: Record<string, string[]>;
  webhook: boolean;
  repositoryToken: boolean;
  registryToken: boolean;
}

/** Actions that send a stack's full `Env` (and, for a private Git stack, the repository token). */
const SENDS_ENV = new Set(["create", "update", "redeploy"]);

/** Which values the `change`d entries of a plan send (shared by the planner and the apply). */
export function sentValues(changes: readonly StackChange[]): SentValues {
  const sent: SentValues = { webhook: false, repositoryToken: false, registryToken: false };
  for (const change of changes) {
    if (change.state !== "change") continue;
    const action = change.params.action;
    if (typeof action !== "string") continue;
    if (change.id === "registry") {
      // Adding the entry or replacing its token sends the registry token.
      if (action === "create" || action === "update") sent.registryToken = true;
      continue;
    }
    if (!SENDS_ENV.has(action)) continue;
    const keys = change.params.envKeys;
    const list = Array.isArray(keys) ? [...keys].sort() : [];
    if (change.id === "app-stack") {
      sent.app = list;
      // Creating the stack or saving its Git settings sends AutoUpdate.Webhook; a redeploy does not.
      if (action !== "redeploy") sent.webhook = true;
      if (change.params.repositoryAuthentication === true) sent.repositoryToken = true;
    } else if (change.id === "updater-stack") {
      sent.updater = list;
    } else if (change.id === "tunnel-connector-stack") {
      sent.connector = list;
    } else if (isNextStackChange(change.id)) {
      sent.next = { ...sent.next, [String(change.params.name)]: list };
    }
  }
  return sent;
}

/** True for a change of the beside stacks' plan. */
export function isNextStackChange(id: StackChangeId): id is NextStackChangeId {
  return id in NEXT_STACKS;
}

/** The fingerprints of the values a plan sends: the app's parts, and the beside stacks' by name. */
export type SentFingerprints = DesiredValueFingerprints & {
  next?: Record<string, Record<string, string>>;
};

/** SHA-256 over the canonical JSON (sorted keys) of the fingerprints of the values sent. */
export function valuesDigestOf(fingerprints: SentFingerprints): string {
  return sha256Hex(canonicalJson(fingerprints));
}

/** True when the plan sends no value at all. */
export function sendsNothing(sent: SentValues): boolean {
  return (
    sent.app === undefined &&
    sent.updater === undefined &&
    sent.connector === undefined &&
    sent.next === undefined &&
    !sent.webhook &&
    !sent.repositoryToken &&
    !sent.registryToken
  );
}

/** The fingerprints of exactly `keys` from `part`, or INVALID_INPUT naming what is missing. */
function pick(
  part: Record<string, string> | undefined,
  keys: readonly string[],
  label: string,
): Record<string, string> {
  const missing = keys.filter((key) => part?.[key] === undefined);
  if (missing.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `valueFingerprints.${label} lacks ${missing.join(", ")}, so the plan cannot be bound to the values it sends.`,
    );
  }
  return Object.fromEntries(keys.map((key) => [key, part?.[key] as string]));
}

/** The plan's `valuesDigest`, from the desired fingerprints of the values its changes send. */
function plannedDigest(
  changes: readonly StackChange[],
  fingerprints: DesiredValueFingerprints | undefined,
): string | undefined {
  if (fingerprints === undefined) return undefined;
  const sent = sentValues(changes);
  if (sendsNothing(sent)) return undefined;
  const parts: DesiredValueFingerprints = {};
  if (sent.app !== undefined) parts.app = pick(fingerprints.app, sent.app, "app");
  if (sent.updater !== undefined)
    parts.updater = pick(fingerprints.updater, sent.updater, "updater");
  if (sent.connector !== undefined) {
    parts.connector = pick(fingerprints.connector, sent.connector, "connector");
  }
  if (sent.webhook) parts.webhook = need(fingerprints.webhook, "webhook", "the webhook it sets");
  if (sent.repositoryToken) {
    parts.repositoryToken = need(
      fingerprints.repositoryToken,
      "repositoryToken",
      "the repository token it sends",
    );
  }
  if (sent.registryToken) {
    parts.registryToken = need(
      fingerprints.registryToken,
      "registryToken",
      "the registry token it sends",
    );
  }
  return valuesDigestOf(parts);
}

/** One fingerprint the plan's changes need, or INVALID_INPUT naming it. */
function need(value: string | undefined, name: string, what: string): string {
  if (value === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `valueFingerprints.${name} is missing, so the plan cannot be bound to ${what}.`,
    );
  }
  return value;
}

// --- Setup ---------------------------------------------------------------------------------------

/**
 * The Portainer changes that make `desired` true, in order: `registry` (administrator token
 * only), `app-stack`, then `updater-stack` or `tunnel-connector-stack` (and the removal of the
 * other one when the redeploy mode changed). Each is `in-place`, `change` or `blocked`; blocking
 * findings (a name taken by a stack OpsCrew did not create, a Compose project started outside
 * Portainer, no usable registry entry for a limited token, taken host ports) stop the apply. No
 * secret is part of the plan.
 */
export function planStacks(facts: PortainerFacts, desired: DesiredStacks): StackPlan {
  const d = parseDesired(desired);
  const env = facts.environment;
  if (env === undefined || env.id !== d.environmentId) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Inspect environment ${d.environmentId} with inspectPortainer before planning its stacks.`,
    );
  }
  const names = opscrewNames(d.app);
  const record = recordFor(d.record, names);
  const found: PortainerFinding[] = [...facts.findings];
  const admin = facts.user?.role === "admin";
  const changes: StackChange[] = [];
  const notes: string[] = [];

  if (d.registry?.private === true) {
    if (admin) {
      changes.push(registryChange(facts, d, names, record, found));
    } else {
      if (d.replaceTokens?.registry === true) {
        changes.push({
          id: "registry",
          title: "Replace the token of the ghcr.io registry entry",
          state: "blocked",
          reason:
            "Only a Portainer administrator's token can change registry entries: replace the token of the ghcr.io entry in Portainer (Registries) yourself, or run the command with an administrator's token.",
          params: { name: names.registry, url: "ghcr.io", replacesToken: "registry" },
        });
      }
      const usable = (facts.registries ?? []).find((entry) => isGhcr(entry.url));
      if (usable === undefined) {
        found.push(
          finding.registryMissing(
            facts.user?.username ?? "the token's user",
            facts.environment?.name ?? "the environment",
          ),
        );
      } else {
        notes.push(
          `Portainer pulls the private image with the registry entry ${usable.name} (${usable.url}).`,
        );
      }
    }
  }

  if (d.ports !== undefined && d.ports.length > 0) {
    if (admin && facts.publishedPorts !== undefined) {
      const wanted = new Set(d.ports);
      const taken = facts.publishedPorts.filter(
        (item) => wanted.has(item.port) && item.project?.toLowerCase() !== names.app,
      );
      if (taken.length > 0) found.push(finding.portsTaken(env.name, taken));
    } else {
      notes.push(
        `This token cannot see other users' containers: make sure host port${d.ports.length === 1 ? "" : "s"} ${[...d.ports].sort((a, b) => a - b).join(", ")} ${d.ports.length === 1 ? "is" : "are"} free on the host.`,
      );
    }
  }

  const fingerprints = d.valueFingerprints;
  const app = appChange(facts, d, names, record, found, notes);
  changes.push(app);

  if (d.redeploy === "updater" && d.updater !== undefined) {
    changes.push(
      stringStackChange(
        facts,
        names.updater,
        "updater",
        d.updater.compose,
        record,
        found,
        fingerprints?.updater,
        // The updater never keeps calling a webhook the app stack no longer has.
        setsNewWebhook(app, facts, fingerprints?.webhook),
      ),
    );
  } else {
    const removal = removeOtherMode(facts, record, "updater", names.updater);
    if (removal !== undefined) changes.push(removal);
  }
  if (d.redeploy === "cloudflare" && d.tunnelConnector !== undefined) {
    changes.push(
      stringStackChange(
        facts,
        names.tunnelConnector,
        "tunnel-connector",
        d.tunnelConnector.compose,
        record,
        found,
        fingerprints?.connector,
      ),
    );
  } else {
    const removal = removeOtherMode(facts, record, "tunnel-connector", names.tunnelConnector);
    if (removal !== undefined) changes.push(removal);
  }
  const scratch = scratchOf(facts, record, names, d.scratchVolumes);
  if (scratch.length > 0) {
    changes.push({
      id: "volumes",
      title: `${scratchLine(scratch)} (empty, left after their schedule was turned off)`,
      state: "change",
      params: { action: "remove", names: scratch },
    });
  }

  // Any of the app's names on a stack OpsCrew's record does not list blocks, whatever the mode.
  for (const name of ROLE_NAMES.map((role) => stackName(names, role))) {
    const visible = facts.stacks.find((stack) => stack.name.toLowerCase() === name);
    if (visible !== undefined && !record.stacks.some((stack) => stack.id === visible.id)) {
      found.push(finding.stackNameTaken(name, visible.id));
    }
  }

  const valuesDigest = plannedDigest(changes, fingerprints);
  return {
    schemaVersion: STACK_PLAN_SCHEMA_VERSION,
    purpose: "setup",
    app: d.app,
    environmentId: d.environmentId,
    changes,
    findings: unique(found),
    record,
    ...(valuesDigest !== undefined && { valuesDigest }),
  };
}

function parseDesired(desired: DesiredStacks): DesiredStacks {
  const parsed = DesiredStacksSchema.safeParse(desired);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The desired Portainer stacks are not valid: ${zodIssues(parsed.error, 5)}`,
    );
  }
  return parsed.data;
}

/** The record, checked to belong to this app (each stack has the app's name for its role). */
function recordFor(record: CreatedRecord | undefined, names: OpsCrewNames): CreatedRecord {
  const valid = CreatedRecordSchema.parse(record ?? { stacks: [], volumes: [] });
  for (const stack of valid.stacks) {
    if (stack.name !== stackName(names, stack.role)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew's record lists the stack ${stack.name} as the ${stack.role} stack, which is not this app's (${stackName(names, stack.role)}).`,
        {
          hint: "Check .opscrew/server.json: it must be this project's record of what OpsCrew created in Portainer.",
        },
      );
    }
  }
  const foreign = valid.volumes.filter((name) => !name.startsWith(`${names.app}_`));
  if (foreign.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew's record lists volumes that are not the app stack's (${names.app}_…): ${foreign.join(", ")}.`,
      {
        hint: "Check .opscrew/server.json: OpsCrew records only its app stack's volumes, and never deletes others.",
      },
    );
  }
  return {
    stacks: sortByRole(valid.stacks),
    ...(valid.registryId !== undefined && { registryId: valid.registryId }),
    volumes: [...new Set(valid.volumes)].sort(),
  };
}

/**
 * True when Portainer shows the volume `name` with another Compose project than the app stack's
 * (or none): it belongs to someone else now. One Portainer does not show tells nothing.
 */
function foreignVolume(facts: PortainerFacts, names: OpsCrewNames, name: string): boolean {
  const seen = facts.volumes?.find((volume) => volume.name === name);
  return seen !== undefined && seen.project?.toLowerCase() !== names.app;
}

/**
 * The scheduled drills' scratch volumes of `wanted` that `record` lists and Portainer does not show
 * as another project's, sorted.
 */
function scratchOf(
  facts: PortainerFacts,
  record: CreatedRecord,
  names: OpsCrewNames,
  wanted: readonly string[] | undefined,
): string[] {
  return [...new Set(wanted ?? [])]
    .filter(
      (name) =>
        record.volumes.includes(name) &&
        isDrillScratchVolume(names.app, name) &&
        !foreignVolume(facts, names, name),
    )
    .sort();
}

/** "Remove the scheduled drills' scratch volume(s) …". */
function scratchLine(scratch: readonly string[]): string {
  return `Remove the scheduled drills' scratch volume${scratch.length === 1 ? "" : "s"} ${scratch.join(", ")}`;
}

/** Recorded stacks in record order (app, updater, connector). */
export function sortByRole(stacks: CreatedRecord["stacks"]): CreatedRecord["stacks"] {
  return [...stacks].sort((a, b) => ROLE_NAMES.indexOf(a.role) - ROLE_NAMES.indexOf(b.role));
}

type Located =
  | { kind: "ours"; stack: PortainerStackFacts }
  | { kind: "absent"; recordedId?: number }
  | { kind: "taken"; stack: PortainerStackFacts };

/** Where the stack of `role` stands: OpsCrew's (recorded and present), absent, or someone else's. */
function locate(facts: PortainerFacts, record: CreatedRecord, role: Role, name: string): Located {
  const recorded = record.stacks.find((stack) => stack.role === role);
  const visible = facts.stacks.find((stack) => stack.name.toLowerCase() === name);
  if (visible !== undefined) {
    return recorded !== undefined && recorded.id === visible.id
      ? { kind: "ours", stack: visible }
      : { kind: "taken", stack: visible };
  }
  return recorded === undefined ? { kind: "absent" } : { kind: "absent", recordedId: recorded.id };
}

/** Blocks a stack name that is not OpsCrew's (a Portainer stack, or a Compose project for admins). */
function conflict(
  facts: PortainerFacts,
  located: Located,
  name: string,
  found: PortainerFinding[],
): string | undefined {
  const project =
    located.kind === "absent"
      ? facts.projects?.find((item) => item.name === name && item.containers > 0)
      : undefined;
  const blocker =
    located.kind === "taken"
      ? finding.stackNameTaken(name, located.stack.id)
      : project !== undefined
        ? finding.projectNameTaken(name, project.containers)
        : undefined;
  if (blocker !== undefined) found.push(blocker);
  return blocker?.message;
}

function recreatedNote(located: Located): string | undefined {
  return located.kind === "absent" && located.recordedId !== undefined
    ? `OpsCrew's record lists stack ${located.recordedId}, but Portainer no longer has it (or this token cannot see it): it is created again.`
    : undefined;
}

function registryChange(
  facts: PortainerFacts,
  d: DesiredStacks,
  names: OpsCrewNames,
  record: CreatedRecord,
  found: PortainerFinding[],
): StackChange {
  const envName = facts.environment?.name ?? String(d.environmentId);
  const user = facts.user;
  const base = { name: names.registry, url: "ghcr.io" };
  if (facts.registryEntries === undefined || user === undefined) {
    return {
      id: "registry",
      title: `Registry entry ${names.registry} for ghcr.io`,
      state: "blocked",
      reason: "OpsCrew could not list Portainer's registry entries with this token.",
      params: base,
    };
  }
  const grant = { grantUserId: user.id };
  const recorded =
    record.registryId === undefined
      ? undefined
      : facts.registryEntries.find((entry) => entry.id === record.registryId);
  if (recorded !== undefined) {
    if (!isGhcr(recorded.url)) {
      return {
        id: "registry",
        title: `Registry entry ${recorded.name} for ghcr.io`,
        state: "blocked",
        reason: `The registry entry OpsCrew added (${recorded.name}) now points to ${recorded.url}; OpsCrew does not change it back.`,
        params: { ...base, registryId: recorded.id },
      };
    }
    const granted = recorded.environments.includes(d.environmentId);
    if (d.replaceTokens?.registry === true) {
      if (recorded.name !== names.registry) {
        // Nothing read from Portainer is sent back: the update carries OpsCrew's own name.
        return {
          id: "registry",
          title: `Replace the token of the registry entry ${names.registry} (ghcr.io)`,
          state: "blocked",
          reason: `The registry entry OpsCrew added (id ${recorded.id}) is now named "${recorded.name}", not ${names.registry}, so OpsCrew does not send its token there. Rename it back to ${names.registry} in Portainer (Registries), then run the command again.`,
          params: { ...base, registryId: recorded.id, replacesToken: "registry" },
        };
      }
      // The grant is sent again too: harmless when it is there, and it holds whatever the
      // update does to the entry's grants.
      return {
        id: "registry",
        title: `Replace the token of the registry entry ${names.registry} (ghcr.io) and let ${user.username} use it on environment ${envName}`,
        state: "change",
        reason: `The registry token is sent again, as asked: Portainer never shows it back.${granted ? "" : " The entry is no longer usable on the environment, so it is granted again."}`,
        params: {
          action: "update",
          ...base,
          registryId: recorded.id,
          username: d.registry?.username ?? names.registry,
          replacesToken: "registry",
          ...grant,
        },
      };
    }
    if (granted) {
      return {
        id: "registry",
        title: `Registry entry ${recorded.name} for ghcr.io, usable on environment ${envName}`,
        state: "in-place",
        reason: "Already set up as planned.",
        params: { action: "keep", ...base, registryId: recorded.id },
      };
    }
    return {
      id: "registry",
      title: `Let ${user.username} use the registry entry ${recorded.name} on environment ${envName}`,
      state: "change",
      params: { action: "grant", ...base, registryId: recorded.id, ...grant },
    };
  }
  const taken = facts.registryEntries.find((entry) => entry.name === names.registry);
  if (taken !== undefined) {
    const blocker = finding.registryNameTaken(taken.name, taken.id);
    found.push(blocker);
    return {
      id: "registry",
      title: `Add the registry entry ${names.registry} for ghcr.io`,
      state: "blocked",
      reason: blocker.message,
      params: base,
    };
  }
  const others = facts.registryEntries.filter((entry) => isGhcr(entry.url));
  return {
    id: "registry",
    title: `Add the registry entry ${names.registry} for ghcr.io (with a read-only package token) and let ${user.username} use it on environment ${envName}`,
    state: "change",
    ...(record.registryId !== undefined && {
      reason: `OpsCrew's record lists registry entry ${record.registryId}, but Portainer no longer has it: it is added again.`,
    }),
    ...(others.length > 0 &&
      record.registryId === undefined && {
        reason: `Portainer already has another ghcr.io entry (${others.map((entry) => entry.name).join(", ")}); OpsCrew adds its own for this app.`,
      }),
    params: {
      action: "create",
      ...base,
      username: d.registry?.username ?? names.registry,
      ...grant,
    },
  };
}

function appChange(
  facts: PortainerFacts,
  d: DesiredStacks,
  names: OpsCrewNames,
  record: CreatedRecord,
  found: PortainerFinding[],
  notes: string[],
): StackChange {
  const located = locate(facts, record, "app", names.app);
  const envKeys = [...d.envKeys].sort();
  const { branch } = d.repository;
  const reference = `refs/heads/${branch}`;
  const params: Record<string, StackParamValue> = {
    name: names.app,
    repository: d.repository.url,
    reference,
    composeFile: DEPLOY_COMPOSE_FILE,
    repositoryAuthentication: d.repository.private,
    ...(d.repository.private && { repositoryUsername: d.repository.username ?? "x-access-token" }),
    envKeys,
    webhook: true,
    forcePullImage: false,
    volumes: [...new Set(d.volumes ?? [])].sort(),
  };
  const blocked = conflict(facts, located, names.app, found);
  if (blocked !== undefined) {
    return {
      id: "app-stack",
      title: `Create the Git stack ${names.app}`,
      state: "blocked",
      reason: blocked,
      params,
    };
  }
  const reasons = [...notes];
  if (located.kind === "absent") {
    const recreated = recreatedNote(located);
    if (recreated !== undefined) reasons.unshift(recreated);
    return {
      id: "app-stack",
      title: `Create the Git stack ${names.app} from the branch ${branch} (${DEPLOY_COMPOSE_FILE}), redeployed through its webhook`,
      state: "change",
      ...reason(reasons),
      params: { action: "create", ...params },
    };
  }
  const stack = located.stack;
  const differences: string[] = [];
  const git = stack.gitConfig;
  // Portainer 2.45 loads GitConfig from the stack's source; when it is missing, OpsCrew compares
  // only what it can see (the live test, T1008, checks the shape).
  if (git !== undefined) {
    if (!sameRepository(git.url, d.repository.url)) differences.push("the repository");
    if (git.referenceName !== reference) differences.push("the branch");
    if (git.configFilePath !== DEPLOY_COMPOSE_FILE) differences.push("the compose file path");
    if (git.authenticated !== d.repository.private) differences.push("the repository access");
  }
  if (!sameList(stack.envKeys, envKeys)) differences.push("the environment variables");
  const values = changedValues(stack.envFingerprints, envKeys, d.valueFingerprints?.app);
  if (values.text !== undefined) differences.push(values.text);
  const wanted = d.valueFingerprints?.webhook;
  if (
    stack.autoUpdate?.webhook !== true ||
    stack.autoUpdate.forcePullImage ||
    (wanted !== undefined && stack.autoUpdate.webhookFingerprint !== wanted)
  ) {
    differences.push("the webhook");
  }
  if (stack.autoUpdate?.interval !== undefined) differences.push("scheduled Git polling");
  // Portainer never shows the repository token back: replacing it is asked for explicitly.
  const replaces = d.replaceTokens?.repository === true;
  if (replaces) differences.push("the repository token (replaced)");
  if (stack.status === 4) reasons.unshift(ERROR_STATE_NOTE);
  const changed = changedParam(values.keys);
  if (differences.length > 0) {
    return {
      id: "app-stack",
      title: `Update the Git stack ${names.app}: ${differences.join(", ")} (the full environment is sent again and the stack is redeployed from ${branch})`,
      state: "change",
      ...reason(reasons),
      params: {
        action: "update",
        ...params,
        stackId: stack.id,
        differences,
        ...changed,
        ...(replaces && { replacesToken: "repository" }),
      },
    };
  }
  const recovery = recover(stack, `the Git stack ${names.app}`, `from the branch ${branch}`);
  if (recovery !== undefined) {
    return {
      id: "app-stack",
      title: recovery.title,
      state: "change",
      ...reason(reasons),
      params: { ...params, action: recovery.action, stackId: stack.id },
    };
  }
  return {
    id: "app-stack",
    title: `Git stack ${names.app} from the branch ${branch}`,
    state: "in-place",
    reason: ["Already set up as planned.", ...reasons].join(" "),
    params: { action: "keep", ...params, stackId: stack.id },
  };
}

/**
 * Whether applying the app stack's change may give it another webhook than Portainer has: a new
 * stack, or an update (which sets `AutoUpdate.Webhook`) unless the webhook is known to be the same
 * (Portainer's fingerprint equals the desired one).
 */
function setsNewWebhook(
  app: StackChange,
  facts: PortainerFacts,
  wanted: string | undefined,
): boolean {
  if (app.state !== "change") return false;
  if (app.params.action === "create") return true;
  if (app.params.action !== "update") return false;
  const stack = facts.stacks.find((item) => item.id === app.params.stackId);
  const same =
    stack?.autoUpdate?.webhook === true &&
    wanted !== undefined &&
    stack.autoUpdate.webhookFingerprint === wanted;
  return !same;
}

/** `changedValues`: the keys whose values change (names only), when there are any. */
function changedParam(keys: readonly string[]): Record<string, StackParamValue> {
  return keys.length > 0 ? { changedValues: [...keys] } : {};
}

const ERROR_STATE_NOTE =
  "Portainer reports the stack in an error state: before the next deploy Portainer removes all of its containers, so nothing runs until a deploy succeeds.";

/** A stack in error (Status 4) is redeployed; a stopped one (Status 2) is started. */
function recover(
  stack: PortainerStackFacts,
  label: string,
  from: string,
): { title: string; action: "redeploy" | "start" } | undefined {
  if (stack.status === 4) {
    const last = stack.deploymentStatus.at(-1)?.message;
    return {
      title: `Redeploy ${label} ${from}: Portainer reports its last deploy failed${last === undefined ? "" : ` ("${last}")`} (the full environment is sent again)`,
      action: "redeploy",
    };
  }
  if (stack.status === 2) {
    return { title: `Start ${label} again: Portainer reports it stopped`, action: "start" };
  }
  return undefined;
}

/**
 * Which values differ, by key only: the desired fingerprints against Portainer's. When Portainer's
 * are unknown (the client had no value key), every value is sent again: the safe direction.
 */
function changedValues(
  remote: Record<string, string> | undefined,
  keys: readonly string[],
  desired: Record<string, string> | undefined,
): { keys: string[]; text?: string } {
  if (desired === undefined) return { keys: [] };
  if (remote === undefined) {
    return keys.length === 0
      ? { keys: [] }
      : {
          keys: [...keys],
          text: "the values (OpsCrew cannot compare them without its value key, so it sends them again)",
        };
  }
  const changed = keys.filter((key) => desired[key] === undefined || remote[key] !== desired[key]);
  return changed.length === 0
    ? { keys: [] }
    : {
        keys: changed,
        text: `the value${changed.length === 1 ? "" : "s"} of ${changed.join(", ")}`,
      };
}

function stringStackChange(
  facts: PortainerFacts,
  name: string,
  role: "updater" | "tunnel-connector",
  compose: string,
  record: CreatedRecord,
  found: PortainerFinding[],
  fingerprints: Record<string, string> | undefined,
  appWebhookChanges = false,
): StackChange {
  return composeStackChange(
    facts,
    {
      id: ROLES[role].change,
      label: role === "updater" ? "updater stack" : "Cloudflare connector stack",
      purpose:
        role === "updater"
          ? "asks Portainer once a minute, through the app stack's webhook, to redeploy it when the deploy branch changed"
          : "lets the deploy workflow reach Portainer's webhook only through Cloudflare Access",
      name,
      compose,
      located: locate(facts, record, role, name),
    },
    found,
    fingerprints,
    appWebhookChanges,
  );
}

/** A stack made from a Compose file OpsCrew gives (not from Git), and where it stands. */
interface ComposeStack {
  id: StackChangeId;
  /** What the stack is, e.g. "updater stack". */
  label: string;
  /** What it does, shown when it is created. */
  purpose: string;
  name: string;
  compose: string;
  located: Located;
}

/** The change that makes `stack` run its Compose file with the values of `fingerprints`. */
function composeStackChange(
  facts: PortainerFacts,
  { id, label, purpose, name, compose, located }: ComposeStack,
  found: PortainerFinding[],
  fingerprints: Record<string, string> | undefined,
  appWebhookChanges = false,
): StackChange {
  const params: Record<string, StackParamValue> = {
    name,
    compose,
    composeSha256: sha256Hex(compose),
    envKeys: composeVariables(compose),
  };
  const blocked = conflict(facts, located, name, found);
  if (blocked !== undefined) {
    return { id, title: `Create the ${label} ${name}`, state: "blocked", reason: blocked, params };
  }
  if (located.kind === "absent") {
    return {
      id,
      title: `Create the ${label} ${name} (${purpose})`,
      state: "change",
      ...reason([recreatedNote(located)].filter((text): text is string => text !== undefined)),
      params: { action: "create", ...params },
    };
  }
  const stack = located.stack;
  const differences: string[] = [];
  const keys = composeVariables(compose);
  if (stack.fileSha256 !== sha256Hex(compose)) differences.push("its stack file");
  if (!sameList(stack.envKeys, keys)) differences.push("its environment variables");
  const values = changedValues(stack.envFingerprints, keys, fingerprints);
  if (values.text !== undefined) differences.push(values.text);
  if (appWebhookChanges) differences.push("the app stack's webhook, which it calls");
  const notes = stack.status === 4 ? [ERROR_STATE_NOTE] : [];
  if (differences.length > 0) {
    return {
      id,
      title: `Update the ${label} ${name}: ${differences.join(", ")} (the full environment is sent again)`,
      state: "change",
      ...reason(notes),
      params: {
        action: "update",
        ...params,
        stackId: stack.id,
        differences,
        ...changedParam(values.keys),
      },
    };
  }
  const recovery = recover(stack, `the ${label} ${name}`, "with the same stack file");
  if (recovery !== undefined) {
    return {
      id,
      title: recovery.title,
      state: "change",
      ...reason(notes),
      params: { ...params, action: recovery.action, stackId: stack.id },
    };
  }
  return {
    id,
    title: `The ${label} ${name}`,
    state: "in-place",
    reason: "Already set up as planned.",
    params: { action: "keep", ...params, stackId: stack.id },
  };
}

/** When the redeploy mode changed: remove the other mode's stack OpsCrew created. */
function removeOtherMode(
  facts: PortainerFacts,
  record: CreatedRecord,
  role: "updater" | "tunnel-connector",
  name: string,
): StackChange | undefined {
  const recorded = record.stacks.find((stack) => stack.role === role);
  if (recorded === undefined) return undefined;
  const id = ROLES[role].change;
  const visible = facts.stacks.find((stack) => stack.id === recorded.id);
  if (visible === undefined || visible.name.toLowerCase() !== name) {
    return {
      id,
      title: `Forget the stack ${name} (no longer needed for this redeploy mode)`,
      state: "change",
      reason: `Portainer does not show stack ${recorded.id} any more (removed, or this token cannot see it).`,
      params: { action: "forget", name, stackId: recorded.id },
    };
  }
  return {
    id,
    title: `Remove the stack ${name} OpsCrew created (not needed for this redeploy mode)`,
    state: "change",
    params: { action: "remove", name, stackId: recorded.id },
  };
}

// --- Teardown ------------------------------------------------------------------------------------

/** Findings that also stop a teardown (missing access); version and type findings do not. */
const TEARDOWN_BLOCKERS = new Set(["token-rejected", "access-denied", "environment-missing"]);

/**
 * The plan that removes exactly what `record` lists for `opts.app`, in order: the updater and
 * connector stacks, (with `deleteData`) the recorded volumes after stopping the app stack, or
 * (without it) only the drills' scratch volumes, the app stack, then the registry entry. Stacks,
 * volumes and entries OpsCrew did not create are never part of it, nor is Portainer itself.
 */
export function planStackTeardown(
  facts: PortainerFacts,
  record: CreatedRecord,
  opts: {
    deleteData: boolean;
    app: string;
    /**
     * The recorded volume that holds no data (the version the site serves): deleted with the data
     * volumes, but never named or kept as the app's data.
     */
    versionVolume?: string;
    /**
     * The scheduled drills' scratch volumes (`opscrew-<app>_<service>_drill`, empty between runs):
     * those the record lists go with the app stack whatever `deleteData` says, never called data.
     */
    scratchVolumes?: readonly string[];
  },
): StackPlan {
  const env = facts.environment;
  if (env === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Inspect the environment with inspectPortainer before planning the teardown.",
    );
  }
  const parsedRecord = CreatedRecordSchema.safeParse(record);
  if (!parsedRecord.success) {
    throw new OpsCrewError("INVALID_INPUT", "OpsCrew's record of what it created is not valid.", {
      hint: "Check .opscrew/server.json → portainer.created.",
    });
  }
  const app = opts.app;
  const names = opscrewNames(app);
  const valid = recordFor(parsedRecord.data, names);
  const changes: StackChange[] = [];
  const stackOf = (role: Role) => valid.stacks.find((stack) => stack.role === role);

  for (const role of ["updater", "tunnel-connector"] as const) {
    const recorded = stackOf(role);
    if (recorded !== undefined) changes.push(removeStackChange(facts, recorded, role));
  }

  const appRecorded = stackOf("app");
  const appVisible =
    appRecorded === undefined
      ? undefined
      : facts.stacks.find((stack) => stack.id === appRecorded.id);
  const projectVolumes = (facts.volumes ?? [])
    .filter((volume) => volume.project?.toLowerCase() === names.app)
    .map((volume) => volume.name);
  const unrecorded = projectVolumes.filter((name) => !valid.volumes.includes(name)).sort();
  const scratch = scratchOf(facts, valid, names, opts.scratchVolumes);
  const scratchText = `${scratchLine(scratch)} (empty between their runs: no data)`;
  if (opts.deleteData) {
    const kept =
      unrecorded.length > 0
        ? ` Volumes of the app's project that OpsCrew did not record are kept: ${unrecorded.join(", ")}.`
        : "";
    // A recorded volume whose Compose project label (when Portainer shows it) is not the app's
    // stack belongs to someone else now: OpsCrew deletes none of them.
    const foreign = valid.volumes.filter((name) => foreignVolume(facts, names, name));
    // The version volume and the drills' scratch volumes hold no data: they are deleted with the
    // data volumes, but not called data.
    const data = valid.volumes.filter(
      (name) => name !== opts.versionVolume && !scratch.includes(name),
    );
    const lines = [
      ...(data.length > 0 ? [`Delete the app's data volumes ${data.join(", ")}`] : []),
      ...(opts.versionVolume !== undefined && valid.volumes.includes(opts.versionVolume)
        ? [`Delete the volume ${opts.versionVolume} (the version the site serves)`]
        : []),
      ...(scratch.length > 0 ? [scratchText] : []),
    ];
    const title = lines[0] ?? "Delete the app's data volumes";
    if (valid.volumes.length === 0) {
      changes.push({
        id: "volumes",
        title: "Delete the app's data volumes",
        state: "in-place",
        reason: `OpsCrew recorded no volumes for this app.${kept}`,
        params: { action: "remove", names: [] },
      });
    } else if (foreign.length > 0) {
      changes.push({
        id: "volumes",
        title,
        state: "blocked",
        reason: `Portainer shows ${foreign.join(", ")} as belonging to ${foreign
          .map((name) => facts.volumes?.find((volume) => volume.name === name)?.project)
          .map((project) =>
            project === undefined ? "no Compose project" : `the project ${project}`,
          )
          .join(
            ", ",
          )}, not the app stack ${names.app}; OpsCrew deletes no volume that is not the app stack's. Check these volumes in Portainer, or destroy without deleting data.`,
        params: { action: "remove", names: valid.volumes },
      });
    } else {
      const reason = [...lines.slice(1).map((line) => `${line}, too.`), kept.trim()]
        .filter((text) => text !== "")
        .join(" ");
      changes.push({
        id: "volumes",
        title:
          data.length > 0
            ? `${title} (this cannot be undone; OpsCrew does not back them up)`
            : title,
        state: "change",
        ...(reason !== "" && { reason }),
        params: {
          action: "remove",
          names: valid.volumes,
          ...(appVisible !== undefined &&
            appVisible.status !== 2 && { stopStackId: appVisible.id }),
        },
      });
    }
  }
  if (appRecorded !== undefined) {
    const change = removeStackChange(facts, appRecorded, "app");
    if (!opts.deleteData && change.state === "change") {
      // The drills' scratch volumes hold no data: they go with the app stack anyway, after
      // stopping it (its loops use them) and while its access lets a limited token see them (R9).
      if (scratch.length > 0) {
        changes.push({
          id: "volumes",
          title: scratchText,
          state: "change",
          params: {
            action: "remove",
            names: scratch,
            ...(appVisible !== undefined &&
              appVisible.status !== 2 && { stopStackId: appVisible.id }),
          },
        });
      }
      const volumes = [...new Set([...valid.volumes, ...projectVolumes])]
        .filter((name) => name !== opts.versionVolume && !scratch.includes(name))
        .sort();
      if (volumes.length > 0) {
        change.reason = `Its named volumes (the app's data) are kept: ${volumes.join(", ")}.`;
      }
    }
    changes.push(change);
  }

  if (valid.registryId !== undefined) changes.push(removeRegistryChange(facts, valid, names));

  return {
    schemaVersion: STACK_PLAN_SCHEMA_VERSION,
    purpose: "teardown",
    app,
    environmentId: env.id,
    changes,
    findings: unique(facts.findings.filter((item) => TEARDOWN_BLOCKERS.has(item.code))),
    record: valid,
    deleteData: opts.deleteData,
  };
}

function removeStackChange(
  facts: PortainerFacts,
  recorded: CreatedRecord["stacks"][number],
  role: Role,
): StackChange {
  const id = ROLES[role].change;
  const title = `Remove the stack ${recorded.name}`;
  const params = { action: "remove", name: recorded.name, stackId: recorded.id };
  const visible = facts.stacks.find((stack) => stack.id === recorded.id);
  if (visible !== undefined && visible.name.toLowerCase() === recorded.name) {
    return { id, title, state: "change", params };
  }
  const other = facts.stacks.find((stack) => stack.name.toLowerCase() === recorded.name);
  return {
    id,
    title,
    state: "in-place",
    reason:
      other !== undefined
        ? `Stack ${recorded.id} is gone; Portainer has another stack named ${recorded.name} (id ${other.id}) that OpsCrew did not create, and OpsCrew leaves it alone.`
        : `Portainer does not show stack ${recorded.id} any more (removed, or this token cannot see it).`,
    params: { ...params, action: "forget" },
  };
}

function removeRegistryChange(
  facts: PortainerFacts,
  record: CreatedRecord,
  names: OpsCrewNames,
): StackChange {
  const registryId = record.registryId as number;
  const title = `Remove the registry entry ${names.registry} OpsCrew added`;
  const params = { action: "remove", name: names.registry, registryId };
  if (facts.user?.role !== "admin" || facts.registryEntries === undefined) {
    return {
      id: "registry",
      title,
      state: "blocked",
      reason:
        "Only an administrator can remove registry entries: run the command with an administrator's token in PORTAINER_API_KEY.",
      params,
    };
  }
  const entry = facts.registryEntries.find((item) => item.id === registryId);
  if (entry === undefined) {
    return {
      id: "registry",
      title,
      state: "in-place",
      reason: `Portainer no longer has registry entry ${registryId}.`,
      params: { ...params, action: "forget" },
    };
  }
  if (!isGhcr(entry.url)) {
    return {
      id: "registry",
      title: `Remove the registry entry ${entry.name}`,
      state: "blocked",
      reason: `Registry entry ${registryId} now points to ${entry.url}, not ghcr.io; OpsCrew does not remove it. Remove it in Portainer yourself if it is no longer used.`,
      params,
    };
  }
  return {
    id: "registry",
    title: `Remove the registry entry ${entry.name} OpsCrew added`,
    state: "change",
    params: { ...params, name: entry.name },
  };
}

// --- Beside stacks (the move to another Cloudflare account) -------------------------------------

/**
 * The app's beside stacks to run or remove while it moves to another Cloudflare account (feature
 * 028): see {@link planNextStacks}.
 */
export interface DesiredNextStacks {
  /** The stacks' names derive from it: `opscrew-<app>-tunnel-next`, `opscrew-<app>-portainer-tunnel-next`. */
  app: string;
  environmentId: number;
  /**
   * The beside stacks to run, as `renderNextConnectorStacks` renders them (each Compose file uses
   * only `${TUNNEL_TOKEN}`), or `"remove"` to remove both.
   */
  stacks: readonly { name: string; compose: string }[] | "remove";
  /**
   * By stack name, `valueFingerprints(valueKey, { TUNNEL_TOKEN: token })` of the token it gets
   * (every stack to run needs it); `{}` to remove.
   */
  fingerprints: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const DesiredNextStacksSchema = z
  .strictObject({
    app: AppNameSchema,
    environmentId: z.int().positive(),
    stacks: z.union([
      z.literal("remove"),
      z
        .array(z.strictObject({ name: z.string(), compose: TunnelComposeSchema }))
        .max(NEXT_STACK_CHANGE_IDS.length),
    ]),
    fingerprints: z.record(z.string(), FingerprintsSchema),
  })
  .superRefine((desired, ctx) => {
    if (desired.stacks === "remove" || !AppNameSchema.safeParse(desired.app).success) return;
    const names = NEXT_STACK_CHANGE_IDS.map((id) => nextStackName(desired.app, id));
    const seen = new Set<string>();
    desired.stacks.forEach((stack, i) => {
      if (!names.includes(stack.name) || seen.has(stack.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["stacks", i, "name"],
          message: `must be one of ${names.join(" and ")}, once`,
        });
      }
      seen.add(stack.name);
      if (desired.fingerprints[stack.name]?.TUNNEL_TOKEN === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["fingerprints", stack.name],
          message: "needs the fingerprint of its TUNNEL_TOKEN (the plan is bound to the token)",
        });
      }
    });
  });

/** True for a stack that looks like a beside stack: from a stack file, its only value TUNNEL_TOKEN. */
export function isBesideStack(stack: Pick<PortainerStackFacts, "gitConfig" | "envKeys">): boolean {
  return stack.gitConfig === undefined && sameList(stack.envKeys, ["TUNNEL_TOKEN"]);
}

/** What each beside stack does, shown when it is created. */
const NEXT_PURPOSES: Record<NextStackChangeId, string> = {
  "tunnel-next-stack":
    "runs the new account's tunnel connector for the app beside the current one, on the app stack's network",
  "tunnel-connector-next-stack":
    "lets the deploy workflow reach Portainer's webhook through the new account's Cloudflare Access, beside the current connector",
};

/**
 * The stack plan of the app's beside stacks while it moves to another Cloudflare account
 * ({@link NEXT_STACKS}), approved by its hash like any other (`stack-apply`). With `stacks`, each
 * given one is created, updated (its file, or its `TUNNEL_TOKEN` by fingerprint), redeployed,
 * started or in place, and the plan is bound to the tokens it sends (`valuesDigest`); with
 * `"remove"`, both are removed (in place when absent). They are found by name, as OpsCrew keeps no
 * record of them; the app's own stacks, the registry and the record are never part of this plan,
 * and no token is.
 */
export function planNextStacks(facts: PortainerFacts, desired: DesiredNextStacks): StackPlan {
  const parsed = DesiredNextStacksSchema.safeParse(desired);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The beside Portainer stacks are not valid: ${zodIssues(parsed.error, 5)}`,
    );
  }
  const d = parsed.data;
  if (facts.environment === undefined || facts.environment.id !== d.environmentId) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Inspect environment ${d.environmentId} with inspectPortainer before planning its stacks.`,
    );
  }
  const { stacks } = d;
  const remove = stacks === "remove";
  const found: PortainerFinding[] = [];
  const changes: StackChange[] = [];
  for (const id of NEXT_STACK_CHANGE_IDS) {
    const name = nextStackName(d.app, id);
    const visible = facts.stacks.find((stack) => stack.name.toLowerCase() === name);
    // A stack of the name is the beside stack only when it looks like one (a stack file using only
    // TUNNEL_TOKEN): another app's Git stack may have the name (`opscrew-shop-tunnel-next`).
    const located: Located =
      visible === undefined
        ? { kind: "absent" }
        : isBesideStack(visible)
          ? { kind: "ours", stack: visible }
          : { kind: "taken", stack: visible };
    if (remove) {
      const title = `Remove the stack ${name}`;
      if (located.kind === "taken") {
        const blocker = finding.stackNameTaken(name, located.stack.id);
        found.push(blocker);
        changes.push({ id, title, state: "blocked", reason: blocker.message, params: { name } });
      } else {
        changes.push(
          located.kind === "absent"
            ? {
                id,
                title,
                state: "in-place",
                reason:
                  "Portainer has no stack of this name (removed, or this token cannot see it).",
                params: { action: "absent", name },
              }
            : {
                id,
                title,
                state: "change",
                params: { action: "remove", name, stackId: located.stack.id },
              },
        );
      }
      continue;
    }
    const given = stacks.find((stack) => stack.name === name);
    if (given === undefined) continue;
    changes.push(
      composeStackChange(
        facts,
        {
          id,
          label: "new Cloudflare account's connector stack",
          purpose: NEXT_PURPOSES[id],
          name,
          compose: given.compose,
          located,
        },
        found,
        d.fingerprints[name],
      ),
    );
  }
  const sent = sentValues(changes).next;
  const valuesDigest =
    sent === undefined
      ? undefined
      : valuesDigestOf({
          next: Object.fromEntries(
            Object.entries(sent).map(([name, keys]) => [
              name,
              pick(d.fingerprints[name], keys, `next.${name}`),
            ]),
          ),
        });
  const blockers = remove
    ? facts.findings.filter((item) => TEARDOWN_BLOCKERS.has(item.code))
    : facts.findings;
  return {
    schemaVersion: STACK_PLAN_SCHEMA_VERSION,
    purpose: remove ? "teardown" : "setup",
    app: d.app,
    environmentId: d.environmentId,
    changes,
    findings: unique([...blockers, ...found]),
    record: { stacks: [], volumes: [] },
    ...(valuesDigest !== undefined && { valuesDigest }),
  };
}

// --- Helpers -------------------------------------------------------------------------------------

function reason(parts: readonly string[]): { reason?: string } {
  return parts.length === 0 ? {} : { reason: parts.join(" ") };
}

function unique(list: readonly PortainerFinding[]): PortainerFinding[] {
  const seen = new Set<string>();
  return list.filter((finding) => {
    const key = `${finding.code}\n${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

function sameRepository(a: string | undefined, b: string): boolean {
  const normal = (text: string) => {
    try {
      const url = new URL(text);
      return `${url.host}${url.pathname}`
        .toLowerCase()
        .replace(/\/+$/, "")
        .replace(/\.git$/, "");
    } catch {
      return text;
    }
  };
  return a !== undefined && normal(a) === normal(b);
}

function isGhcr(url: string): boolean {
  return /^(?:https?:\/\/)?ghcr\.io\/?$/i.test(url.trim());
}
