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
   `webhook: ntfy`, with `OPSCREW_CHECK_WEBHOOK` set to the topic's address. Provision prints that
   the disk, snapshot, restore-drill and certificate-days checks need `runner: actions`.
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
9. **Leaving through provision:** set B's `runner: actions` and provision. Only B's entry, state
   and secret go, and the Worker stays.
10. **Destroy A**, the last entry, with `npx opscrew destroy`. Under its typed confirmation, the
    Worker, its trigger and the namespace go.
11. **Nothing left behind:** list the account's Workers, KV namespaces and the Worker's secrets
    through the API. None of OpsCrew's remain. Then destroy B and remove the ntfy topic.

Write the results into `docs/e2e-coverage.md` (Live results), with what research R4 left to
confirm: that a secret's `PUT` deploys, and that an upload keeps the others' secrets.
