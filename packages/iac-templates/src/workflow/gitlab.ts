// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitLab CI syntax, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  isCloudTarget,
  servicesOn,
  snapshotOffsiteOf,
} from "@opscrew/plan-schema";
import { stringify } from "yaml";
import { initStepsFor } from "../catalog";
import { additionsPath, appDir, EDGE_DIR } from "../edge";
import { IMAGES } from "../pins";
import { certbotHosts, type RuntimeContext, renderRuntimeFiles } from "../runtime";
import { shellQuote } from "../runtime/services";
import { runtimeDir } from "../runtime-dir";
import { tunnelMode } from "../tunnel";
import type { RenderedFile } from "../types";
import {
  DEPLOY_SECRETS,
  deploySecretName,
  githubEnvironment,
  hasReleaseDbEnv,
  hasWorkerDbEnv,
  healthPath,
  imageSubpath,
  RELEASE_DB_ENV,
  runnerLabel,
  serviceEnvSecret,
  WORKER_DB_ENV,
} from "./shared";
import { OFFSITE_ENV_FILE, OFFSITE_ENV_SECRET } from "./snapshot-script";
import { snapshotParts } from "./snapshots";
import { dockerConfig, type EdgeFiles, rollbackCommands, switchCommands } from "./switch";

interface GitLabEnvFile {
  file: string;
  variable: string;
}

function gitlabEnvironmentName(plan: DeployPlan): string {
  return githubEnvironment(plan) ?? "production";
}

function readVar(varName: string): string {
  return `if [ -f "\${${varName}:-}" ]; then cat "\${${varName}}"; else printf '%s\\n' "\${${varName}:-}"; fi`;
}

function sshPreamble(plan: DeployPlan, sshPort: number): string[] {
  const hostVar = deploySecretName(plan, DEPLOY_SECRETS.host);
  const keyVar = deploySecretName(plan, DEPLOY_SECRETS.sshKey);
  const knownVar = deploySecretName(plan, DEPLOY_SECRETS.knownHosts);
  return [
    "set -eu",
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `if [ -f "\${${keyVar}:-}" ]; then cp "\${${keyVar}}" ~/.ssh/id_deploy; else printf '%s\\n' "\${${keyVar}:-}" > ~/.ssh/id_deploy; fi`,
    "chmod 600 ~/.ssh/id_deploy",
    `if [ -f "\${${knownVar}:-}" ]; then cp "\${${knownVar}}" ~/.ssh/known_hosts; else printf '%s\\n' "\${${knownVar}:-}" > ~/.ssh/known_hosts; fi`,
    "chmod 644 ~/.ssh/known_hosts",
    `SSH_OPTS="-i ~/.ssh/id_deploy -p ${sshPort} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts"`,
    `DEPLOY_HOST="$(${readVar(hostVar)} | tr -d '\\r\\n')"`,
  ];
}

function registrySetup(plan: DeployPlan): string[] {
  const customHost = plan.cicd.registryHost?.trim();
  const subpath = imageSubpath(plan);
  if (customHost && customHost.length > 0) {
    return [
      `REGISTRY_HOST=${shellQuote(customHost)}`,
      `PROJECT_PATH_LOWER="$(printf '%s' "$CI_PROJECT_PATH" | tr '[:upper:]' '[:lower:]')"`,
      `APP_IMAGE_BASE="\${REGISTRY_HOST}/\${PROJECT_PATH_LOWER}${subpath}"`,
    ];
  }
  return ['REGISTRY_HOST="$CI_REGISTRY"', `APP_IMAGE_BASE="$CI_REGISTRY_IMAGE${subpath}"`];
}

function gitlabEnvFiles(plan: DeployPlan): GitLabEnvFile[] {
  const files: GitLabEnvFile[] = [
    { file: "app.env", variable: deploySecretName(plan, DEPLOY_SECRETS.appEnv) },
  ];
  if (hasReleaseDbEnv(plan)) {
    files.push({
      file: RELEASE_DB_ENV.file,
      variable: deploySecretName(plan, RELEASE_DB_ENV.secret),
    });
  }
  if (hasWorkerDbEnv(plan)) {
    files.push({
      file: WORKER_DB_ENV.file,
      variable: deploySecretName(plan, WORKER_DB_ENV.secret),
    });
  }
  for (const service of servicesOn(plan, APP_SERVER)) {
    files.push({
      file: `${service.name}.env`,
      variable: deploySecretName(plan, serviceEnvSecret(service.name)),
    });
  }
  if (snapshotOffsiteOf(plan) !== undefined && snapshotParts(plan, APP_SERVER).length > 0) {
    files.push({
      file: OFFSITE_ENV_FILE,
      variable: deploySecretName(plan, OFFSITE_ENV_SECRET),
    });
  }
  return files;
}

function runtimeUploadPaths(plan: DeployPlan, includeAdditions: boolean): string[] {
  const dir = runtimeDir(plan);
  const top = renderRuntimeFiles(plan).map(
    (file) => `${dir}/${file.path.slice(dir.length + 1).split("/")[0]}`,
  );
  return [
    `${dir}/compose.yaml`,
    ...new Set(top),
    ...(includeAdditions ? [additionsPath(plan)] : []),
  ];
}

function dockerBuildLines(plan: DeployPlan, imageTag: string): string[] {
  const dockerfile = plan.app.dockerfile || "Dockerfile";
  const context = plan.app.buildContext || ".";
  const buildEnvVar = deploySecretName(plan, DEPLOY_SECRETS.buildEnv);
  const buildSecretsVar = deploySecretName(plan, DEPLOY_SECRETS.buildSecrets);
  return [
    "export DOCKER_BUILDKIT=1",
    'BUILD_SECRETS_DIR="$(umask 077 && mktemp -d)"',
    'chmod 700 "$BUILD_SECRETS_DIR"',
    'cleanup_build_secrets() { rm -rf "$BUILD_SECRETS_DIR"; }',
    "trap cleanup_build_secrets EXIT",
    "set --",
    `if [ -n "\${${buildEnvVar}:-}" ]; then`,
    `  (umask 077 && (${readVar(buildEnvVar)}) > "$BUILD_SECRETS_DIR/_env")`,
    '  while IFS= read -r line || [ -n "$line" ]; do',
    '    case "$line" in',
    '      "" | "#"*) continue ;;',
    "      *=*)",
    '        arg_key="${line%%=*}"',
    '        case "$arg_key" in',
    '          "" | [0-9]* | *[!A-Za-z0-9_]*) echo "Invalid build arg name: $arg_key" >&2; exit 1 ;;',
    "        esac",
    '        set -- "$@" --build-arg "$line"',
    "        ;;",
    "    esac",
    '  done < "$BUILD_SECRETS_DIR/_env"',
    "fi",
    `if [ -n "\${${buildSecretsVar}:-}" ]; then`,
    `  (umask 077 && (${readVar(buildSecretsVar)}) > "$BUILD_SECRETS_DIR/_secrets")`,
    '  while IFS= read -r line || [ -n "$line" ]; do',
    '    case "$line" in',
    '      "" | "#"*) continue ;;',
    "      *=*)",
    '        secret_key="${line%%=*}"',
    '        secret_val="${line#*=}"',
    '        case "$secret_key" in',
    '          "" | [0-9]* | *[!A-Za-z0-9_]*) echo "Invalid build secret name: $secret_key" >&2; exit 1 ;;',
    "        esac",
    '        (umask 077 && printf \'%s\' "$secret_val" > "$BUILD_SECRETS_DIR/$secret_key")',
    '        chmod 600 "$BUILD_SECRETS_DIR/$secret_key"',
    '        set -- "$@" --secret "id=$secret_key,src=$BUILD_SECRETS_DIR/$secret_key"',
    "        ;;",
    "    esac",
    '  done < "$BUILD_SECRETS_DIR/_secrets"',
    "fi",
    `docker build --pull -f ${shellQuote(dockerfile)} "$@" -t "${imageTag}" ${shellQuote(context)}`,
  ];
}

function originTlsWriteLines(plan: DeployPlan, on: (cmd: string) => string): string[] {
  const originVar = deploySecretName(plan, DEPLOY_SECRETS.originTls);
  const tlsDir = `${EDGE_DIR}/tls/${plan.app.name}`;
  return [
    `ORIGIN_TLS_CONTENT="$(${readVar(originVar)})"`,
    'case "$ORIGIN_TLS_CONTENT" in',
    '  *"-----BEGIN CERTIFICATE-----"*"PRIVATE KEY-----"*) ;;',
    `  *) echo "Missing or invalid ${originVar} (expected origin certificate and private key PEM)" >&2; exit 1 ;;`,
    "esac",
    `printf '%s\\n' "$ORIGIN_TLS_CONTENT" | sed '/-BEGIN [A-Z ]*PRIVATE KEY-/,$d' | ${on(`umask 077 && mkdir -p ${tlsDir} && chmod 700 ${tlsDir} && cat > ${tlsDir}/origin.pem.new`)}`,
    `printf '%s\\n' "$ORIGIN_TLS_CONTENT" | sed -n '/-BEGIN [A-Z ]*PRIVATE KEY-/,$p' | ${on(`umask 077 && cat > ${tlsDir}/origin.key.new`)}`,
  ];
}

/**
 * Renders `.gitlab-ci.yml` (or `plan.cicd.workflowPath`) for a GitLab CI VPS deployment plan
 * (`plan.cicd.provider === "gitlab-ci"`):
 * - uses digest-pinned images from `pins.ts` (zero floating tags);
 * - builds from `plan.app.dockerfile` and `plan.app.buildContext` with `OPSCREW_BUILD_ENV`
 *   build arguments and `OPSCREW_BUILD_SECRETS` BuildKit secret mounts, pushing to GitLab
 *   Container Registry (or `plan.cicd.registryHost`) via `$CI_JOB_TOKEN`;
 * - uploads runtime files, `app.env`, service `.env` files, `release.db.env` / `worker.db.env`,
 *   `offsite.env`, and `OPSCREW_ORIGIN_TLS` (when configured), logs into the registry on the
 *   target server inside the app's `DOCKER_CONFIG`, runs OpsCrew's server-side switch script,
 *   and logs out on exit;
 * - provides a manual/API `rollback` job;
 * - when `plan.environment?.previews` is set, adds `preview_up` and `preview_down` (`on_stop`)
 *   jobs gated to non-fork merge requests (`$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`)
 *   and invoking the server's recipe-bound `opscrew-preview` standing approval (ADR 0026).
 */
export function renderGitLabPipeline(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
  if (!isCloudTarget(plan.target) && plan.target.provider !== "own") {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `GitLab CI pipelines currently support only cloud server and own-server targets (got "${plan.target.provider}").`,
    );
  }
  const app = plan.app.name;
  const branch = plan.cicd.branch;
  const envName = gitlabEnvironmentName(plan);
  const sshPort = ctx.sshPort ?? 22;
  const selfHosted = plan.environment?.runner === "server" || plan.environment?.runner === "host";
  const onServer = plan.environment?.runner === "server";
  const tag = runnerLabel(plan);
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
  const targetDir = appDir(plan);
  const targetDockerConfig = dockerConfig(plan);
  const uploadPaths = runtimeUploadPaths(plan, edgeFiles.additions);
  const envFiles = gitlabEnvFiles(plan);

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
          image: IMAGES.dockerCli.ref,
          services: [IMAGES.dockerDind.ref],
          variables: { DOCKER_TLS_CERTDIR: "/certs" },
        }),
    rules: [
      { if: '$OPSCREW_MODE == "rollback"', when: "never" },
      { if: `$CI_COMMIT_BRANCH == "${branch}"` },
      { if: '$CI_PIPELINE_SOURCE == "web" || $CI_PIPELINE_SOURCE == "api"' },
    ],
    script: [
      "set -eu",
      ...registrySetup(plan),
      'printf "%s\\n" "$CI_JOB_TOKEN" | docker login "$REGISTRY_HOST" -u "$CI_REGISTRY_USER" --password-stdin',
      ...dockerBuildLines(plan, "${APP_IMAGE_BASE}:$CI_COMMIT_SHA"),
      'docker push "${APP_IMAGE_BASE}:$CI_COMMIT_SHA"',
      'DIGEST="$(docker inspect --format=\'{{index .RepoDigests 0}}\' "${APP_IMAGE_BASE}:$CI_COMMIT_SHA")"',
      'echo "APP_IMAGE=$DIGEST" > build.env',
    ],
    artifacts: {
      reports: { dotenv: "build.env" },
    },
  };

  const onLocal = (cmd: string) => `(${cmd})`;
  const onSsh = (cmd: string) => `ssh $SSH_OPTS "deploy@$DEPLOY_HOST" '${cmd}'`;
  const onTarget = onServer ? onLocal : onSsh;

  const envWriteLines = envFiles.map(
    ({ file, variable }) =>
      `(${readVar(variable)}) | ${onTarget(`umask 077 && cat > ${targetDir}/${file}`)}`,
  );
  const originTlsLines = edgeFiles.originTls ? originTlsWriteLines(plan, onTarget) : [];
  const savePreviousLine = onTarget(
    `cd ${targetDir} && rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous; fi`,
  );
  const serverLoginLine = onServer
    ? `umask 077 && mkdir -p ${targetDockerConfig} && chmod 700 ${targetDockerConfig} && printf '%s\\n' "$CI_JOB_TOKEN" | DOCKER_CONFIG=${targetDockerConfig} docker login "$REGISTRY_HOST" -u "$CI_REGISTRY_USER" --password-stdin`
    : `printf '%s\\n' "$CI_JOB_TOKEN" | ssh $SSH_OPTS "deploy@$DEPLOY_HOST" "umask 077 && mkdir -p ${targetDockerConfig} && chmod 700 ${targetDockerConfig} && DOCKER_CONFIG=${targetDockerConfig} docker login '$REGISTRY_HOST' -u '$CI_REGISTRY_USER' --password-stdin"`;
  const serverLogoutFunc = onServer
    ? `cleanup_logout() { DOCKER_CONFIG=${targetDockerConfig} docker logout "$REGISTRY_HOST" > /dev/null 2>&1 || true; }`
    : `cleanup_logout() { ssh $SSH_OPTS "deploy@$DEPLOY_HOST" "DOCKER_CONFIG=${targetDockerConfig} docker logout '$REGISTRY_HOST' > /dev/null 2>&1 || true" || true; }`;

  const deployScript = onServer
    ? [
        "set -eu",
        ...registrySetup(plan),
        `mkdir -p ${shellQuote(targetDir)}`,
        `cp -r ${uploadPaths.map(shellQuote).join(" ")} ${shellQuote(`${targetDir}/`)}`,
        ...envWriteLines,
        ...originTlsLines,
        savePreviousLine,
        serverLogoutFunc,
        serverLoginLine,
        "trap cleanup_logout EXIT",
        `cat <<'OPSCREW_SWITCH_EOF' | sh -s -- "$APP_IMAGE"\n${startScript}\nOPSCREW_SWITCH_EOF`,
      ]
    : [
        ...sshPreamble(plan, sshPort),
        ...registrySetup(plan),
        onSsh(`mkdir -p ${targetDir}`),
        `scp -P ${sshPort} -i ~/.ssh/id_deploy -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts -r ${uploadPaths.map(shellQuote).join(" ")} "deploy@$DEPLOY_HOST:${targetDir}/"`,
        ...envWriteLines,
        ...originTlsLines,
        savePreviousLine,
        serverLogoutFunc,
        serverLoginLine,
        "trap cleanup_logout EXIT",
        `cat <<'OPSCREW_SWITCH_EOF' | ssh $SSH_OPTS "deploy@$DEPLOY_HOST" sh -s -- "$APP_IMAGE"\n${startScript}\nOPSCREW_SWITCH_EOF`,
      ];

  const deployJob: Record<string, unknown> = {
    stage: "deploy",
    ...(selfHosted ? { tags: [tag] } : { image: IMAGES.alpine.ref }),
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
    image: IMAGES.curl.ref,
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
    ...(selfHosted ? { tags: [tag] } : { image: IMAGES.alpine.ref }),
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
    const previewSsh = sshPreamble(plan, sshPort);

    pipeline.preview_up = {
      stage: "deploy",
      image: IMAGES.dockerCli.ref,
      services: [IMAGES.dockerDind.ref],
      variables: { DOCKER_TLS_CERTDIR: "/certs" },
      rules: [{ if: mrGuard }],
      environment: {
        name: "review/mr-$CI_MERGE_REQUEST_IID",
        on_stop: "preview_down",
        auto_stop_in: `${previews.lifetimeDays} days`,
      },
      before_script: ["apk add --no-cache openssh-client"],
      script: [
        ...previewSsh,
        ...registrySetup(plan),
        'printf "%s\\n" "$CI_JOB_TOKEN" | docker login "$REGISTRY_HOST" -u "$CI_REGISTRY_USER" --password-stdin',
        ...dockerBuildLines(plan, "${APP_IMAGE_BASE}:mr-$CI_MERGE_REQUEST_IID"),
        'docker push "${APP_IMAGE_BASE}:mr-$CI_MERGE_REQUEST_IID"',
        'PREVIEW_IMAGE="$(docker inspect --format=\'{{index .RepoDigests 0}}\' "${APP_IMAGE_BASE}:mr-$CI_MERGE_REQUEST_IID")"',
        'printf \'%s\\n\' "$CI_JOB_TOKEN" | ssh $SSH_OPTS "deploy@$DEPLOY_HOST" "up $CI_MERGE_REQUEST_IID $PREVIEW_IMAGE $CI_COMMIT_SHA"',
      ],
    };

    pipeline.preview_down = {
      stage: "cleanup",
      image: IMAGES.alpine.ref,
      variables: { GIT_STRATEGY: "none" },
      rules: [{ if: mrGuard, when: "manual" }],
      environment: {
        name: "review/mr-$CI_MERGE_REQUEST_IID",
        action: "stop",
      },
      before_script: ["apk add --no-cache openssh-client"],
      script: [...previewSsh, 'ssh $SSH_OPTS "deploy@$DEPLOY_HOST" "down $CI_MERGE_REQUEST_IID"'],
    };
  }

  return {
    path: plan.cicd.workflowPath,
    kind: "workflow",
    content: `# Generated by OpsCrew — do not put secrets in this file.\n${stringify(pipeline, { lineWidth: 0 })}`,
  };
}
