/**
 * Deterministic stateless-readiness detection (Feature 033, research.md R3): finds local
 * per-server sessions and local-disk uploads in app code or config that break when an app runs on
 * 2+ servers. Never puts secret values in `evidence`.
 */
import type { ProjectFacts } from "@opscrew/plan-schema";
import { envFileValue } from "./connections";
import { type Dependency, parseYamlSafe, type ReadText } from "./manifests";
import { isWithin, joinRel, relativeTo } from "./paths";
import { laravelConfigDefault } from "./services";
import { isRuntimeCodeFile } from "./sources";

export type StatelessIssue = NonNullable<ProjectFacts["statelessIssues"]>[number];

/** What stateless-readiness detection reads about the app. */
export interface StatelessContext {
  appDir: string;
  /** Repo-relative files belonging to this app. */
  files: readonly string[];
  /** Committed env files (e.g. `.env.example`) in scope for this app. */
  envFiles: readonly { path: string; text: string }[];
  /** Django settings files already read (`repo-relative path` → text). */
  settingsTexts: ReadonlyMap<string, string>;
  /** Runtime (non-dev) dependencies for this app. */
  dependencies: readonly Dependency[];
  /** Detected frameworks for this app (e.g. `laravel`, `express`, `django`, `rails`). */
  frameworks: ReadonlySet<string>;
  /** Reads a repo-relative file that survived the walk. */
  read: ReadText;
}

/** Express session packages that store sessions off local process memory. */
const SAFE_EXPRESS_SESSION_STORES = new Set([
  "connect-redis",
  "connect-pg-simple",
  "connect-mongo",
  "cookie-session",
]);

/** Node S3/object-storage upload packages that keep uploads off local disk. */
const SAFE_NODE_UPLOAD_PACKAGES = new Set(["@aws-sdk/client-s3", "multer-s3"]);

/** Laravel session drivers that work across 2+ servers. */
const SAFE_LARAVEL_SESSION_DRIVERS = new Set([
  "redis",
  "database",
  "cookie",
  "memcached",
  "dynamodb",
]);

/** Laravel local-disk filesystem drivers that break across 2+ servers. */
const UNSAFE_LARAVEL_DISKS = new Set(["local", "public"]);

/** Laravel Flysystem S3 packages. */
const SAFE_LARAVEL_S3_PACKAGES = new Set(["league/flysystem-aws-s3-v3", "async-aws/s3"]);

/** Rails cache stores that work across 2+ servers. */
const SHARED_RAILS_CACHE_STORES = new Set([
  "redis_cache_store",
  "mem_cache_store",
  "solid_cache_store",
]);

/** Rails cache stores that stay local to one server or process. */
const LOCAL_RAILS_CACHE_STORES = new Set(["file_store", "memory_store"]);

/** Strips JS/TS line and block comments so commented-out examples do not trigger matches. */
function stripJsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Strips `# ...` full-line comments from Python / Ruby config files. */
function stripHashComments(text: string): string {
  return text.replace(/^\s*#.*$/gm, "");
}

/** Strips PHP `//`, `#`, and `/* ... *\/` comments from config files. */
function stripPhpComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(?:\/\/|#).*$/gm, "");
}

function hasRuntimeDep(
  dependencies: readonly Dependency[],
  ecosystem: Dependency["ecosystem"],
  name: string,
): boolean {
  return dependencies.some((dep) => !dep.dev && dep.ecosystem === ecosystem && dep.name === name);
}

/** Hardcoded PHP config array entry (`'driver' => 'file'`), excluding `env(...)` expressions. */
function phpLiteralConfig(phpText: string, key: string): string | undefined {
  return new RegExp(`['"]${key}['"]\\s*=>\\s*['"](\\w+)['"]`).exec(phpText)?.[1];
}

async function detectLaravelIssues(ctx: StatelessContext): Promise<StatelessIssue[]> {
  if (
    !ctx.frameworks.has("laravel") &&
    !hasRuntimeDep(ctx.dependencies, "composer", "laravel/framework")
  ) {
    return [];
  }
  const issues: StatelessIssue[] = [];

  // 1. Local sessions: SESSION_DRIVER=file in committed .env* or config/session.php.
  let envSession: { value: string; file: string } | undefined;
  for (const env of ctx.envFiles) {
    const raw = envFileValue(env.text, "SESSION_DRIVER")?.trim().toLowerCase();
    if (raw) {
      envSession = { value: raw, file: env.path };
      break;
    }
  }
  if (envSession !== undefined) {
    if (envSession.value === "file") {
      issues.push({
        kind: "local-sessions",
        framework: "laravel",
        evidence: "SESSION_DRIVER=file",
        file: envSession.file,
        remediation:
          "Store Laravel sessions in Redis/Valkey, the shared database, or encrypted cookies (set SESSION_DRIVER=redis, database, or cookie) before scaling across servers.",
      });
    }
  } else {
    const sessionFile = joinRel(ctx.appDir, "config/session.php");
    const sessionText = await ctx.read(sessionFile);
    if (sessionText !== undefined) {
      const cleaned = stripPhpComments(sessionText);
      const driver = (
        laravelConfigDefault(cleaned, "SESSION_DRIVER") ?? phpLiteralConfig(cleaned, "driver")
      )?.toLowerCase();
      if (driver === "file" && !SAFE_LARAVEL_SESSION_DRIVERS.has(driver)) {
        issues.push({
          kind: "local-sessions",
          framework: "laravel",
          evidence: "SESSION_DRIVER=file",
          file: sessionFile,
          remediation:
            "Store Laravel sessions in Redis/Valkey, the shared database, or encrypted cookies (set SESSION_DRIVER=redis, database, or cookie) before scaling across servers.",
        });
      }
    }
  }

  // 2. Local uploads: FILESYSTEM_DISK=local|public without league/flysystem-aws-s3-v3.
  const hasS3 = [...SAFE_LARAVEL_S3_PACKAGES].some((pkg) =>
    hasRuntimeDep(ctx.dependencies, "composer", pkg),
  );
  if (!hasS3) {
    let envDisk: { key: string; value: string; file: string } | undefined;
    for (const env of ctx.envFiles) {
      for (const key of ["FILESYSTEM_DISK", "FILESYSTEM_DRIVER"] as const) {
        const raw = envFileValue(env.text, key)?.trim().toLowerCase();
        if (raw) {
          envDisk = { key, value: raw, file: env.path };
          break;
        }
      }
      if (envDisk !== undefined) break;
    }
    if (envDisk !== undefined) {
      if (UNSAFE_LARAVEL_DISKS.has(envDisk.value)) {
        issues.push({
          kind: "local-uploads",
          framework: "laravel",
          evidence: `${envDisk.key}=${envDisk.value}`,
          file: envDisk.file,
          remediation:
            "Move Laravel uploads to S3-compatible object storage (install league/flysystem-aws-s3-v3 and set FILESYSTEM_DISK=s3) before scaling across servers.",
        });
      }
    } else {
      const fsFile = joinRel(ctx.appDir, "config/filesystems.php");
      const fsText = await ctx.read(fsFile);
      if (fsText !== undefined) {
        const cleaned = stripPhpComments(fsText);
        const disk = (
          laravelConfigDefault(cleaned, "FILESYSTEM_DISK") ??
          laravelConfigDefault(cleaned, "FILESYSTEM_DRIVER") ??
          phpLiteralConfig(cleaned, "default")
        )?.toLowerCase();
        if (disk !== undefined && UNSAFE_LARAVEL_DISKS.has(disk)) {
          issues.push({
            kind: "local-uploads",
            framework: "laravel",
            evidence: `FILESYSTEM_DISK=${disk}`,
            file: fsFile,
            remediation:
              "Move Laravel uploads to S3-compatible object storage (install league/flysystem-aws-s3-v3 and set FILESYSTEM_DISK=s3) before scaling across servers.",
          });
        }
      }
    }
  }

  return issues;
}

async function detectExpressIssues(ctx: StatelessContext): Promise<StatelessIssue[]> {
  const issues: StatelessIssue[] = [];
  const pkgFile = joinRel(ctx.appDir, "package.json");
  const hasPkg = ctx.files.includes(pkgFile);

  // 1. Local sessions: express-session without a shared store adapter or cookie-session.
  if (hasRuntimeDep(ctx.dependencies, "npm", "express-session")) {
    const hasSharedStore = [...SAFE_EXPRESS_SESSION_STORES].some((pkg) =>
      hasRuntimeDep(ctx.dependencies, "npm", pkg),
    );
    if (!hasSharedStore) {
      issues.push({
        kind: "local-sessions",
        framework: "express",
        evidence: "dependency:express-session (without shared session store)",
        ...(hasPkg ? { file: pkgFile } : {}),
        remediation:
          "Configure express-session with a shared store such as connect-redis (Valkey/Redis), connect-pg-simple, or connect-mongo (or switch to cookie-session) instead of the default in-memory MemoryStore.",
      });
    }
  }

  // 2. Local uploads: multer with diskStorage or dest: without @aws-sdk/client-s3 or multer-s3.
  if (hasRuntimeDep(ctx.dependencies, "npm", "multer")) {
    const hasS3Upload = [...SAFE_NODE_UPLOAD_PACKAGES].some((pkg) =>
      hasRuntimeDep(ctx.dependencies, "npm", pkg),
    );
    if (!hasS3Upload) {
      const jsFiles = ctx.files
        .filter((file) => {
          if (!isWithin(ctx.appDir, file)) return false;
          const rel = relativeTo(ctx.appDir, file);
          return /\.[cm]?[jt]sx?$/.test(rel) && isRuntimeCodeFile(rel);
        })
        .sort();
      for (const file of jsFiles) {
        const text = await ctx.read(file);
        if (text === undefined) continue;
        const cleaned = stripJsComments(text);
        const evidence = /\bdiskStorage\s*\(/.test(cleaned)
          ? "multer.diskStorage"
          : /\bmulter\s*\(\s*\{(?:\{[^{}]*\}|[^{}])*\bdest\s*:/.test(cleaned)
            ? "multer({ dest })"
            : undefined;
        if (evidence !== undefined) {
          issues.push({
            kind: "local-uploads",
            framework: "express",
            evidence,
            file,
            remediation:
              "Upload files directly to S3-compatible object storage (install @aws-sdk/client-s3 or multer-s3 instead of multer diskStorage/dest) before scaling across servers.",
          });
          break;
        }
      }
    }
  }

  return issues;
}

function detectDjangoIssues(ctx: StatelessContext): StatelessIssue[] {
  if (
    !ctx.frameworks.has("django") &&
    !hasRuntimeDep(ctx.dependencies, "pypi", "django") &&
    ctx.settingsTexts.size === 0
  ) {
    return [];
  }
  const issues: StatelessIssue[] = [];
  const settings = [...ctx.settingsTexts.entries()]
    .filter(([file]) => isWithin(ctx.appDir, file))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // 1. Local sessions: SESSION_ENGINE set to a file backend (unless overridden safely in prod settings).
  const prodSettings = settings.filter(([file]) => /(?:^|\/)prod(?:uction)?\.py$/i.test(file));
  const prodSafeSession = prodSettings.some(([, text]) => {
    const engine = /^\s*SESSION_ENGINE\s*=\s*["']([^"']+)["']/m
      .exec(stripHashComments(text))?.[1]
      ?.trim();
    return engine !== undefined && !/(?:^|\.)backends\.file$/.test(engine);
  });
  if (!prodSafeSession) {
    for (const [file, text] of settings) {
      const cleaned = stripHashComments(text);
      const match = /^\s*SESSION_ENGINE\s*=\s*["']([^"']+)["']/m.exec(cleaned);
      const engine = match?.[1]?.trim();
      if (engine !== undefined && /(?:^|\.)backends\.file$/.test(engine)) {
        issues.push({
          kind: "local-sessions",
          framework: "django",
          evidence: `SESSION_ENGINE=${engine}`,
          file,
          remediation:
            "Switch Django SESSION_ENGINE from file storage to the database (django.contrib.sessions.backends.db), a shared Redis/Valkey cache (backends.cache), or signed cookies (backends.signed_cookies) before scaling across servers.",
        });
        break;
      }
    }
  }

  // 2. Local uploads: MEDIA_ROOT set without django-storages / S3 storage backend.
  const hasS3Backend =
    hasRuntimeDep(ctx.dependencies, "pypi", "django-storages") ||
    settings.some(([, text]) =>
      /\b(?:storages\.backends\.s3|S3Boto3Storage|S3Storage)\b/.test(stripHashComments(text)),
    );
  if (!hasS3Backend) {
    for (const [file, text] of settings) {
      const cleaned = stripHashComments(text);
      if (/^\s*MEDIA_ROOT\s*=\s*(?!None\b|["']\s*["'])\S+/m.test(cleaned)) {
        issues.push({
          kind: "local-uploads",
          framework: "django",
          evidence: "MEDIA_ROOT (without django-storages)",
          file,
          remediation:
            "Configure django-storages with an S3-compatible storage backend (STORAGES['default']) instead of local MEDIA_ROOT before scaling across servers.",
        });
        break;
      }
    }
  }

  return issues;
}

/** Extracts the configured `config.cache_store = :<store>` symbol from Ruby config text. */
function railsCacheStore(cleanedRuby: string): string | undefined {
  return /\bconfig\.cache_store\s*=\s*:([a-z_]+)\b/.exec(cleanedRuby)?.[1];
}

/** Extracts `config.active_storage.service = :<service>` from Ruby config text. */
function railsActiveStorageService(cleanedRuby: string): string | undefined {
  return /\bconfig\.active_storage\.service\s*=\s*:([a-z0-9_]+)\b/.exec(cleanedRuby)?.[1];
}

/** True when `config/storage.yml` maps `serviceName` to Rails' local `Disk` service. */
function storageYmlIsDisk(yamlText: string | undefined, serviceName: string): boolean {
  if (yamlText === undefined) return false;
  const parsed = parseYamlSafe(yamlText);
  if (typeof parsed !== "object" || parsed === null) return false;
  const entry = (parsed as Record<string, unknown>)[serviceName];
  if (typeof entry !== "object" || entry === null) return false;
  return (entry as Record<string, unknown>).service === "Disk";
}

async function detectRailsIssues(ctx: StatelessContext): Promise<StatelessIssue[]> {
  if (!ctx.frameworks.has("rails") && !hasRuntimeDep(ctx.dependencies, "gem", "rails")) {
    return [];
  }
  const issues: StatelessIssue[] = [];

  const prodFile = joinRel(ctx.appDir, "config/environments/production.rb");
  const appFile = joinRel(ctx.appDir, "config/application.rb");
  const initializerFiles = ctx.files
    .filter((file) => {
      if (!isWithin(ctx.appDir, file)) return false;
      const rel = relativeTo(ctx.appDir, file);
      return /^config\/initializers\/[^/]+\.rb$/.test(rel);
    })
    .sort();

  const prodRaw = await ctx.read(prodFile);
  const appRaw = await ctx.read(appFile);
  const prodText = prodRaw === undefined ? undefined : stripHashComments(prodRaw);
  const appText = appRaw === undefined ? undefined : stripHashComments(appRaw);

  // 1. Local sessions: session_store :cache_store with :file_store or :memory_store.
  const sessionCandidates: { file: string; text: string }[] = [
    ...(prodText !== undefined ? [{ file: prodFile, text: prodText }] : []),
    ...(appText !== undefined ? [{ file: appFile, text: appText }] : []),
  ];
  for (const file of initializerFiles) {
    const raw = await ctx.read(file);
    if (raw !== undefined) sessionCandidates.push({ file, text: stripHashComments(raw) });
  }

  let usesCacheSession: { file: string; inlineStore?: string } | undefined;
  for (const candidate of sessionCandidates) {
    const match = /\bsession_store\s+\(?\s*:([a-z_]+)\b([^\r\n]*)/.exec(candidate.text);
    if (match !== null) {
      if (match[1] === "cache_store") {
        const rest = match[2] ?? "";
        const inline = /:(file_store|memory_store)\b/.exec(rest)?.[1];
        usesCacheSession = {
          file: candidate.file,
          ...(inline !== undefined ? { inlineStore: inline } : {}),
        };
      }
      break;
    }
  }
  if (usesCacheSession !== undefined) {
    const prodCache = prodText === undefined ? undefined : railsCacheStore(prodText);
    const appCache = appText === undefined ? undefined : railsCacheStore(appText);
    const effectiveStore = usesCacheSession.inlineStore ?? prodCache ?? appCache;
    if (
      effectiveStore !== undefined &&
      LOCAL_RAILS_CACHE_STORES.has(effectiveStore) &&
      !(prodCache !== undefined && SHARED_RAILS_CACHE_STORES.has(prodCache))
    ) {
      const storeFile =
        usesCacheSession.inlineStore !== undefined
          ? usesCacheSession.file
          : prodCache !== undefined
            ? prodFile
            : appFile;
      issues.push({
        kind: "local-sessions",
        framework: "rails",
        evidence: `config.session_store :cache_store (:${effectiveStore})`,
        file: storeFile,
        remediation:
          "Use Rails' default :cookie_store or point config.cache_store at a shared backend (:redis_cache_store or :solid_cache_store) instead of :file_store/:memory_store before scaling across servers.",
      });
    }
  }

  // 2. Local uploads: active_storage.service = :local (or a Disk service in config/storage.yml).
  const prodStorage = prodText === undefined ? undefined : railsActiveStorageService(prodText);
  const appStorage = appText === undefined ? undefined : railsActiveStorageService(appText);
  const serviceName = prodStorage ?? appStorage;
  if (serviceName !== undefined) {
    const storageFile = prodStorage !== undefined ? prodFile : appFile;
    const storageYml = await ctx.read(joinRel(ctx.appDir, "config/storage.yml"));
    if (serviceName === "local" || storageYmlIsDisk(storageYml, serviceName)) {
      issues.push({
        kind: "local-uploads",
        framework: "rails",
        evidence: `active_storage.service = :${serviceName}`,
        file: storageFile,
        remediation:
          "Configure Rails Active Storage to use an S3-compatible service (config.active_storage.service = :amazon with aws-sdk-s3) instead of :local before scaling across servers.",
      });
    }
  }

  return issues;
}

/**
 * Detects local per-server sessions and uploads across Laravel/PHP, Express/Node.js,
 * Django/Python, and Rails/Ruby. Returns `undefined` when clean, or a deterministically sorted
 * array of findings.
 */
export async function detectStatelessIssues(
  ctx: StatelessContext,
): Promise<ProjectFacts["statelessIssues"]> {
  const [laravel, express, rails] = await Promise.all([
    detectLaravelIssues(ctx),
    detectExpressIssues(ctx),
    detectRailsIssues(ctx),
  ]);
  const django = detectDjangoIssues(ctx);
  const all = [...laravel, ...express, ...django, ...rails].sort((a, b) => {
    const ka = `${a.kind}\0${a.framework}\0${a.file ?? ""}\0${a.evidence}`;
    const kb = `${b.kind}\0${b.framework}\0${b.file ?? ""}\0${b.evidence}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return all.length > 0 ? all : undefined;
}
