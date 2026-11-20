# Research: a move's maintenance window of about a minute

## R1. Where today's window spends its time (the PHP app's move, 2026-11-20)

- 481 MB through the user's computer while the app is off: 262 MB of files (the framework's
  `storage/site`, with `vendor/`), 219 MB of MySQL's data folder. OpsCrew estimated about 12 minutes;
  the real window, with its rollback, ran 5½ minutes (07:50:52–07:56:30 UTC).
- The window since 030's FR-3027 also holds a deploy run of GitHub Actions (the release on the
  copied data, the app's start): minutes of queueing and start-up on its own, whatever the data's
  size.

So a short window needs both: most of the data copied before it, and no workflow run in it.

## R2. Decisions (lead, 2026-11-20)

- **Pre-copy while serving:** every mount is copied whole, with the existing carrier, while the
  old app serves. A live copy of a database's files may be inconsistent; it only seeds the new
  side. The window's copy makes it exact, and the digest check proves it.
- **The delta:** a manifest of each mount on each side, read by a carrier: every path's type,
  mode, owner, group, size, link target, and a file's SHA-256, the same facts the digest hashes.
  The paths that differ are copied in one tar stream, and the paths only the new side has are
  removed. Hashing reads every file on both servers, locally, which is fast next to sending it.
  Modification times are not trusted: tar keeps them, but a database rewrites files in place.
- **The app checked before the window:** after the pre-copy, the move's marker says `copied`
  and the deploy workflow runs with the image's digest (030's FR-3027 mechanism), so the release
  command runs and the app starts on the pre-copied data, and OpsCrew checks it over SSH. In the
  window the app container already exists with its route: the window stops it, copies the delta,
  runs the `release` service once more on the final data, and starts the container again in
  place, with no workflow run.
- **PostgreSQL** stays as today: dumped and restored in the window. Its dump is already consistent
  while it runs; a live pre-dump would not shorten the window, since the final data must be dumped
  again. Logical replication is left for later.
- **PostgreSQL, MySQL and MariaDB before the window** (T3102's review, 2026-11-20):
  - **The problem:** the app's check before the window needs consistent data. A database's files
    copied while it writes are not a consistent snapshot, and InnoDB may refuse to start on them.
  - **So:** these three are dumped consistently (`pg_dump`, `mysqldump --single-transaction`) and
    restored on the new side for the pre-copy.
  - **In the window:** MySQL's and MariaDB's data folder is copied as files with the service
    stopped, which is consistent. After the restore the files differ, so that copy is about the
    whole folder: such a database still lengthens the window by its size.
  - **Other stateful services** keep the live file copy. One that fails to start on it stops the
    pre-copy before any downtime.
- **Workers and cron** start with the app's check before the window and stop right after it, so
  no job runs on both servers.
- **Portainer's new side** gains the pre-copy and the delta (its carrier is the same); its app's
  start stays as today.

## R4. Every cost in the plan (2026-11-20, agreed with the portal's lead)

```yaml
cost:
  monthly: {amount, currency}                 # the running items' monthly total, as before
  breakdown:                                  # running items
    - item: "Server cx23 (nbg1)"
      provider: hetzner                       # the core's provider id, on every billed entry
      monthly: {amount, currency}             # for an hourly item, its monthly cap
      billing: hourly                         # hourly | monthly | free
      hourly: {amount, currency}              # hourly items only
      since: 2026-11-08T07:13:45Z
  oneTime:                                    # current and previous calendar month
    - {item: "Setup fee (V153)", provider: contabo, price: {amount, currency}, at: 2026-11-20T13:17:00Z}
  ended:                                      # removed this or last calendar month
    - {item, provider, monthly, billing, hourly?, since, until}
retarget:                                     # only while a move runs
  from:
    running:                                  # the old side's items, still billed during the move
      - {item, provider, monthly, billing, hourly?, since}
```

- **A free line** (`billing: free`: a second app, a server of the user's, a Portainer, a hosting
  account) may have no `provider`.
- **During a move** `cost` is the new side's alone, and the old side's running items are in
  `retarget.from.running`, so both are counted while both run. `--finish` moves them to
  `cost.ended` with `until`; `--abort` puts them back in `cost` (T3109's review, 2026-11-20).

- **Billing models:**
  - Hetzner and DigitalOcean servers, IPv4, backups (20% of the server) and snapshots (per GB)
    are `hourly`: each started hour up to the monthly cap. DigitalOcean counts seconds, which differs
    by less than one hour's price.
  - Contabo is `monthly`: the full price at each term start, from `since`; a removed server's last
    term was prepaid.
  - A second app's €0 item is `free`.
- **The portal computes "so far" and the "~" forecast from these.** Older plans without them stay a
  "~" run rate.
- **A domain OpsCrew bought** (added 2026-11-20, the founder's question; to agree with the portal's
  lead):

  ```yaml
  cost:
    oneTime:
      - {item: "example.com, 1 year", provider: cloudflare, price: {amount, currency}, at: …}
    renewals:                                 # charges that recur on their own
      - item: "example.com"
        provider: cloudflare                  # the registrar's id: cloudflare, porkbun, namecheap, godaddy
        price: {amount, currency}             # the renewal price per year, as quoted at the purchase
        next: 2027-11-20                      # the domain's expiry; the registrar charges up to 30 days before
        autoRenew: true
  ```

  - **The purchase** goes into `oneTime` with its price, registrar and time.
  - **The renewal** shows in the month of `next`, as a "~" forecast. The registrar charges it on
    its own, so OpsCrew learns of it only when it reads the registrar: `opscrew status` and
    `opscrew domain status` do once `next` is within 30 days or past (`domain.registration`
    already holds the expiry). When the expiry moved on, the renewal goes into `oneTime` at the
    day the registrar charged when its answer gives one (Cloudflare charges up to 30 days early,
    so the old `next` can fall in the wrong month), else at the old `next`, and `next` moves a year
    on. The portal's lead agreed (2026-11-20): with `autoRenew: false` the portal forecasts no
    charge and says the domain expires then; unknown `provider` ids show under "Other
    providers", so a new registrar is announced to it. With auto-renew off, they warn that the domain expires.
  - **A domain the user bought elsewhere** has no entry: OpsCrew doesn't know its price.

## R3. Left for later

- **A direct transfer between the servers** (a one-off key or port installed and removed by the
  move's plans): the delta is small, so only the pre-copy, without downtime, would gain.
- **Replication** (MySQL binlog or GTID, PostgreSQL logical) for a near-zero window on busy
  databases.
- **A read-only mode** kept up during the window, for apps that have one.
