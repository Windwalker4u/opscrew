// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitLab CI syntax, not JavaScript templates.
import type { DeployPlan } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { initStepsFor } from "../catalog";
import { appDir } from "../edge";
import { certbotHosts, type RuntimeContext } from "../runtime";
import { runtimeDir } from "../runtime-dir";
import { tunnelMode } from "../tunnel";
import type { RenderedFile } from "../types";
import { deploySecretName, githubEnvironment, healthPath, runnerLabel } from "./shared";
import { type EdgeFiles, rollbackCommands, switchCommands } from "./switch";

function gitlabEnvironmentName(plan: DeployPlan): string {
  return githubEnvironment(plan) ?? "production";
}

function sshPreamble(plan: DeployPlan, sshPort: number): string[] {
  const hostVar = deploySecretName(plan, "SERVER_HOST");
  const keyVar = deploySecretName(plan, "DEPLOY_SSH_KEY");
  const knownVar = deploySecretName(plan, "SSH_KNOWN_HOSTS");
  return [
    "set -eu",
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `if [ -f "$${keyVar}" ]; then cp "$${keyVar}" ~/.ssh/id_deploy; else printf '%s\\n' "$${keyVar}" > ~/.ssh/id_deploy; fi`,
    "chmod 600 ~/.ssh/id_deploy",
    `if [ -f "$${knownVar}" ]; then cp "$${knownVar}" ~/.ssh/known_hosts; else printf '%s\\n' "$${knownVar}" > ~/.ssh/known_hosts; fi`,
    "chmod 644 ~/.ssh/known_hosts",
    `SSH_OPTS="-i ~/.ssh/id_deploy -p ${sshPort} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts"`,
    `DEPLOY_HOST="$${hostVar}"`,
  ];
}

function appImageRef(plan: DeployPlan): string {
  return plan.app.key === undefined ? "$CI_REGISTRY_IMAGE" : `$CI_REGISTRY_IMAGE/${plan.app.key}`;
}

/**
 * Renders `.gitlab-ci.yml` (or `plan.cicd.workflowPath`) for a GitLab CI deployment plan
 * (`plan.cicd.provider === "gitlab-ci"`):
 * - builds and pushes the app image to GitLab Container Registry via `$CI_JOB_TOKEN`;
 * - deploys via SSH (using file-type `$DEPLOY_SSH_KEY`) or directly on a tagged self-hosted GitLab
 *   Runner (`tags: [opscrew-<app>-<env>]`), running OpsCrew's exact server-side switch script;
 * - provides a manual/API `rollback` job;
 * - when `plan.environment?.previews` is set, adds `preview_up` and `preview_down` (`on_stop`)
 *   jobs gated to non-fork merge requests (`$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`)
 *   and invoking the server's recipe-bound `opscrew-preview` standing approval (ADR 0026).
 */
export function renderGitLabPipeline(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
  const app = plan.app.name;
  const branch = plan.cicd.branch;
  const envName = gitlabEnvironmentName(plan);
  const sshPort = ctx.sshPort ?? 22;
  const selfHosted = plan.environment?.runner === "server" || plan.environment?.runner === "host";
  const onServer = plan.environment?.runner === "server";
  const tag = runnerLabel(plan);
  const image = appImageRef(plan);
  const hosts = certbotHosts(plan, ctx);
  const edgeFiles: EdgeFiles = {
    originTls: ctx.originTls !== undefined && !tunnelMode(plan),
    additions: ctx.additions === true,
    certbot: hosts.length > 0 ? { hosts, email: ctx.acmeEmail } : undefined,
    localhost: ctx.localhost,
  };
  const initSteps = initStepsFor(plan);
  const startScript = switchCommands(plan, initSteps, edgeFiles).join("\n");
  const rollbackScript = rollbackCommands(plan, ctx.localhost).join("\n");
  const previews = plan.environment?.previews;
  const dir = runtimeDir(plan);

  const stages = ["build", "deploy", "verify", ...(previews ? ["cleanup"] : [])];
  const workflowRules: Array<Record<string, unknown>> = [
    { if: `$CI_COMMIT_BRANCH == "${branch}"` },
    { if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"' },
    ...(previews
      ? [{ if: "$CI_MERGE_REQUEST_IID && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID" }]
      : []),
  ];

  const buildJob: Record<string, unknown> = {
    stage: "build",
    ...(selfHosted
      ? { tags: [tag] }
      : {
          image: "docker:28-cli",
          services: ["docker:28-dind"],
          variables: { DOCKER_TLS_CERTDIR: "/certs" },
        }),
    rules: [
      { if: '$OPSCREW_MODE == "rollback"', when: "never" },
      { if: `$CI_COMMIT_BRANCH == "${branch}"` },
      { if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"' },
    ],
    script: [
      'printf "%s\\n" "$CI_JOB_TOKEN" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin',
      `docker build --pull -t "${image}:$CI_COMMIT_SHA" .`,
      `docker push "${image}:$CI_COMMIT_SHA"`,
      `DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${image}:$CI_COMMIT_SHA")"`,
      'echo "APP_IMAGE=$DIGEST" > build.env',
    ],
    artifacts: {
      reports: { dotenv: "build.env" },
    },
  };

  const deployScript = onServer
    ? [
        "set -eu",
        `mkdir -p "${appDir(plan)}"`,
        `cp -r "${dir}/." "${appDir(plan)}/"`,
        `cat <<'OPSCREW_SWITCH_EOF' | sh -s -- "$APP_IMAGE"\n${startScript}\nOPSCREW_SWITCH_EOF`,
      ]
    : [
        ...sshPreamble(plan, sshPort),
        `scp -P ${sshPort} -i ~/.ssh/id_deploy -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts -r "${dir}/." "deploy@$DEPLOY_HOST:${appDir(plan)}/"`,
        `cat <<'OPSCREW_SWITCH_EOF' | ssh $SSH_OPTS "deploy@$DEPLOY_HOST" sh -s -- "$APP_IMAGE"\n${startScript}\nOPSCREW_SWITCH_EOF`,
      ];

  const deployJob: Record<string, unknown> = {
    stage: "deploy",
    ...(selfHosted ? { tags: [tag] } : { image: "alpine:3.21" }),
    needs: [{ job: "build", artifacts: true }],
    resource_group: `opscrew-${app}`,
    environment: {
      name: envName,
      ...(plan.dns.domain ? { url: `https://${plan.dns.domain}` } : {}),
    },
    rules: [
      { if: '$OPSCREW_MODE == "rollback"', when: "never" },
      { if: `$CI_COMMIT_BRANCH == "${branch}"` },
      { if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"' },
    ],
    ...(selfHosted ? {} : { before_script: ["apk add --no-cache openssh-client"] }),
    script: deployScript,
  };

  const verifyJob: Record<string, unknown> = {
    stage: "verify",
    image: "curlimages/curl:8.12.1",
    needs: ["deploy"],
    rules: [
      { if: '$OPSCREW_MODE == "rollback"', when: "never" },
      { if: `$CI_COMMIT_BRANCH == "${branch}"` },
      { if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"' },
    ],
    script: [
      plan.dns.domain
        ? `curl -fsS --retry 5 --retry-delay 3 "https://${plan.dns.domain}${healthPath(plan)}" > /dev/null`
        : 'echo "No public domain configured; health check verified by kamal-proxy on the server."',
    ],
  };

  const rollbackJob: Record<string, unknown> = {
    stage: "deploy",
    ...(selfHosted ? { tags: [tag] } : { image: "alpine:3.21" }),
    resource_group: `opscrew-${app}`,
    environment: { name: envName },
    rules: [
      { if: '$OPSCREW_MODE == "rollback"' },
      { if: `$CI_COMMIT_BRANCH == "${branch}"`, when: "manual" },
    ],
    ...(selfHosted ? {} : { before_script: ["apk add --no-cache openssh-client"] }),
    script: onServer
      ? [
          "set -eu",
          `cat <<'OPSCREW_ROLLBACK_EOF' | sh -s -- "\${OPSCREW_ROLLBACK_IMAGE:-}"\n${rollbackScript}\nOPSCREW_ROLLBACK_EOF`,
        ]
      : [
          ...sshPreamble(plan, sshPort),
          `cat <<'OPSCREW_ROLLBACK_EOF' | ssh $SSH_OPTS "deploy@$DEPLOY_HOST" sh -s -- "\${OPSCREW_ROLLBACK_IMAGE:-}"\n${rollbackScript}\nOPSCREW_ROLLBACK_EOF`,
        ],
  };

  const pipeline: Record<string, unknown> = {
    workflow: { rules: workflowRules },
    stages,
    build: buildJob,
    deploy: deployJob,
    verify: verifyJob,
    rollback: rollbackJob,
  };

  if (previews) {
    const mrGuard =
      "$CI_MERGE_REQUEST_IID && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID";
    const previewKeyVar = deploySecretName(plan, "PREVIEW_SSH_KEY");
    const previewHostVar = deploySecretName(plan, "PREVIEW_HOST");
    const previewKnownVar = deploySecretName(plan, "PREVIEW_KNOWN_HOSTS");
    const previewSsh = [
      "set -eu",
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      `if [ -f "$${previewKeyVar}" ]; then cp "$${previewKeyVar}" ~/.ssh/id_preview; else printf '%s\\n' "$${previewKeyVar}" > ~/.ssh/id_preview; fi`,
      "chmod 600 ~/.ssh/id_preview",
      `if [ -f "$${previewKnownVar}" ]; then cp "$${previewKnownVar}" ~/.ssh/known_hosts; else printf '%s\\n' "$${previewKnownVar}" > ~/.ssh/known_hosts; fi`,
      "chmod 644 ~/.ssh/known_hosts",
      `SSH_OPTS="-i ~/.ssh/id_preview -p ${sshPort} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts"`,
    ];

    pipeline.preview_up = {
      stage: "deploy",
      image: "docker:28-cli",
      services: ["docker:28-dind"],
      variables: { DOCKER_TLS_CERTDIR: "/certs" },
      rules: [{ if: mrGuard }],
      environment: {
        name: `review/mr-$CI_MERGE_REQUEST_IID`,
        on_stop: "preview_down",
        auto_stop_in: `${previews.lifetimeDays} days`,
      },
      before_script: ["apk add --no-cache openssh-client"],
      script: [
        ...previewSsh,
        'printf "%s\\n" "$CI_JOB_TOKEN" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin',
        `docker build --pull -t "${image}:mr-$CI_MERGE_REQUEST_IID" .`,
        `docker push "${image}:mr-$CI_MERGE_REQUEST_IID"`,
        `PREVIEW_IMAGE="$(docker inspect --format='{{index .RepoDigests 0}}' "${image}:mr-$CI_MERGE_REQUEST_IID")"`,
        `printf '%s\\n' "$CI_JOB_TOKEN" | ssh $SSH_OPTS "deploy@$${previewHostVar}" "up $CI_MERGE_REQUEST_IID $PREVIEW_IMAGE $CI_COMMIT_SHA"`,
      ],
    };

    pipeline.preview_down = {
      stage: "cleanup",
      image: "alpine:3.21",
      variables: { GIT_STRATEGY: "none" },
      rules: [{ if: mrGuard, when: "manual" }],
      environment: {
        name: `review/mr-$CI_MERGE_REQUEST_IID`,
        action: "stop",
      },
      before_script: ["apk add --no-cache openssh-client"],
      script: [
        ...previewSsh,
        `ssh $SSH_OPTS "deploy@$${previewHostVar}" "down $CI_MERGE_REQUEST_IID"`,
      ],
    };
  }

  return {
    path: plan.cicd.workflowPath,
    kind: "workflow",
    content: `# Generated by OpsCrew — do not put secrets in this file.\n${stringify(pipeline, { lineWidth: 0 })}`,
  };
}
