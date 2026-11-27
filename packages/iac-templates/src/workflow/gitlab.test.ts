// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan, testServices } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderGitLabPipeline } from "./gitlab";
import { renderWorkflow } from "./index";

function gitlabPlan(overrides: Record<string, unknown> = {}) {
  const base = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    cicd: {
      ...base.cicd,
      provider: "gitlab-ci",
      registry: "gitlab-registry",
      workflowPath: undefined,
    },
    ...overrides,
  });
}

describe("GitLab CI pipeline rendering (042)", () => {
  it("renders digest-pinned .gitlab-ci.yml with build args/secrets, env files, origin TLS, and server registry login", () => {
    const base = testPlan({ domain: "shop.example.com" });
    const plan = gitlabPlan({
      app: {
        ...base.app,
        dockerfile: "docker/app.Dockerfile",
        buildContext: "apps/web",
      },
      services: testServices({ postgres: true, redis: true }),
    });
    expect(plan.cicd.workflowPath).toBe(".gitlab-ci.yml");

    const file = renderWorkflow(plan, {
      ...testContext(),
      originTls: { hostnames: ["shop.example.com"] },
      additions: true,
    });
    expect(file.path).toBe(".gitlab-ci.yml");

    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    expect(parsed.stages).toEqual(["build", "deploy", "verify"]);

    // Every job image & service is digest-pinned from pins.ts (zero floating tags).
    expect(parsed.build?.image).toBe(IMAGES.dockerCli.ref);
    expect(parsed.build?.services).toEqual([IMAGES.dockerDind.ref]);
    expect(parsed.deploy?.image).toBe(IMAGES.alpine.ref);
    expect(parsed.verify?.image).toBe(IMAGES.curl.ref);
    expect(parsed.rollback?.image).toBe(IMAGES.alpine.ref);

    // Build uses plan.app.dockerfile, buildContext, OPSCREW_BUILD_ENV, OPSCREW_BUILD_SECRETS, and $CI_JOB_TOKEN.
    const buildScript = ((parsed.build?.script as string[] | undefined) ?? []).join("\n");
    expect(buildScript).toContain("$CI_JOB_TOKEN");
    expect(buildScript).toContain("$CI_REGISTRY_USER");
    expect(buildScript).toContain("-f 'docker/app.Dockerfile'");
    expect(buildScript).toContain("'apps/web'");
    expect(buildScript).toContain("OPSCREW_BUILD_ENV");
    expect(buildScript).toContain("OPSCREW_BUILD_SECRETS");
    expect(buildScript).toContain("--build-arg");
    expect(buildScript).toContain("--secret");

    // Deploy writes app.env, service env files, OPSCREW_ORIGIN_TLS, additions, logs into registry, and logs out on exit.
    expect(parsed.deploy?.resource_group).toBe("opscrew-shop");
    expect(parsed.deploy?.environment).toEqual({
      name: "production",
      url: "https://shop.example.com",
    });
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).toContain("OPSCREW_HOST");
    expect(deployScript).toContain("OPSCREW_SSH_PRIVATE_KEY");
    expect(deployScript).toContain("OPSCREW_SSH_KNOWN_HOSTS");
    expect(deployScript).toContain("OPSCREW_APP_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/app.env");
    expect(deployScript).toContain("OPSCREW_SERVICE_DB_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/db.env");
    expect(deployScript).toContain("OPSCREW_SERVICE_CACHE_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/cache.env");
    expect(deployScript).toContain("OPSCREW_ORIGIN_TLS");
    expect(deployScript).toContain("/srv/edge/tls/shop/origin.pem.new");
    expect(deployScript).toContain("/srv/edge/tls/shop/origin.key.new");
    expect(deployScript).toContain("opscrew/proxy/additions.caddy");
    expect(deployScript).toContain("DOCKER_CONFIG=/srv/apps/shop/.docker docker login");
    expect(deployScript).toContain("DOCKER_CONFIG=/srv/apps/shop/.docker docker logout");
    expect(deployScript).toContain("StrictHostKeyChecking=yes");
    expect(deployScript).toContain("kamal-proxy");
  });

  it("writes release.db.env and worker.db.env when postgres uses separate logins and pgbouncer", () => {
    const [db] = testServices({ postgres: true });
    const plan = gitlabPlan({
      services: [
        {
          ...db,
          options: { logins: "separate", pooler: "pgbouncer" },
        },
      ],
    });
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).toContain("OPSCREW_RELEASE_DB_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/release.db.env");
    expect(deployScript).toContain("OPSCREW_WORKER_DB_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/worker.db.env");
    expect(deployScript).toContain("OPSCREW_SERVICE_DB_ENV");
    expect(deployScript).toContain("cat > /srv/apps/shop/db.env");
  });

  it("respects custom cicd.registryHost and multi-app key in build and deploy", () => {
    const base = testPlan({ domain: "api.example.com" });
    const plan = gitlabPlan({
      app: { ...base.app, key: "api", name: "api" },
      cicd: {
        ...base.cicd,
        provider: "gitlab-ci",
        registry: "gitlab-registry",
        registryHost: "registry.company.internal",
        workflowPath: undefined,
      },
    });
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    const buildScript = ((parsed.build?.script as string[] | undefined) ?? []).join("\n");
    expect(buildScript).toContain("REGISTRY_HOST='registry.company.internal'");
    expect(buildScript).toContain('APP_IMAGE_BASE="${REGISTRY_HOST}/${PROJECT_PATH_LOWER}/api"');
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).toContain("REGISTRY_HOST='registry.company.internal'");
  });

  it("tags jobs for the server's self-hosted GitLab Runner and skips SSH when runner is server", () => {
    const base = testPlan({ domain: "staging.example.com" });
    const plan = gitlabPlan({
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging", runner: "server" },
    });
    expect(plan.cicd.workflowPath).toBe(".gitlab/opscrew-deploy-staging.yml");
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;

    expect(parsed.build?.tags).toEqual(["opscrew-shop-staging"]);
    expect(parsed.deploy?.tags).toEqual(["opscrew-shop-staging"]);
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).not.toContain("StrictHostKeyChecking");
    expect(deployScript).toContain("/srv/apps/shop-staging");
    expect(deployScript).toContain("OPSCREW_STAGING_APP_ENV");
    expect(deployScript).toContain("DOCKER_CONFIG=/srv/apps/shop-staging/.docker docker login");
  });

  it("renders merge-request preview_up and preview_down (on_stop) excluding forks with pinned images (ADR 0026)", () => {
    const base = testPlan();
    const plan = gitlabPlan({
      app: { ...base.app, name: "shop-preview" },
      dns: { provider: "cloudflare", zone: "example.com", proxied: true },
      environment: {
        name: "preview",
        previews: {
          domain: "preview.example.com",
          lifetimeDays: 7,
        },
      },
    });
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    expect(parsed.stages).toEqual(["build", "deploy", "verify", "cleanup"]);
    expect(parsed.preview_up?.image).toBe(IMAGES.dockerCli.ref);
    expect(parsed.preview_up?.services).toEqual([IMAGES.dockerDind.ref]);
    expect(parsed.preview_down?.image).toBe(IMAGES.alpine.ref);

    // Fork guard: source project must equal target project.
    expect(JSON.stringify(parsed.preview_up?.rules)).toContain(
      "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID",
    );
    expect(parsed.preview_up?.environment).toEqual({
      name: "review/mr-$CI_MERGE_REQUEST_IID",
      on_stop: "preview_down",
      auto_stop_in: "7 days",
    });
    expect(parsed.preview_down?.environment).toEqual({
      name: "review/mr-$CI_MERGE_REQUEST_IID",
      action: "stop",
    });
    const upScript = ((parsed.preview_up?.script as string[] | undefined) ?? []).join("\n");
    expect(upScript).toContain("OPSCREW_PREVIEW_HOST");
    expect(upScript).toContain("OPSCREW_PREVIEW_SSH_PRIVATE_KEY");
    expect(upScript).toContain("up $CI_MERGE_REQUEST_IID $PREVIEW_IMAGE $CI_COMMIT_SHA");
    const downScript = ((parsed.preview_down?.script as string[] | undefined) ?? []).join("\n");
    expect(downScript).toContain("down $CI_MERGE_REQUEST_IID");
  });

  it("refuses non-VPS targets if renderGitLabPipeline is invoked directly", () => {
    const plan = {
      ...testPlan({ domain: "shop.example.com" }),
      target: {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 1,
        arch: "amd64",
        redeploy: "updater",
        web: { kind: "direct" },
      },
    } as unknown as DeployPlan;
    expect(() => renderGitLabPipeline(plan, testContext())).toThrow(/cloud server and own-server/);
  });

  it("keeps GitHub Actions workflows completely unchanged", () => {
    const gh = testPlan({ domain: "shop.example.com" });
    expect(gh.cicd.provider).toBe("github-actions");
    expect(gh.cicd.workflowPath).toBe(".github/workflows/opscrew-deploy.yml");
    const file = renderWorkflow(gh, testContext());
    expect(file.path).toBe(".github/workflows/opscrew-deploy.yml");
    expect(file.content).toContain("runs-on:");
  });
});
