# Data model: the uptime Worker

## The plan's field (`packages/plan-schema`, T4601)

```yaml
observability:
  check:
    enabled: true
    runner: cloudflare   # or actions (absent: actions)
```

`ObservabilityCheckSchema` gains this field:

```ts
runner: z.enum(["actions", "cloudflare"], { error: 'must be "actions" or "cloudflare"' }).optional()
```

`checkObservability` refuses `runner: "cloudflare"` when `dns.provider !== "cloudflare"`:

- **Path:** `observability.check.runner`.
- **Message:** `can be "cloudflare" only when dns.provider is "cloudflare": the Worker runs in the
  Cloudflare account of the app's zone; set observability.check.runner to "actions", or put the
  app's DNS on Cloudflare`.

## In the user's Cloudflare account

| Thing | Name | Who writes it |
|---|---|---|
| Worker script | `opscrew-uptime` | OpsCrew (the adapter), when missing or its SHA-256 changed |
| Cron Trigger | `*/5 * * * *` on `opscrew-uptime` | OpsCrew, with the script |
| KV namespace | title `opscrew-uptime`, bound as `UPTIME` | OpsCrew, when missing |
| Secret | `HOOK_<hex16>`, one per entry | OpsCrew, that entry's app only |
| KV `opscrew:worker` | `{ "sha256": "<script's SHA-256>" }` | OpsCrew, after each upload |
| KV `entry:<id>` | the entry (below) | OpsCrew, that entry's app only |
| KV `state:<id>` | the state (below) | the Worker only; OpsCrew deletes it with its entry |

`<id>` is `<owner>/<repo>/<app key or name>/<env>`, for example `acme/shop/shop/prod`. `<hex16>`
is the first 16 hex characters of the SHA-256 of `<id>`.

### The entry (`entry:<id>`)

```json
{
  "version": 1,
  "repository": "acme/shop",
  "app": "shop",
  "environment": "prod",
  "hosts": [{ "hostname": "shop.example.com", "healthPath": "/health" }],
  "webhook": "ntfy",
  "secret": "HOOK_3f2a9c0d11e4b7a8"
}
```

The hosts are the same as the Actions check's: `siteHosts(plan)`, and the health path of
`healthPath(plan)`, or `/` on a serverless target.

### The secret (`HOOK_<hex16>`)

The secret's value is JSON: `{ "url": "<webhook address>", "token": "<ntfy token>" }`. `token` is
there only for ntfy, when `OPSCREW_CHECK_NTFY_TOKEN` is set. The value is never in a plan, a hash,
a log, the audit log or a file.

### The state (`state:<id>`)

```json
{
  "hosts": {
    "shop.example.com": { "status": "down", "since": "2026-11-25T10:05:00Z", "reason": "not reachable" },
    "www.shop.example.com": { "status": "suspect", "since": "2026-11-25T10:15:00Z", "reason": "answered with status 502" }
  }
}
```

- **Up:** a hostname is up when it is absent.
- **The transitions** (one try per hostname per run, the lead's decision of 2026-11-25):

  | Now | The try | Next | Posts |
  |---|---|---|---|
  | up | fails | `suspect` (`since` = this run) | nothing |
  | `suspect` | answers | up (removed) | nothing |
  | `suspect` | fails | `down` (`since` kept from `suspect`) | "down" |
  | `down` | fails | `down` (unchanged, not written) | nothing |
  | `down` | answers | up (removed) | "recovered", with the time since `since` |

- **When it is written:** the key is written only when the table changes something, and deleted
  when no hostname is left in it.
  - A change that posts is written only after the post is accepted.
  - A change whose post failed, or didn't fit in the run, stays unwritten, so the next run posts
    it.
- **A dropped hostname:** one no longer in the entry is dropped at the next write, with no
  message.

## The adapter's plan (`packages/connectors/cloudflare/src/uptime.ts`, T4603)

```ts
interface UptimeDesired {
  id: string;                       // <owner>/<repo>/<app>/<env>
  entry?: UptimeEntry;              // absent: remove this entry (destroy, runner back to actions)
  destroy?: true;                   // only from destroy: may delete the Worker and the namespace
  secret?: string;                  // the secret's value, when given this run; never hashed
  script: { content: string; sha256: string };
}

type UptimeChange =
  | { kind: "create-namespace" }
  | { kind: "upload-script"; sha256: string }   // also sets the schedule
  | { kind: "put-secret"; name: string }
  | { kind: "put-entry"; key: string; entry: UptimeEntry }
  | { kind: "delete-entry"; key: string }       // and its state key
  | { kind: "delete-secret"; name: string }
  | { kind: "delete-script" }                   // with its trigger and secrets
  | { kind: "delete-namespace" };

interface UptimePlan {
  accountId: string;
  changes: UptimeChange[];
  /** What the apply reads again before writing: other entries' keys, the script's SHA-256, the namespace id. */
  expect: { others: string[]; sha256: string | null; namespaceId: string | null };
  findings: { code: "too-many-hostnames" | "permission-missing"; message: string; hint: string }[];
  destroys: boolean;                // delete-script or delete-namespace: only with desired.destroy
  hash: string;                     // SHA-256 of canonical JSON of accountId, changes, expect
}
```

The changes are applied in the order listed above.

- **A removal's order:** `delete-entry`, then `delete-secret`.
- **In a destroy** (`desired.destroy`) that leaves no other entry, `delete-script` and
  `delete-namespace` follow, under the destroy's own `allowDestroy` and typed confirmation.
- **In a provision,** the plan never deletes the Worker or the namespace, even when it removes the
  last entry.

## Server reports (User Story 4, T4606 to T4609)

### The entry gains `servers`

```json
{
  "servers": [{ "id": "hetzner-shop", "since": "2026-11-25T10:00:00Z", "drill": "weekly" }]
}
```

Each server of the environment that has a timer is listed:

- `id` is the server's id in the Actions check (`checkEnvironmentKey` and `serverIds`), never an
  address;
- `since` is when it was first listed, carried over from the entry already in KV;
- `drill` is present while the app has scheduled restore drills.

The entry may also carry:

- `"rotate": " --env staging"`, the flags of the `opscrew rotate` command in a credential's
  message (empty for the first app's prod);
- `"heartbeatMinutes": 10`, **test only**. `planUptime` accepts it only with the live test's flag
  (`{ liveTest: true }`), which only `packages/cli/test/live` passes, and refuses it otherwise
  with the finding `test-only-field`. The Worker uses it only between 5 and 1,560 minutes, and
  26 hours otherwise.

### The secret gains `report`

```json
{ "url": "<webhook address>", "token": "<ntfy token>", "report": "<64 hex characters>" }
```

- **`report`:** the environment's report key, 32 random bytes. OpsCrew keeps it like the check
  key, as a secret file in the OpsCrew home (`ensureSecretFile`), so a server created again gets
  the same key with no Worker change.
- **A new key:** only when that file is lost. The secret is then written again, which needs the
  webhook's address (`OPSCREW_CHECK_WEBHOOK` or the prompt), as a changed address does.

### The report (`POST /report`)

| Header | Value |
|---|---|
| `X-OpsCrew-Entry` | `<id>` |
| `X-OpsCrew-Time` | Unix seconds |
| `X-OpsCrew-Signature` | hex HMAC-SHA256, with the report key, of `<time>` + `\n` + the body |
| `User-Agent` | `OpsCrew uptime report` |

```json
{
  "version": 1,
  "server": "hetzner-shop",
  "kind": "change",
  "disk": { "status": "warn", "percent": 87, "free": 5368709120, "total": 42949672960 },
  "snapshot": { "status": "ok", "id": "20261125T030000Z" },
  "drill": { "status": "failed", "result": "unhealthy", "at": "2026-11-24T03:41:00Z" },
  "certificates": [{ "hostname": "shop.example.com", "status": "warn", "days": 9 }],
  "credentials": [{ "name": "deploy-key", "status": "old", "days": 400, "source": "rotated" }]
}
```

- **`kind`:** `change` or `heartbeat`.
- **The statuses:**
  - disk: `ok`, `warn` (85% or more), `high` (95% or more), or `unknown`;
  - snapshot: `ok`, `failed`, `copy-failed`, `none` (no log yet), or `unknown` (a snapshot being
    taken);
  - drill: `ok`, `failed`, `late`, `none` (no drills), or `unknown`;
  - each certificate: `ok`, `warn` (under 14 days), `expired`, or `none` (no TLS answer on 443);
  - each credential: `ok` or `old`. It is carried from the last daily check between checks, and
    absent with `observability.check.credentials` off.
- **What counts as a change:** a change of status. A percentage moving within one status isn't
  one.
- **`unknown`** never posts. The Worker keeps the last known status.
- **What it never holds:** a log line, an address or a path beyond the app's name. The Worker
  refuses a body over 4 KB, or with fields outside this shape.

### The server's report key (`report:<id>/<server>`)

- **Its value:** the last accepted report, plus the time it was accepted.
- **Its KV metadata** is `{ "at": <time> }`, so the cron reads every server's last report time
  from its one list per run, with no `get`.
- **Its writer:** only the `fetch` handler.
- **When it goes:** OpsCrew's plan deletes it when its server leaves the entry, and with the
  entry.

### The cron's part of the state (`state:<id>`)

`"stopped": { "<server>": "<ISO time of the alert>" }` is added to the state. It is set when the
cron posts "reports stopped", and cleared when it posts "reports resumed".

### The server's files (host step `uptime-report`, T4607)

| Path | Mode | What |
|---|---|---|
| `/usr/local/lib/opscrew/uptime-report.sh` | 755 root | the script; line 2 `# opscrew-uptime-report version <n>` |
| `/etc/systemd/system/opscrew-uptime-report@.service` | 644 root | `User=<deploy user>`, `LoadCredential=config:…` and `key:…`, `StateDirectory=opscrew-uptime-report/%i` |
| `/etc/systemd/system/opscrew-uptime-report@.timer` | 644 root | `OnBootSec=2min`, `OnUnitActiveSec=5min`, `RandomizedDelaySec=30` |
| `/etc/opscrew/uptime-report/<hex16>.conf` | 600 root | `key=value` lines, read line by line and never sourced: `url`, `entry`, `server`, `app`, `drill`, `disk_warn`, `disk_high`, `cert_days`, one `host=<hostname>` per hostname served there, `max_age_days`, and one `credential=<name> <ISO date> <made\|rotated\|first-deploy>` per credential. Names and dates only, never a value |
| `/etc/opscrew/uptime-report/<hex16>.key` | 600 root | the report key, in hex |
| `/var/lib/opscrew-uptime-report/<hex16>/state` | the service's | the last sent statuses, and the time of the last report |

The instance is `<hex16>`, the same as the entry's secret's suffix.

### The adapter's plan gains

```ts
| { kind: "set-subdomain" }                       // workers.dev on, previews off
| { kind: "delete-report"; key: string }          // a server that left the entry
```

- **`facts.accountSubdomain`:** read with `GET …/workers/subdomain`. It gives the report URL,
  `https://opscrew-uptime.<subdomain>.workers.dev/report`, which the agents put into the
  server's config.
- **Without a subdomain** the plan has the finding `workers-dev-missing`.
- **`delete-entry`** also deletes the entry's `report:` keys.
