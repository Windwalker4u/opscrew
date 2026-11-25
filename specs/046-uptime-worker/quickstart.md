# Quickstart: check the uptime Worker

## Offline (every change)

```bash
pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates \
  --filter=@opscrew/connector-cloudflare --filter=@opscrew/agents
pnpm lint
```

## Live (once, before the release; the lead's, T4692)

The lead runs it on the founder's own Cloudflare account. It's free on the free plans and
reversible, so it needs no extra go-ahead. It creates a Worker, its trigger, a KV namespace and
secrets, and it must leave none of them behind.

Use two throwaway apps whose DNS is on Cloudflare in the same account, and an ntfy topic with a long
random name as the webhook.

1. **Setup:** in app A's `opscrew/plan.yaml`, set `observability.check.runner: cloudflare` and
   `webhook: ntfy`, with `OPSCREW_CHECK_WEBHOOK` set to the topic's address, and
   `observability.check.credentials: true`. On a server, provision prints no Actions-only line:
   nothing is left to Actions.
2. **Provision A:** run `npx opscrew provision`.
   - The plan creates `opscrew-uptime`, its trigger, its namespace, A's secret and A's entry.
   - Approve it, then list through the API: one Worker, one trigger `*/5 * * * *`, one namespace,
     one secret, and the keys `opscrew:worker` and `entry:…`.
   - Record how long the first run took to come.
3. **Healthy:** wait for two runs. The Worker's logs show one line per run, and KV has no `state:`
   key.
4. **A blip:** make one run fail (for example, stop the app just before a run and start it right
   after). `state:` shows the hostname as `suspect`, no message is posted, and the next run clears
   it silently.
5. **Down:** stop A's app (or point its health path at a 503) for two runs.
   - After the first, `state:` holds `suspect`. After the second, one ntfy message, priority 4,
     says it is down, with the reason.
   - `npx opscrew status` lists the hostname as down.
   - One more run posts and writes nothing.
6. **Recovered:** start it again. One message, priority 3, says it is up again, with the duration,
   and `state:` is gone.
7. **A second app:** in app B (same account), do the same. Its plan creates nothing shared and
   says it keeps A's entry. Approve it, and both entries are listed.
8. **An invalid certificate,** if an unproxied hostname is at hand: serve it with a self-signed
   certificate for two runs. The message says "an invalid certificate".
9. **The server's timer** (User Story 4), with A on a server, cloud or own:
   - provision's host plan shows the step `uptime-report`;
   - the Cloudflare plan turns on workers.dev;
   - on the server, `systemctl list-timers 'opscrew-uptime-report@*'` lists one timer, and the
     config and key files are 0600 root;
   - KV gets `report:<id>/<server>` within 5 minutes, the first report.
10. **A disk alert:** on a throwaway server, fill the disk past 85% with `fallocate` (keep it
    under 95%).
    - Within about 5 minutes, one message says the disk is over 85% full.
    - Remove the file. One message says it recovered.
    - KV writes: one per change.
11. **The endpoint refuses:**
    - `curl -X POST` an unsigned body to the report URL: 401, and no KV operation in the Worker's
      logs;
    - `GET /`: 404;
    - a captured signed report sent again: 409.
12. **Silence, in minutes:** the live test's own setup writes A's entry through the adapter with
    `{ liveTest: true }` and `heartbeatMinutes: 10`. That is the only caller allowed to; an
    ordinary provision refuses the field.
    - Stop the timer. About 10 minutes later, one message says reports from A stopped.
    - Start it again, and "reports resumed" follows at the next report.
    - Provision A again, which writes the entry without the field, and check that the entry no
      longer has it.
12a. **Certificates and credentials:**
    - the config lists A's hostnames and its credentials' dates, names only;
    - `status` shows the certificates' days and the credentials' ages from the last report;
    - after `npx opscrew rotate <a credential>`, its host plan writes the new date, and the
      config shows it.
13. **Leaving through provision:** set B's `runner: actions` and provision. Only B's entry, state
    and secret go, B's timer is removed (`systemctl list-timers` shows none for it), and the
    Worker stays.
14. **Destroy A**, the last entry, with `npx opscrew destroy`. Under its typed confirmation:
    - the Worker, its trigger and the namespace go;
    - on a server of the user's own, the timer and its files go too.
15. **Nothing left behind:**
    - list the account's Workers, KV namespaces and the Worker's secrets through the API. None of
      OpsCrew's remain;
    - on each server that stays, no `opscrew-uptime-report` unit or file remains;
    - then destroy B and remove the ntfy topic.

Write the results into `docs/e2e-coverage.md` (Live results), with what research R4 left to
confirm: that a secret's `PUT` deploys, and that an upload keeps the others' secrets.
