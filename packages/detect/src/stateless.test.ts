import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const dirs: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const dir = await makeTree(files, "stateless");
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) await removeTree(dirs.pop() as string);
});

describe("detectStatelessIssues — Laravel / PHP", () => {
  const composerBase = (extra: Record<string, string> = {}) =>
    JSON.stringify({
      name: "acme/laravel-app",
      require: { php: "^8.3", "laravel/framework": "^11.0", ...extra },
    });

  it("flags SESSION_DRIVER=file and FILESYSTEM_DISK=local|public in .env.example", async () => {
    const dir = await tree({
      "composer.json": composerBase(),
      ".env.example": "APP_NAME=Shop\nSESSION_DRIVER=file\nFILESYSTEM_DISK=local\n",
    });
    const facts = await detectProject(dir);
    expect(facts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "laravel",
        evidence: "SESSION_DRIVER=file",
        file: ".env.example",
      }),
      expect.objectContaining({
        kind: "local-uploads",
        framework: "laravel",
        evidence: "FILESYSTEM_DISK=local",
        file: ".env.example",
      }),
    ]);

    const pubDir = await tree({
      "composer.json": composerBase(),
      ".env.example": "SESSION_DRIVER=redis\nFILESYSTEM_DISK=public\n",
    });
    const pubFacts = await detectProject(pubDir);
    expect(pubFacts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-uploads",
        framework: "laravel",
        evidence: "FILESYSTEM_DISK=public",
        file: ".env.example",
      }),
    ]);
  });

  it("flags config/session.php and config/filesystems.php local defaults when .env.example omits them", async () => {
    const dir = await tree({
      "composer.json": composerBase(),
      "config/session.php": "<?php return ['driver' => env('SESSION_DRIVER', 'file')];\n",
      "config/filesystems.php": "<?php return ['default' => env('FILESYSTEM_DISK', 'local')];\n",
    });
    const facts = await detectProject(dir);
    expect(facts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "laravel",
        evidence: "SESSION_DRIVER=file",
        file: "config/session.php",
      }),
      expect.objectContaining({
        kind: "local-uploads",
        framework: "laravel",
        evidence: "FILESYSTEM_DISK=local",
        file: "config/filesystems.php",
      }),
    ]);
  });

  it("omits statelessIssues for safe Redis/database/cookie sessions and Flysystem S3 uploads", async () => {
    for (const driver of ["redis", "database", "cookie"]) {
      const dir = await tree({
        "composer.json": composerBase({ "league/flysystem-aws-s3-v3": "^3.0" }),
        ".env.example": `SESSION_DRIVER=${driver}\nFILESYSTEM_DISK=local\n`,
        "config/session.php": "<?php return ['driver' => env('SESSION_DRIVER', 'file')];\n",
      });
      const facts = await detectProject(dir);
      expect(facts.statelessIssues).toBeUndefined();
    }
  });
});

describe("detectStatelessIssues — Express / Node.js", () => {
  const pkg = (deps: Record<string, string>) =>
    JSON.stringify({ name: "api", dependencies: { express: "^4.19.0", ...deps } });

  it("flags express-session without a shared store and multer diskStorage/dest without S3", async () => {
    const dir = await tree({
      "package.json": pkg({ "express-session": "^1.18.0", multer: "^1.4.5" }),
      "src/upload.ts":
        "import multer from 'multer';\nconst storage = multer.diskStorage({ destination: '/tmp' });\n",
    });
    const facts = await detectProject(dir);
    expect(facts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "express",
        evidence: "dependency:express-session (without shared session store)",
        file: "package.json",
      }),
      expect.objectContaining({
        kind: "local-uploads",
        framework: "express",
        evidence: "multer.diskStorage",
        file: "src/upload.ts",
      }),
    ]);

    const destDir = await tree({
      "package.json": pkg({ multer: "^1.4.5" }),
      "src/server.js":
        "const multer = require('multer');\nconst upload = multer({ limits: { fileSize: 1024 }, dest: 'uploads/' });\n",
    });
    const destFacts = await detectProject(destDir);
    expect(destFacts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-uploads",
        framework: "express",
        evidence: "multer({ dest })",
        file: "src/server.js",
      }),
    ]);
  });

  it("omits statelessIssues when shared session stores or S3 upload packages are installed", async () => {
    for (const store of ["connect-redis", "connect-pg-simple", "connect-mongo", "cookie-session"]) {
      const dir = await tree({
        "package.json": pkg({
          "express-session": "^1.18.0",
          [store]: "^1.0.0",
          multer: "^1.4.5",
          "@aws-sdk/client-s3": "^3.0.0",
        }),
        "src/upload.ts": "import multer from 'multer';\nconst storage = multer.diskStorage({});\n",
      });
      const facts = await detectProject(dir);
      expect(facts.statelessIssues).toBeUndefined();
    }

    const multerS3Dir = await tree({
      "package.json": pkg({ multer: "^1.4.5", "multer-s3": "^3.0.0" }),
      "src/upload.ts": "import multer from 'multer';\nconst u = multer({ dest: 'uploads/' });\n",
    });
    expect((await detectProject(multerS3Dir)).statelessIssues).toBeUndefined();

    // Commented-out diskStorage or memoryStorage does not trigger false positives.
    const memoryDir = await tree({
      "package.json": pkg({ multer: "^1.4.5" }),
      "src/upload.ts":
        "// const old = multer.diskStorage({});\nconst upload = multer({ storage: multer.memoryStorage() });\n",
    });
    expect((await detectProject(memoryDir)).statelessIssues).toBeUndefined();
  });
});

describe("detectStatelessIssues — Django / Python", () => {
  it("flags file SESSION_ENGINE and local MEDIA_ROOT without django-storages", async () => {
    const dir = await tree({
      "requirements.txt": "Django==5.1\n",
      "manage.py": "#!/usr/bin/env python\n",
      "mysite/settings.py": [
        "SECRET_KEY = 'dev-only'",
        "SESSION_ENGINE = 'django.contrib.sessions.backends.file'",
        "MEDIA_ROOT = BASE_DIR / 'media'",
      ].join("\n"),
    });
    const facts = await detectProject(dir);
    expect(facts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "django",
        evidence: "SESSION_ENGINE=django.contrib.sessions.backends.file",
        file: "mysite/settings.py",
      }),
      expect.objectContaining({
        kind: "local-uploads",
        framework: "django",
        evidence: "MEDIA_ROOT (without django-storages)",
        file: "mysite/settings.py",
      }),
    ]);
  });

  it("omits statelessIssues for safe Django session engines and django-storages S3 uploads", async () => {
    for (const engine of [
      "django.contrib.sessions.backends.db",
      "django.contrib.sessions.backends.cache",
      "django.contrib.sessions.backends.signed_cookies",
    ]) {
      const dir = await tree({
        "requirements.txt": "Django==5.1\ndjango-storages==1.14.4\n",
        "manage.py": "#!/usr/bin/env python\n",
        "mysite/settings.py": `SESSION_ENGINE = '${engine}'\nMEDIA_ROOT = BASE_DIR / 'media'\n`,
      });
      const facts = await detectProject(dir);
      expect(facts.statelessIssues).toBeUndefined();
    }

    // Split settings package where production.py overrides base.py's file sessions and adds S3.
    const splitDir = await tree({
      "requirements.txt": "Django==5.1\n",
      "manage.py": "#!/usr/bin/env python\n",
      "mysite/settings/base.py": [
        "SESSION_ENGINE = 'django.contrib.sessions.backends.file'",
        "MEDIA_ROOT = BASE_DIR / 'media'",
      ].join("\n"),
      "mysite/settings/production.py": [
        "SESSION_ENGINE = 'django.contrib.sessions.backends.cache'",
        "DEFAULT_FILE_STORAGE = 'storages.backends.s3boto3.S3Boto3Storage'",
      ].join("\n"),
    });
    expect((await detectProject(splitDir)).statelessIssues).toBeUndefined();
  });
});

describe("detectStatelessIssues — Rails / Ruby", () => {
  const gemfile = (extra = "") => `source 'https://rubygems.org'\ngem 'rails', '~> 7.2'\n${extra}`;

  it("flags :cache_store sessions backed by :file_store or :memory_store and active_storage :local", async () => {
    const fileStoreDir = await tree({
      Gemfile: gemfile(),
      "config/application.rb": "config.session_store :cache_store, key: '_app_session'\n",
      "config/environments/production.rb": [
        "Rails.application.configure do",
        "  config.cache_store = :file_store, '/tmp/cache'",
        "  config.active_storage.service = :local",
        "end",
      ].join("\n"),
      "config/storage.yml": "local:\n  service: Disk\n  root: storage\n",
    });
    const facts = await detectProject(fileStoreDir);
    expect(facts.statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "rails",
        evidence: "config.session_store :cache_store (:file_store)",
        file: "config/environments/production.rb",
      }),
      expect.objectContaining({
        kind: "local-uploads",
        framework: "rails",
        evidence: "active_storage.service = :local",
        file: "config/environments/production.rb",
      }),
    ]);

    const memStoreDir = await tree({
      Gemfile: gemfile(),
      "config/initializers/session_store.rb":
        "Rails.application.config.session_store :cache_store, expire_after: 1.day\n",
      "config/environments/production.rb": "config.cache_store = :memory_store\n",
    });
    expect((await detectProject(memStoreDir)).statelessIssues).toEqual([
      expect.objectContaining({
        kind: "local-sessions",
        framework: "rails",
        evidence: "config.session_store :cache_store (:memory_store)",
        file: "config/environments/production.rb",
      }),
    ]);
  });

  it("omits statelessIssues for :cookie_store, Redis/Solid Cache, and S3 Active Storage", async () => {
    const safeDir = await tree({
      Gemfile: gemfile("gem 'aws-sdk-s3'\ngem 'redis'\n"),
      "config/application.rb": [
        "config.session_store :cache_store, key: '_app_session'",
        "config.cache_store = :memory_store",
      ].join("\n"),
      "config/environments/production.rb": [
        "config.cache_store = :redis_cache_store",
        "config.active_storage.service = :amazon",
      ].join("\n"),
      "config/storage.yml": "local:\n  service: Disk\namazon:\n  service: S3\n",
    });
    expect((await detectProject(safeDir)).statelessIssues).toBeUndefined();

    const defaultCookieDir = await tree({
      Gemfile: gemfile(),
      "config/application.rb": "config.session_store :cache_store, key: '_app_session'\n",
      "config/environments/production.rb": [
        "config.session_store :cookie_store, key: '_app_session'",
        "config.cache_store = :memory_store",
      ].join("\n"),
    });
    expect((await detectProject(defaultCookieDir)).statelessIssues).toBeUndefined();
  });
});

describe("detectStatelessIssues — determinism & safety", () => {
  it("never leaks secret values in evidence and returns findings in deterministic sorted order", async () => {
    const dir = await tree({
      "composer.json": JSON.stringify({
        require: { "laravel/framework": "^11.0" },
      }),
      ".env.example": [
        "APP_KEY=base64:not-a-real-secret-value-12345",
        "FILESYSTEM_DISK=local",
        "SESSION_DRIVER=file",
      ].join("\n"),
    });
    const first = await detectProject(dir);
    const second = await detectProject(dir);
    expect(first.statelessIssues).toEqual(second.statelessIssues);
    expect(first.statelessIssues?.map((issue) => issue.kind)).toEqual([
      "local-sessions",
      "local-uploads",
    ]);
    const serialized = JSON.stringify(first.statelessIssues);
    expect(serialized).not.toContain("not-a-real-secret-value-12345");
  });
});
