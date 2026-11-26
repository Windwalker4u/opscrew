import {
  type CommandRunner,
  type CredentialCheck,
  GIT_PLATFORM_CONTRACT_VERSION,
  type GitPlatformConnector,
  type GitPlatformConnectorDeps,
  type GitPlatformDefinition,
} from "@opscrew/contracts";
import { errorText, Redactor } from "@opscrew/core";
import { ForgejoGiteaClient } from "./client";
import {
  type ForgeFlavor,
  forgeContainerImage,
  normalizeForgeHost,
  parseForgejoRemote,
  parseGiteaRemote,
} from "./remote";

export { ForgejoGiteaClient, type ForgejoGiteaClientOptions } from "./client";
export {
  type ForgeFlavor,
  forgeContainerImage,
  normalizeForgeHost,
  parseForgejoRemote,
  parseGiteaRemote,
} from "./remote";

export const FORGEJO_TOKEN_PERMISSIONS = [
  "write:repository (read/write files, pull requests, Actions secrets, runs, runners)",
  "write:package (push and read container images in Forgejo's package registry)",
] as const;

export const GITEA_TOKEN_PERMISSIONS = [
  "write:repository (read/write files, pull requests, Actions secrets, runs, runners)",
  "write:package (push and read container images in Gitea's package registry)",
] as const;

/** Resolves a Forgejo personal access token from `FORGEJO_TOKEN`. */
export async function resolveForgejoToken(
  env: Record<string, string | undefined>,
  _runner: CommandRunner,
): Promise<string | undefined> {
  const token = env.FORGEJO_TOKEN?.trim();
  return token && token.length > 0 ? token : undefined;
}

/** Resolves a Gitea personal access token from `GITEA_TOKEN`. */
export async function resolveGiteaToken(
  env: Record<string, string | undefined>,
  _runner: CommandRunner,
): Promise<string | undefined> {
  const token = env.GITEA_TOKEN?.trim();
  return token && token.length > 0 ? token : undefined;
}

function createForgeConnector(
  flavor: ForgeFlavor,
  deps: GitPlatformConnectorDeps,
): GitPlatformConnector {
  const isForgejo = flavor === "forgejo";
  const displayName = isForgejo ? "Forgejo" : "Gitea";
  const envVar = isForgejo ? "FORGEJO_TOKEN" : "GITEA_TOKEN";
  const defaultHost = isForgejo ? "codeberg.org" : "gitea.com";
  const permissions = isForgejo ? FORGEJO_TOKEN_PERMISSIONS : GITEA_TOKEN_PERMISSIONS;
  const redactor = deps.redactor ?? new Redactor();
  const host = normalizeForgeHost(deps.host) ?? defaultHost;
  const client = deps.token
    ? new ForgejoGiteaClient({
        flavor,
        token: deps.token,
        host,
        fetch: deps.fetch,
        redactor,
        ...(deps.version !== undefined ? { version: deps.version } : {}),
      })
    : undefined;

  return {
    id: flavor,
    displayName,
    credentials: {
      envVars: [envVar],
      description: `${displayName} Personal Access Token with repository and package write scopes.`,
      scopes: [...permissions],
      createUrl: `https://${host}/user/settings/applications`,
    },
    client,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (!client) {
        return {
          ok: false,
          message: `No ${displayName} token: set ${envVar} with repository and package scopes on ${host}.`,
        };
      }
      try {
        const username = await client.whoAmI();
        return {
          ok: true,
          identity: username,
          message: `${displayName} token works on ${host} (signed in as ${username}).`,
        };
      } catch (error) {
        return { ok: false, message: redactor.redact(errorText(error)) };
      }
    },
  };
}

/** The Forgejo git platform definition (Codeberg and self-hosted Forgejo, Feature 043). */
export const forgejoDefinition: GitPlatformDefinition = {
  contractVersion: GIT_PLATFORM_CONTRACT_VERSION,
  id: "forgejo",
  displayName: "Forgejo",
  cicdProvider: "forgejo-actions",
  registryId: "forgejo-registry",
  credentials: {
    envVars: ["FORGEJO_TOKEN"],
    // Forgejo PATs are unprefixed 40-char hex strings (indistinguishable from Git SHAs), so
    // literal redaction protects configured tokens without false-positive commit SHA findings.
    tokenRules: [],
  },
  texts: {
    changeRequestNoun: "pull request",
    pipelineNoun: "workflow",
    remoteFixHint:
      "Create the repository on Codeberg or your Forgejo host, run `git remote add origin https://codeberg.org/<owner>/<repo>.git`, push, then run `opscrew init` again.",
    tokenFixHint:
      "Set FORGEJO_TOKEN (created at Settings -> Applications with repository and package write scopes).",
  },
  parseRemote: parseForgejoRemote,
  containerImage: forgeContainerImage,
  resolveToken: resolveForgejoToken,
  createConnector: (deps) => createForgeConnector("forgejo", deps),
};

/** The Gitea git platform definition (`gitea.com` and self-hosted Gitea, Feature 043). */
export const giteaDefinition: GitPlatformDefinition = {
  contractVersion: GIT_PLATFORM_CONTRACT_VERSION,
  id: "gitea",
  displayName: "Gitea",
  cicdProvider: "gitea-actions",
  registryId: "gitea-registry",
  credentials: {
    envVars: ["GITEA_TOKEN"],
    // Gitea PATs are unprefixed 40-char hex strings (indistinguishable from Git SHAs), so
    // literal redaction protects configured tokens without false-positive commit SHA findings.
    tokenRules: [],
  },
  texts: {
    changeRequestNoun: "pull request",
    pipelineNoun: "workflow",
    remoteFixHint:
      "Create the repository on Gitea (or your self-hosted instance), run `git remote add origin https://gitea.com/<owner>/<repo>.git`, push, then run `opscrew init` again.",
    tokenFixHint:
      "Set GITEA_TOKEN (created at Settings -> Applications with repository and package write scopes).",
  },
  parseRemote: parseGiteaRemote,
  containerImage: forgeContainerImage,
  resolveToken: resolveGiteaToken,
  createConnector: (deps) => createForgeConnector("gitea", deps),
};
