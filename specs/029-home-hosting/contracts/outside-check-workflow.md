# Contract: the outside check's workflow

Owners:
- `packages/iac-templates/src/workflow/outside-check.ts` (T2908): renders
  `.github/workflows/opscrew-outside-check.yml`, exports
  `OUTSIDE_CHECK_WORKFLOW_FILE = "opscrew-outside-check.yml"` and the job names;
- agents `home/outside-check.ts` (T2910d): runs it and reads it back;
- agents verify (T2914a): calls it.

Provision writes the file with a home app's other workflow files in the deploy-setup pull request
(T2913b). One file serves every app and environment of the repository. It stays while any home
app remains in the repository, and destroy's pull request removes it with the last one (T2915b).

## The file

```yaml
# Managed by OpsCrew: checks from outside your home that your app answers on ports 80 and 443.
# `opscrew verify` starts it. It changes nothing, and it never gets your home's address.
name: OpsCrew outside check
on:
  workflow_dispatch:
    inputs:
      host:
        description: "The app's hostname"
        required: true
        type: string
      path:
        description: "The app's health path"
        required: true
        type: string
      mode:
        description: "proxied or direct"
        required: true
        type: choice
        options: [proxied, direct]
permissions: {}
concurrency:
  group: opscrew-outside-check-${{ inputs.host }}
  cancel-in-progress: false
jobs:
  http:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Port 80 answers from outside
        env:
          HOST: ${{ inputs.host }}
          CHECK_PATH: ${{ inputs.path }}
          MODE: ${{ inputs.mode }}
        run: |
          # the probe, below, with URL="http://$HOST/"
  https:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Port 443 answers from outside
        env:
          HOST: ${{ inputs.host }}
          CHECK_PATH: ${{ inputs.path }}
          MODE: ${{ inputs.mode }}
        run: |
          # the probe, below, with URL="https://$HOST$CHECK_PATH?opscrew-outside-check=$GITHUB_RUN_ID"
```

**The probe.** Each job's `run:` is fixed text with no `${{ }}` in it:

1. **Checks the inputs:**
   - `HOST` is at most 253 characters and matches
     `^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`;
   - `CHECK_PATH` matches `^/[A-Za-z0-9._~/-]{0,200}$`;
   - `MODE` is `proxied` or `direct`.
   Anything else fails with "invalid input".
2. **Up to six tries, 20 s apart:**
   `code=$(curl -s -o /dev/null -D "$RUNNER_TEMP/h" --max-time 15 -w '%{http_code}' "$URL"); rc=$?`.
   - curl checks the certificate by default.
   - The `https` job's query (`opscrew-outside-check=<run id>`) cache-busts the request, so
     Cloudflare's cache can't answer for the origin.
3. **A try passes** when `rc` is 0, `code` isn't `000` or 520 to 527 or 530, and the headers in
   `$RUNNER_TEMP/h` have no `cf-mitigated:` line. That line means a Cloudflare challenge stopped
   the request before the origin.
4. **What the job prints** is `echo "<job> try <n>: code $code, curl $rc"`, plus `challenged` when
   `cf-mitigated` was there. curl runs with `-s` and without `-S`, so its error text, which can
   name an address, is never printed. The header file is never printed. GitHub's own log of the
   step also shows its `env` (the hostname, path and mode) and GitHub's lines.
5. **A job fails** with `exit 1` after the last try.

`mode` changes no command. It's recorded with the result, so the messages say what was proven.

## The rules

- **No address in GitHub:** the inputs are a public hostname that DNS already serves and the
  app's health path (`app.healthPath`). The runner resolves the hostname itself and prints status
  codes.
- **Nothing to use:** `permissions: {}`, no `secrets.*`, no third-party action, no checkout.
- **Inputs only through `env:`,** never inside a `run:` line (GitHub's script-injection guidance).

## How agents run it (`runOutsideCheck`)

```ts
interface OutsideCheckResult {
  at: string;                                   // ISO time of the dispatch
  host: string;
  mode: "proxied" | "direct";
  http: "ok" | "failed" | "unfinished" | "skipped";
  https: "ok" | "failed" | "unfinished" | "skipped";
  runUrl: string;
}

function runOutsideCheck(
  deps: Pick<PhaseDeps, "audit" | "reporter" | "clock" | "paths">,
  github: { api: Pick<GitHubClient, "dispatchWorkflow" | "waitForWorkflowRun" | "runAttemptJobs">; owner: string; repo: string; defaultBranch: string },
  input: { host: string; path: string; mode: "proxied" | "direct" },
): Promise<OutsideCheckResult>;
```

1. **Dispatch:** `api.dispatchWorkflow(owner, repo, OUTSIDE_CHECK_WORKFLOW_FILE, defaultBranch,
   { host, path, mode }, onAccepted)`. `onAccepted` audits `dispatch workflow` (`provider-call`).
2. **Wait:** `api.waitForWorkflowRun(…, { timeoutMs: 10 * 60_000 })`.
3. **Read:** `api.runAttemptJobs(owner, repo, runId, 1)`. A job's conclusion maps as `success` →
   `ok`, `failure` → `failed`, `cancelled` or `timed_out` → `unfinished`, and missing or
   `skipped` → `skipped`.
4. **Record:** the result goes into `.opscrew/server.json` → `own.home.outsideCheck`, audited as
   `outside check result`.

**Errors:**
- **A dispatch refused** (the workflow isn't on the default branch): "Merge the deploy-setup pull
  request first, then run `npx opscrew verify` again." The check is `skip`.
- **No GitHub token, or Actions write missing:** `skip`, naming the permission. It never counts as
  passed.
- **`unfinished`, or the wait's timeout:** "the check didn't finish: run `npx opscrew verify`
  again", with the run's link. That isn't a port failure.

## What it proves, and what it doesn't

It proves, from GitHub's hosted network, outside the home:
- **`direct`:** on 443, the forwards reach an edge holding a valid certificate for the hostname,
  which answers the health path. On 80, the forward reaches the edge (its redirect counts);
- **`proxied`:** on 443, Cloudflare reaches the origin's health path. The `http` job shows only that
  Cloudflare answers on port 80. That proves the forward on 80 only when the zone sends plain-HTTP
  requests to the origin, which OpsCrew can't tell, so it reads "80: Cloudflare answered".

It doesn't prove:
- IPv6 in `direct` mode (GitHub's hosted runners have no IPv6: UNCONFIRMED, plan O8);
- reachability from every other network;
- that SSH is closed (`secure` checks the server's own firewall);
- that the address will stay;
- that a request from inside the home works: hairpin NAT decides that.

## Tests

- **Renderer:** a snapshot; no `${{ }}` in any `run:`; `permissions: {}`; no `secrets.`.
- **The probe with a stubbed curl:** retries, each failing code, `cf-mitigated`, invalid inputs,
  and nothing printed beyond the lines above.
- **agents, with the GitHub fake:** every conclusion, `unfinished`, a 404/422 dispatch, the
  timeout, and audit entries that hold no address.
