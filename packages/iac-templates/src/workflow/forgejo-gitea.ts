// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are GitHub/Forgejo/Gitea Actions syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import type { RuntimeContext } from "../runtime";
import type { RenderedFile } from "../types";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHost(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Adapts OpsCrew's GitHub Actions deploy workflow for Forgejo Actions (`forgejo-actions`) or
 * Gitea Actions (`gitea-actions`) with ONLY the documented differences from
 * `specs/043-forgejo-gitea/research.md`:
 *
 * 1. Native workflow path (`.forgejo/workflows/...` or `.gitea/workflows/...`), preserved from
 *    `plan.cicd.workflowPath`.
 * 2. Instance OCI container registry (`cicd.registryHost ?? cicd.host ?? codeberg.org|gitea.com`)
 *    in place of `ghcr.io`, authenticating with
 *    `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}`.
 * 3. No `environment:` job blocks (neither Forgejo nor Gitea supports deployment environments;
 *    secrets live at repository scope with OpsCrew's per-environment prefixes).
 * 4. `runs-on:` targets `<runnerLabel>` directly for self-hosted `forgejo-runner` / `act_runner`
 *    daemons (rather than `[self-hosted, <runnerLabel>]`) and `ubuntu-latest` for docker-mode
 *    runners (never GitHub-only `ubuntu-24.04-arm`).
 */
export function renderForgejoOrGiteaWorkflow(
  plan: DeployPlan,
  ctx: RuntimeContext,
  renderGitHubTemplate: (githubPlan: DeployPlan, ctx: RuntimeContext) => RenderedFile,
): RenderedFile {
  const isForgejo = plan.cicd.provider === "forgejo-actions";
  const displayName = isForgejo ? "Forgejo" : "Gitea";
  const defaultHost = isForgejo ? "codeberg.org" : "gitea.com";
  const host = normalizeHost(plan.cicd.host, defaultHost);
  const registryHost = normalizeHost(plan.cicd.registryHost ?? plan.cicd.host, defaultHost);
  const escapedRegistry = escapeRegex(registryHost);
  const escapedHost = escapeRegex(host);

  // Render GitHub's template with repository-scoped prefixed secrets (no `environment:` block).
  const basePlan: DeployPlan = {
    ...plan,
    cicd: {
      ...plan.cicd,
      provider: "github-actions",
      registry: "ghcr",
    },
    environment: plan.environment
      ? { ...plan.environment, secrets: "prefixed" }
      : {
          deploySource: { from: "main" },
          runner: "github",
          secrets: "prefixed",
        },
  };

  const rendered = renderGitHubTemplate(basePlan, ctx);

  // Apply only the verified Forgejo / Gitea deltas.
  const content = rendered.content
    .replaceAll("GitHub Container Registry", `${displayName} Container Registry`)
    .replaceAll("ghcr\\.io/", `${escapedRegistry}/`)
    .replaceAll("ghcr.io", registryHost)
    .replaceAll(
      "    password: ${{ secrets.GITHUB_TOKEN }}",
      "    password: ${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}",
    )
    .replaceAll("runs-on: ubuntu-24.04-arm", "runs-on: ubuntu-latest")
    .replace(/runs-on: \[self-hosted, ([^\]]+)\]/g, "runs-on: $1")
    .replaceAll("https://github\\.com/", `https://${escapedHost}/`);

  return {
    path: plan.cicd.workflowPath,
    kind: "workflow",
    content,
  };
}
