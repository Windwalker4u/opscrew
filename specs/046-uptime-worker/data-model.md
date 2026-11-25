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
