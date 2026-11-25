# Alerts: the scheduled check

OpsCrew adds a scheduled check to your repository that runs in [GitHub Actions](https://github.com/features/actions). On a schedule, it
checks that your app answers, that its certificate is valid and that its server's disk has room.
When something fails, it opens a GitHub issue, so everyone watching the repository is told, and it
can post the same message to [Slack](https://slack.com/), [Discord](https://discord.com/) or [ntfy](https://ntfy.sh/). When the app recovers, it closes the issue and
says how long the problem lasted. When your DNS is on Cloudflare,
a Worker in your own Cloudflare account can check that the app answers instead, with no Actions
minutes: see [In your Cloudflare account instead of GitHub Actions](#in-your-cloudflare-account-instead-of-github-actions).

Nothing runs on your server for it, apart from a disk job on a server that deploys from its own
runner. With the default interval it costs nothing: Actions minutes are free in a public repository,
and in a private one the check uses a small share of the minutes your plan includes.

## Turning it on

`npx opscrew design` turns the check on for prod and leaves it off for other environments. It shows
the interval, what the check reads and its Actions minutes a month. To change it for an environment,
set `observability.check.enabled` to `true` or `false` in that environment's plan
(`opscrew/plan.yaml` for prod, `opscrew/environments/<env>/plan.yaml` for another), then run
`npx opscrew provision`.

`provision` then, each step after its own approval:

1. puts the check key on the server, for the disk and snapshot checks (see [below](#where-it-runs));
2. stores the check's secrets in GitHub: the check key, how to reach the server, and the webhook's
   address when you set one. The approval lists their names; the values are never shown;
3. adds three files to the deploy-setup pull request:
   - `.github/workflows/opscrew-check.yml`, the workflow;
   - `opscrew/check/check.json`, what to check, rendered from every app's and environment's plan;
   - `opscrew/check/check.mjs`, the check itself: a readable script with no dependencies, the same
     in every repository.

Merge the pull request, and the check runs on its schedule. To run it at once:
`gh workflow run opscrew-check.yml`, or **Run workflow** on the "OpsCrew check" page of the
repository's Actions tab.

In scripts, `npx opscrew provision --plan-only` lists the check key's host plan with its hash, next
to the others, so every hash can be approved up front.

One check covers every app and environment in the repository, so the minutes don't multiply. Each
issue names its app and environment.

### The GitHub token

Your `GITHUB_TOKEN` needs these repository permissions besides the
[usual ones](security.md#the-github-token), only with the check on. `npx opscrew init` checks them
and names any that is missing.

- Issues: Read, for the open alerts in `status`;
- Actions: Read and write, which OpsCrew already asks for, for the check's state in `status`;
- Variables: Read and write, for pausing the check while OpsCrew moves or removes an app. The
  token needs it without the check too: for moving an app to another target, and for
  [`opscrew rollback`](rollback.md), which pauses an environment's deploys.

The workflow itself runs with GitHub's own token, limited to reading the repository's contents and
writing issues.

## What it checks

| Check | Fails when | The issue says |
|---|---|---|
| Each hostname (and `www` when the app serves it) at its health path over HTTPS | No answer within 10 seconds, or a status of 400 or more, on three tries 30 seconds apart. One slow answer opens nothing | The hostname, the status code or the error (such as `ECONNREFUSED`), and when it started |
| Each hostname's certificate | Fewer than 14 days left. Certificates are renewed 30 days before they expire, so this means the renewal is failing | The days left, and the command to see why |
| Each server's disk | 85% full, and again at 95% | The server, its free space and what usually fills it (old images and logs) |
| With [scheduled snapshots](snapshots.md#the-schedule) on, the last one of each app on each server with its data | The last scheduled snapshot failed, or its [copy off the server](snapshots.md#an-encrypted-copy-off-the-server) did. A snapshot being taken is checked at the next run | The server, when it failed, the snapshot's id for a failed copy, and to run `npx opscrew status` to see why |
| With [scheduled restore drills](snapshots.md#on-a-schedule) on, the last one of each app on its server | The last scheduled drill that ran didn't restore the snapshot, or the app didn't become healthy on it, or the copy couldn't be made; or no scheduled drill ran within twice the schedule and an hour (since the last one, or with none yet, since the schedule was turned on or the oldest scheduled snapshot, whichever is later). A skipped drill never opens one | The server, when it failed and which of those it was, or since when none ran, and to run `npx opscrew status` to see why |

On a hostname behind [Cloudflare](https://www.cloudflare.com/)'s proxy, the certificate the check sees is Cloudflare's.
`npx opscrew secure` and `npx opscrew status` check the server's own.

A server that several environments share is checked once.

## Where it runs

The check runs on GitHub's `ubuntu-slim` runner, a small machine that takes under half a minute for
the whole check.

The disk and the scheduled snapshots are read where the deploy job runs:

- **When GitHub deploys to the server over SSH,** the check connects with the **check key**: one key
  pair per repository, which OpsCrew makes. Its public half is in the deploy user's
  `authorized_keys` on each checked server, limited to one fixed, read-only command. Whatever the
  key asks for, the server runs only that, with no shell, no terminal, no port forwarding and no
  file copy. The command reads:
  - the disk's size and free space (`df -P -B1 /`);
  - for each app with a scheduled snapshot's log (`.snapshots/scheduled.log` in the app's folder),
    only when the log was last written, the id of its last scheduled snapshot, how many lines
    followed that id, and whether a snapshot is being taken now. Nothing else of the log;
  - for each app with restore drills (`.snapshots/drills.log`), only the end and the result of
    its last scheduled drill that ran.

  A leaked check key reads those figures, ids and times.
  - A new cloud server gets the key's line when it is created, in the infrastructure plan.
  - An existing server, or your own, gets it through a host plan that you approve by its hash.
  - A server set up before the check read snapshots (or restore drills) has a key line that reads
    less: the check says so in its run. `npx opscrew provision` gives the app's server and your
    own servers the new line; another server OpsCrew created gets it when it is created again.
- **On a [runner machine](runners.md#runner-machines),** a job on that machine uses the check key in
  the same way.
- **On a server that deploys from [its own runner](runners.md#the-servers-runner),** a job on that
  runner runs the same command there, so GitHub needs no way in. Jobs on self-hosted runners cost no Actions
  minutes. When the server is down, its disk job waits for the runner, and the main check reports
  the outage over HTTPS meanwhile.

The check key's private half is the repository secret `OPSCREW_CHECK_SSH_KEY`. Each environment's
server address, SSH port, user and host key are in the repository secret `OPSCREW_CHECK_SERVER`
(with the environment's prefix outside prod). `check.json` names those secrets and never an
address, so a proxied site's server stays hidden. The key is also in the
[recovery copy](secrets-recovery.md).

## The issues

Each failing check gets one issue, labelled `opscrew-check`, with a title such as
"OpsCrew check: example-app (prod) does not answer on example.com". The body says when it started,
what failed, and what to run to see more (`npx opscrew status`, `npx opscrew logs`).

- **While the problem lasts,** later runs add nothing to the issue.
- **When what fails changes,** for example a timeout that becomes a 502, the check adds one comment
  and updates the title.
- **When the check passes again,** it closes the issue with how long the problem lasted.
- **A check that is no longer in `check.json`** gets its open issue closed with that reason.

GitHub tells everyone watching the repository about a new issue, by email too, depending on each
person's notification settings. The issues are opened by `github-actions[bot]`.

What goes into an issue or a post is fixed text, names, hostnames, status codes, error codes, days,
disk figures and snapshot ids and times. The check never copies what your app answered, its
headers, what a snapshot's log said or a server's address, so nothing your app returns can carry a
secret into them.

## The webhook: Slack, Discord or ntfy

The check can post the same message when it opens or closes an issue. Choose one kind for the
repository in `opscrew/plan.yaml` (the first app's prod plan; any other plan refuses it):

```yaml
observability:
  check:
    webhook: ntfy   # or slack, or discord
```

Then run `npx opscrew provision`. In a terminal it asks for the webhook's address without showing
it; in scripts, set `OPSCREW_CHECK_WEBHOOK` to the address. The address is stored only as the
repository secret `OPSCREW_CHECK_WEBHOOK`, never in a file, a plan, a log or the audit log.

- **Slack:** create an app at <https://api.slack.com/apps>, turn on **Incoming Webhooks**, choose
  **Add New Webhook to Workspace** and the channel, and copy the URL. Messages are cut at 4,000
  characters.
- **Discord:** in the channel's settings, **Integrations** → **Webhooks** → **New Webhook**, then
  **Copy Webhook URL**. The check's messages mention nobody. They are cut at 2,000 characters.
- **ntfy:** the topic's URL, such as `https://ntfy.sh/<topic>` or a topic on your own ntfy server.
  On ntfy.sh, anyone who knows a topic's name can read it, so pick a long, random one, or protect it
  and set `OPSCREW_CHECK_NTFY_TOKEN` to an access token. Openings are sent with priority 4, closings
  with 3. ntfy.sh allows 250 messages a day.

GitHub keeps the address it holds. To change it, or after changing the webhook's kind, set
`OPSCREW_CHECK_WEBHOOK` to the new address and run `npx opscrew provision` again: without it, the
check keeps posting to the old address.

## The interval and what it costs

The check runs every 60 minutes in a private repository and every 15 in a public one. Set another
interval for the whole repository in `opscrew/plan.yaml`: `observability.check.intervalMinutes`, one
of 5, 10, 15, 20, 30 or 60. GitHub runs schedules at most every 5 minutes. The check starts at a
minute off the hour, which your repository's name picks, because GitHub delays the runs it has to
start at the top of each hour.

In a public repository, the check's minutes are free. In a private one, GitHub rounds each run up to
a whole minute, and a minute on `ubuntu-slim` uses a third of an included minute. Over a 31-day
month:

| Interval | Runs | `ubuntu-slim` minutes | Included minutes used |
|---|---|---|---|
| 60 minutes | 744 | 744 | 248 |
| 30 minutes | 1,488 | 1,488 | 496 |
| 20 minutes | 2,232 | 2,232 | 744 |
| 15 minutes | 2,976 | 2,976 | 992 |
| 10 minutes | 4,464 | 4,464 | 1,488 |
| 5 minutes | 8,928 | 8,928 | 2,976 |

GitHub Free includes 2,000 minutes a month for private repositories, and Pro and Team 3,000. Design
shows the check's minutes against your plan, and warns when an interval you set uses more than 750
`ubuntu-slim` minutes a month on GitHub Free. Without a payment method, GitHub stops every job once
the included minutes run out, deploys included.

## GitHub's 60-day rule

In a public repository, GitHub turns scheduled workflows off after 60 days without activity in the
repository. GitHub doesn't document whether it tells anyone. So the check warns itself: from 50 days
after the last commit on the default branch, it opens an issue that says how to keep it running. It
closes that issue when a newer commit appears.

- **To keep it running,** push any commit to the default branch within every 60 days.
- **When GitHub has turned it off,** `npx opscrew status` says so. Turn it on again on the
  repository's Actions tab ("OpsCrew check", then **Enable workflow**), or with
  `gh workflow enable opscrew-check.yml`.

A private repository has no such rule.

## Planned outages, forks, and issues turned off

- **Planned work:** while [`npx opscrew retarget`](retarget.md) moves an app (its maintenance
  window), OpsCrew pauses the check for that environment after an approval of its own. When
  `npx opscrew destroy` removes an app, OpsCrew pauses the check after the teardown, as part of
  destroy's own typed confirmation (destroy says so before you type the name). No separate question
  is asked, and in a script `--confirm <app>` covers it (a rerun with nothing left to delete asks
  for the pause on its own). The check then opens no issue for the environment, and closes its open
  ones with the reason. The pause is the repository variable `OPSCREW_CHECK_PAUSED`. The next
  healthy deploy by `npx opscrew provision`, or `retarget --finish`, removes it again.
- **Your own maintenance:** `gh workflow disable opscrew-check.yml` pauses the whole check, for every
  app of the repository, and `gh workflow enable opscrew-check.yml` turns it on again. The Actions
  tab has the same buttons.
- **Forks:** GitHub keeps scheduled workflows off in forks, and the workflow runs only in your
  repository, so a fork opens no issues.
- **Issues turned off** in the repository: design says so. The check then posts to the webhook and
  writes the run's summary, and its run fails while something fails. A failed scheduled run tells
  only the person who last changed the workflow's schedule. With no issue to record that a message
  was already sent, the webhook gets the message on every failing run.

## Turning it off

Set `observability.check.enabled` to `false` in the environment's plan and run
`npx opscrew provision`: its pull request updates `check.json`. When no environment has the check
on any more, the next deploy-setup pull request removes `.github/workflows/opscrew-check.yml` and
`opscrew/check/`.

The check key's line in the server's `authorized_keys` (it can only run the check's read-only
command) and the secrets
`OPSCREW_CHECK_SSH_KEY` and `OPSCREW_CHECK_SERVER` (with the environment's prefix outside prod) stay
until the environment is destroyed. To delete the secrets earlier, run `gh secret delete <name>` for
each.

## In your Cloudflare account instead of GitHub Actions

In a private repository the scheduled check uses Actions minutes. If you'd rather not spend them,
a Worker in your Cloudflare account, on Cloudflare's free plan, can check that the app answers
instead, and post down and recovered messages to your webhook.

### Choosing it

Set the runner in the environment's plan, beside `enabled`:

```yaml
observability:
  check:
    enabled: true
    runner: cloudflare   # or actions, the default
```

It needs:

- the app's DNS on Cloudflare (`dns.provider: cloudflare`), since the Worker runs in the Cloudflare
  account of the app's zone. The plan is refused otherwise;
- a server, a Portainer, or a site on Cloudflare or GitHub Pages: a [hosting account](hosting-accounts.md)
  can't use the Worker yet, and its plan is refused with `runner: actions` as the way on;
- a [webhook](#the-webhook-slack-discord-or-ntfy) for the repository. The Worker opens no GitHub
  issue, so its messages go only there, and `provision` stops before any change without one;
- two more permissions on the Cloudflare token, listed in
  [The Cloudflare token](security.md#the-cloudflare-token). `npx opscrew init` names any that is
  missing.

Then run `npx opscrew provision`. It shows a Cloudflare plan with its hash for you to approve:

- the Worker `opscrew-uptime`, its schedule of every 5 minutes and its storage (a Workers KV
  namespace, also named `opscrew-uptime`), each created only when missing;
- this environment's entry: its hostnames and its health path;
- the entry's webhook secret, by name only. The address is stored only as a secret of the Worker,
  never in the plan, a log or a file.

There is one Worker per Cloudflare account, shared by every app that chooses it. A second app's
plan adds only its own entry and secret, and names the other apps' entries it keeps.

A new schedule can take up to 15 minutes to start at Cloudflare, so the first run may come that
late.

### What counts as down

Every 5 minutes, the Worker tries each hostname once at its health path over HTTPS, the same
hostnames as the Actions check. A try fails on no answer within 10 seconds, or a status outside 200
to 399. Redirects aren't followed, so a redirect counts as an answer.

One failed try sends nothing. A second failure in a row, at the next run, sends one "down" message,
so you hear within about 10 minutes, and a restart during a deploy doesn't alert. While the app
stays down, nothing more is sent. When it answers again, one "recovered" message, within about 5
minutes, says how long it was down.

The reason in a down message is one of:

- **not reachable:** no answer, a network error, or Cloudflare saying it couldn't reach the server;
- **an invalid certificate:** Cloudflare couldn't verify the server's certificate;
- **answered with status N,** for any other failing status.

The messages are fixed text: the app, the environment, the hostname, the reason, the times and the
command `npx opscrew status`. They never hold what your app answered, its headers or an address.
A message that can't be sent is sent again at the next run.

`npx opscrew status` says that the Worker checks the environment, and lists the hostnames that are
down and since when. When the Worker or the entry is gone, it says to run `npx opscrew provision`.

### What it doesn't check

The Worker can't reach your server, so for an environment with `runner: cloudflare` these checks
don't run: the disk, the [scheduled snapshots](snapshots.md#the-schedule), the
[restore drills](snapshots.md#on-a-schedule) and the certificate's days left. **The disk,
snapshot, restore-drill and certificate-days checks need `runner: actions`.** `npx opscrew status`
still shows those figures when you ask.

### Cloudflare's free limits

- **40 hostnames per Cloudflare account,** across every app's entries. The plan refuses the 41st
  before anything changes; keep `runner: actions` for that app.
- **The schedule** takes one of the 5 Cron Triggers that Cloudflare's free plan gives an account.
- **Workers KV's daily limits** are your account's, shared with your own Workers. A healthy day
  writes nothing, and each failure costs a few writes.

### Moves and planned work

- **No pause:** OpsCrew doesn't pause the Worker while [`npx opscrew retarget`](retarget.md) or a
  move runs, so it may send a down message and then a recovered one.
- **Another Cloudflare account:** [`npx opscrew cloudflare move`](cloudflare-move.md) refuses an app that the Worker
  checks. Set `observability.check.runner` to `actions`, run `npx opscrew provision`, then move.

### Switching back

Set `runner: actions`, or turn the check off, and run `npx opscrew provision`. Its plan removes only
this environment's entry, its state and its secret. The Worker, its schedule and its storage stay,
even when no app uses them: they cost nothing, do nothing, and the next app reuses them. They go
only when the last app that has an entry is removed with `npx opscrew destroy`, under destroy's own
typed confirmation.

## What it can't do

- **Alert within a minute:** GitHub runs schedules at most every 5 minutes. Expect an issue within
  the interval, plus whatever delay GitHub adds to scheduled runs when it is busy (often several
  minutes, sometimes more), plus up to a minute of retries.
- **Check your computer:** GitHub can't reach an app running [on your computer](localhost.md), so
  design offers no check there.
- **Read the disk, the scheduled snapshots or the restore drills of a [Portainer](https://www.portainer.io/)'s server:** OpsCrew reaches your Portainer only through its API.
  The check still checks the app's hostnames, and `npx opscrew status` shows the last snapshot and
  its result, and the last drills.
- **Read the restore drills of a [hosting account](hosting-accounts.md#restore-drills):** the
  check has no way into the account. `npx opscrew status` shows the last drill there (see
  [Status and alerts](snapshots.md#status-and-alerts)).
- **Read the disk of your own server reached through a [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/),** unless the server
  deploys from [its own runner](runners.md#the-servers-runner): the check's SSH can't pass the
  tunnel's [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) login.
- **Disks on Cloudflare's hosting and [GitHub Pages](https://pages.github.com/):** there is no server of yours. Their hostnames
  and certificates are checked.
- **Watch memory and CPU:** `npx opscrew status` shows them, and [Beszel](beszel.md) can alert on
  them.

## From Claude Code

The [OpsCrew plugin](claude-code-plugin.md)'s status answer includes the check's state and its open
alerts.
