import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, detectProjectDetails } from "./index";
import { makeTree, removeTree, writeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "workspace");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const json = (value: unknown) => JSON.stringify(value);

/**
 * A pnpm workspace with two sites and shared packages: the landing site uses `@acme/ui`
 * (`workspace:*`), which uses `@acme/tokens` (`workspace:^`); the docs site uses only the build
 * config package `@acme/config` (a development dependency). `@acme/unused` is used by no one.
 */
const PNPM_WORKSPACE = {
  "package.json": json({ name: "acme", private: true, packageManager: "pnpm@10.18.0" }),
  "pnpm-workspace.yaml": "packages:\n  - sites/*\n  - packages/*\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "sites/landing/package.json": json({
    name: "landing",
    scripts: { build: "vite build" },
    dependencies: { "@acme/ui": "workspace:*", react: "^19.2.0" },
    devDependencies: { vite: "^7.1.0" },
  }),
  "sites/landing/index.html": "<!doctype html><title>Landing</title>",
  "sites/docs/package.json": json({
    name: "docs",
    scripts: { build: "astro build" },
    dependencies: { astro: "^5.14.0" },
    devDependencies: { "@acme/config": "workspace:*" },
  }),
  "packages/ui/package.json": json({
    name: "@acme/ui",
    dependencies: { "@acme/tokens": "workspace:^", react: "^19.2.0" },
  }),
  "packages/tokens/package.json": json({ name: "@acme/tokens" }),
  "packages/config/package.json": json({ name: "@acme/config" }),
  "packages/unused/package.json": json({ name: "@acme/unused" }),
};

describe("the workspace packages an app's build uses", () => {
  it("records a pnpm workspace member's local packages, transitively and sorted", async () => {
    const root = await tree(PNPM_WORKSPACE);
    const landing = await detectProject(root, { appDir: "sites/landing" });
    expect(landing.workspacePackages).toEqual(["packages/tokens", "packages/ui"]);
    // Development dependencies are installed and used by the build too.
    const docs = await detectProject(root, { appDir: "sites/docs" });
    expect(docs.workspacePackages).toEqual(["packages/config"]);
  });

  it("records the packages an npm or Yarn workspace member names by their name alone", async () => {
    const root = await tree({
      "package.json": json({ name: "acme", workspaces: ["apps/*", "libs/*"] }),
      "package-lock.json": "{}",
      "apps/web/package.json": json({
        name: "web",
        scripts: { build: "vite build" },
        dependencies: { "@acme/shared": "^1.0.0", vite: "^7.1.0" },
      }),
      "apps/web/index.html": "<!doctype html><title>Web</title>",
      "libs/shared/package.json": json({
        name: "@acme/shared",
        version: "1.0.0",
        dependencies: { "@acme/core": "*" },
      }),
      "libs/core/package.json": json({ name: "@acme/core", version: "1.0.0" }),
    });
    const facts = await detectProject(root, { appDir: "apps/web" });
    expect(facts.workspacePackages).toEqual(["libs/core", "libs/shared"]);
  });

  it("records the packages a dependency names through a workspace: or npm: alias", async () => {
    const root = await tree({
      ...PNPM_WORKSPACE,
      "sites/landing/package.json": json({
        name: "landing",
        scripts: { build: "vite build" },
        dependencies: { ui: "workspace:@acme/ui@*", vite: "^7.1.0" },
        devDependencies: { cfg: "npm:@acme/config@^1.0.0" },
      }),
    });
    const landing = await detectProject(root, { appDir: "sites/landing" });
    expect(landing.workspacePackages).toEqual([
      "packages/config",
      "packages/tokens",
      "packages/ui",
    ]);
  });

  it("records none for an app without workspace packages, outside a workspace or in another ecosystem", async () => {
    const root = await tree(PNPM_WORKSPACE);
    // The root of the workspace uses none of its packages.
    const { facts } = await detectProjectDetails(root, { appDir: "." });
    expect(facts.workspacePackages).toBeUndefined();
    const single = await tree({
      "package.json": json({
        name: "shop",
        scripts: { build: "vite build" },
        dependencies: { "@acme/ui": "^1.0.0", vite: "^7.1.0" },
      }),
      "vendor/ui/package.json": json({ name: "@acme/ui" }),
      "index.html": "<!doctype html><title>Shop</title>",
    });
    expect((await detectProject(single)).workspacePackages).toBeUndefined();
    const python = await tree({
      "pyproject.toml": '[project]\nname = "api"\ndependencies = ["fastapi"]\n',
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    });
    expect((await detectProject(python)).workspacePackages).toBeUndefined();
  });
});

describe("the variables of an app in a folder", () => {
  it("come from the app's folder and its workspace packages, never the repository's scripts or other apps", async () => {
    const root = await tree({
      ...PNPM_WORKSPACE,
      "sites/landing/src/main.js": "const url = import.meta.env.VITE_SITE_URL;\n",
      "sites/landing/.env.example": "VITE_CONTACT_EMAIL=\n",
      "packages/ui/src/index.js": "export const cdn = process.env.UI_CDN_URL;\n",
      "sites/docs/src/search.mjs": "export const key = process.env.DOCS_SEARCH_KEY;\n",
      // The repository's own scripts (screenshots, a docs sync), and its root example file.
      "scripts/screenshots.mjs":
        "const browser = process.env.BROWSER_PATH;\nconst channel = process.env.BROWSER_CHANNEL;\n",
      "scripts/sync-docs.mjs": "const dir = process.env.OPSCREW_GUIDE_DIR;\n",
      ".env.example": "SITE_ORIGIN=\n",
    });
    // The root's committed env files are the first app's; the code in the root's folders is not.
    const landing = await detectProject(root, { appDir: "sites/landing" });
    expect(landing.envVars.map((variable) => variable.name)).toEqual([
      "SITE_ORIGIN",
      "UI_CDN_URL",
      "VITE_CONTACT_EMAIL",
      "VITE_SITE_URL",
    ]);
    // A further app reads neither.
    const docs = await detectProject(root, { appDir: "sites/docs", rootEnvFiles: false });
    expect(docs.envVars.map((variable) => variable.name)).toEqual(["DOCS_SEARCH_KEY"]);
    // The repository's root app reads the whole repository, its scripts and root files included.
    const { facts } = await detectProjectDetails(root, { appDir: "." });
    expect(facts.envVars.map((variable) => variable.name)).toEqual(
      expect.arrayContaining([
        "BROWSER_CHANNEL",
        "BROWSER_PATH",
        "OPSCREW_GUIDE_DIR",
        "SITE_ORIGIN",
      ]),
    );
  });

  it("come from its shared paths too", async () => {
    const root = await tree({
      ...PNPM_WORKSPACE,
      "config/site.mjs": "export const origin = process.env.SITE_ORIGIN;\n",
      "sites/landing/src/main.js": "const url = import.meta.env.VITE_SITE_URL;\n",
    });
    const landing = await detectProject(root, {
      appDir: "sites/landing",
      sharedPaths: ["config/site.mjs"],
    });
    expect(landing.envVars.map((variable) => variable.name)).toEqual([
      "SITE_ORIGIN",
      "VITE_SITE_URL",
    ]);
  });

  it("come from a workspace package the app uses, even one that looks like an app itself", async () => {
    const root = await tree({
      "package.json": json({ name: "acme", private: true, packageManager: "pnpm@10.18.0" }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "apps/web/package.json": json({
        name: "web",
        scripts: { start: "node server.js" },
        dependencies: { "@acme/db": "workspace:*", express: "^5.1.0" },
      }),
      "apps/web/server.js": "const app = require('express')();\napp.listen(process.env.PORT);\n",
      "packages/db/package.json": json({
        name: "@acme/db",
        dependencies: { express: "^5.1.0", pg: "^8.16.0" },
      }),
      "packages/db/src/index.js": "export const url = process.env.DATABASE_URL;\n",
    });
    const web = await detectProject(root, { appDir: "apps/web" });
    expect(web.workspacePackages).toEqual(["packages/db"]);
    expect(web.envVars.map((variable) => variable.name)).toContain("DATABASE_URL");
    expect(web.services.map((service) => service.kind)).toContain("postgres");
  });
});

/**
 * The workspace of the 0.2.8 report: a root `.env.example` for the whole repository, a server app
 * on PostgreSQL with no start script, a React app, and a Vite app (`apps/pay`) that reads its three
 * `VITE_` settings through `loadEnv` in `vite.config.ts` and a file it imports.
 */
const THREE_APPS = fileURLToPath(new URL("../test/fixtures/monorepo-three-apps/", import.meta.url));

describe("an app beside other apps in a workspace (the 0.2.8 report)", () => {
  const client = { clientExposed: true, secretLikely: false };
  const ownFacts = {
    envVars: [
      { name: "VITE_BASE_PATH", files: ["apps/pay/vite.config.ts"], ...client },
      { name: "VITE_CHECKOUT_URL", files: ["apps/pay/config/checkout.ts"], ...client },
      { name: "VITE_SHOP_ID", files: ["apps/pay/config/checkout.ts"], ...client },
    ],
    services: [],
    frameworks: [{ name: "vite", version: "^7.1.0", path: "apps/pay" }],
  };

  it("holds only its own variables, services and frameworks", async () => {
    const pay = { appDir: "apps/pay", rootEnvFiles: false };
    expect(await detectProject(THREE_APPS, pay)).toMatchObject(ownFacts);
    // As the first app, it would also read the root's .env.example.
    const first = await detectProject(THREE_APPS, { appDir: "apps/pay" });
    expect(first.envVars.map((variable) => variable.name)).toEqual([
      "APP_ORIGIN",
      "DATABASE_URL",
      "MAIL_FROM",
      "SESSION_SECRET",
      "VITE_BASE_PATH",
      "VITE_CHECKOUT_URL",
      "VITE_SHOP_ID",
    ]);
  });

  it("holds none of another app's, even beside the one deployable server", async () => {
    // A start script makes the server the workspace's one deployable server.
    const root = await tree({});
    await cp(THREE_APPS, root, { recursive: true });
    await writeTree(root, {
      "apps/server/package.json": json({
        name: "server",
        scripts: { start: "node dist/index.js" },
        dependencies: { pg: "^8.16.0" },
      }),
    });
    expect(await detectProject(root, { appDir: "apps/pay", rootEnvFiles: false })).toMatchObject(
      ownFacts,
    );
  });

  it("leaves the app at the repository root reading the whole repository", async () => {
    // expected.json holds the root's facts in full.
    const { facts, appCandidates } = await detectProjectDetails(THREE_APPS);
    expect(facts.appDir).toBe(".");
    expect(appCandidates).toEqual(["apps/pay", "apps/web"]);
    expect(facts.services.map((service) => service.kind)).toEqual(["postgres"]);
  });
});
