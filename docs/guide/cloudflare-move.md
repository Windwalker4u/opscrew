# Moving your app to another Cloudflare account: `opscrew cloudflare move`

`opscrew cloudflare move` moves an app's Cloudflare setup from the account that holds its zone to
another Cloudflare account of yours: the domain, its DNS records, OpsCrew's rules, the app's
Cloudflare Tunnel and Access, a site's Worker, its R2 buckets with their files, and its origin
protection. Your server, your Portainer, your hosting account and your data stay where they are.

On this page, **the old account** holds the zone when the move starts and **the new account** is the one it moves
to. Cloudflare moves nothing between accounts by itself: the domain is added to the new account as
a new zone, and the nameservers then switch to it. OpsCrew does that work in four commands:

```bash
npx opscrew cloudflare move --to <account>   # prepare, while the old account keeps serving
npx opscrew cloudflare move --switch         # point the domain at the new account
npx opscrew cloudflare move --finish         # put the app on its new pieces, remove the old ones
npx opscrew cloudflare move --abort          # before the switch: remove what the move made
```

`--to` takes the new account's id or its exact name. Without `--to`, a move that was started goes
on; a different `--to` is refused. Every step runs from the app's repository, and `--app <key>`
picks [another app](several-apps.md) of it. `--env` is refused: the move covers every
[environment](environments.md) of the app whose domain is in the zone, since they share it.

## When to use it

- An agency hands a client's app over to the client's own Cloudflare account.
- You move from a personal account to your company's.
- You merge two accounts into one, so the old one can be closed.

The zone moves whole: its nameservers change once. So every OpsCrew app in the zone moves with it,
each prepared from its own repository (see [Several apps in one zone](#several-apps-in-one-zone)).
To move the app itself to another server or host, use [`opscrew retarget`](retarget.md) instead.

Setting `CLOUDFLARE_API_TOKEN` to another account's token doesn't move anything: the app's
infrastructure state still names the old account's pieces, so the next provision fails.

## Before you move

- **The new account.** Create it, and turn on [R2](https://developers.cloudflare.com/r2/) there
  when the app has R2 buckets (Cloudflare asks for a payment method when R2 is turned on, even
  within its free tier) and [Zero Trust](https://developers.cloudflare.com/cloudflare-one/) when the
  app uses Cloudflare Access. The new zone starts on Cloudflare's Free plan.
- **A token for the new account,** in `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_API_TOKEN`
  stays the old account's token until the move is finished (see
  [The token for the new account](#the-token-for-the-new-account)).
- **Up-to-date files.** An app set up by an earlier version of OpsCrew may have a deploy workflow,
  or a site's infrastructure files, that can't deploy to two accounts during a move. The move then
  stops before any change and says so: run `npx opscrew provision`, commit and push what it wrote,
  then start the move.
- **This computer.** Run every step of an app on the computer that deployed it: it has the app's
  infrastructure state, and the move keeps the new account's states next to it. The
  [recovery copy](secrets-recovery.md) doesn't hold them, so don't switch computers in the middle
  of a move.
- **Previews off.** An app with [previews](previews.md) per pull request is refused: turn them off
  first (`npx opscrew destroy --env <name>`, then `npx opscrew env remove <name>`), move, and turn
  them on again afterwards.
- **What OpsCrew doesn't move.** Redo in the new account, before the switch, what you set up
  yourself (see [What OpsCrew doesn't move](#what-opscrew-doesnt-move)).
- **The registrar's credentials,** when the domain is at Porkbun, Namecheap or GoDaddy, for the
  switch (see [The registrar](#the-registrar)).
- **A quiet time for the switch.** Visitors may get certificate errors for a while after it (see
  [The HTTPS gap](#the-https-gap)).

The move stops before any change, and says why, when the old account's zone isn't active or has a
zone hold (release it in the zone's Overview), when an environment of the app is moving with
[`opscrew retarget`](retarget.md), or when another app of the repository is moving the same zone
to a different account.

### The token for the new account

Create it in the new account at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with the
permissions your `CLOUDFLARE_API_TOKEN` has (see
[Cloudflare token permissions](cloudflare.md#cloudflare-token-permissions)), plus
**Zone → Zone → Edit**, so OpsCrew can add the domain there. Since the zone isn't in the new
account yet, give every zone permission of the token all zones of the account. Then add the account
permissions of the pieces the app uses:

| The app has | Account permission |
|---|---|
| A Cloudflare Tunnel (tunnel mode, Portainer or Beszel on a subdomain, Portainer's tunnels) | Cloudflare Tunnel → Edit |
| Cloudflare Access (a tunnel's hostnames, Portainer's Cloudflare redeploys) | Access: Apps and Policies → Edit, and Access: Organizations, Identity Providers, and Groups → Edit |
| Deploys through Access (tunnel mode, Portainer's webhook) | Access: Service Tokens → Edit |
| An R2 bucket, or the snapshots' copies on R2 | Workers R2 Storage → Edit |
| A site on [Cloudflare's hosting](cloudflare-hosting.md) | Workers Scripts → Edit |

```bash
export OPSCREW_NEW_CLOUDFLARE_API_TOKEN=...      # the new account's token
export OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN=...   # a site on Cloudflare's hosting only
```

OpsCrew checks both accounts' API tokens before anything changes, and names each missing account
permission. It checks the zone permissions right after it adds the zone to the new account, before
anything else changes there.

A site on Cloudflare's hosting also needs a deploy token for the new account, in
`OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN`: a token of its own with only Account → Workers Scripts →
Edit for the new account, as [its deploy token](cloudflare-hosting.md#the-tokens) has for the old
one. OpsCrew checks it before it stores it in GitHub.

### Cloudflare Registrar and the old account's token

When the domain isn't in a Porkbun, Namecheap or GoDaddy account whose credentials are set, the
switch and the abort tell whether Cloudflare Registrar holds it. No extra permission is needed:

- **With the Registrar permission** on `CLOUDFLARE_API_TOKEN`, OpsCrew reads Cloudflare Registrar in
  the old account directly.
- **Without it,** OpsCrew goes by Cloudflare's record of the domain's registrar on the new account's
  zone: Cloudflare Registrar when that record names Cloudflare, otherwise another registrar. An info
  line says so.

After the switch, OpsCrew checks with the new account's token whether Cloudflare's move between
accounts took the registration there, and goes by the same rule when that token can't read
Cloudflare Registrar.

## How a move works

1. **Prepare**, in each app's repository. The new account gets the app's pieces next to the old
   account's, which keeps serving every request.
2. **Switch**, once, from any of those repositories. The domain's nameservers change to the new
   account's, and Cloudflare activates the zone there.
3. **Finish**, in each repository, right after the switch. The app runs on its pieces in the new
   account, and its pieces in the old account are removed.

Each plan is shown first and applied only once you approve its exact hash. Every deletion of a
resource, a bucket or a zone asks you to type a name as well. Each step remembers where it got to, in `opscrew/plan.yaml` and on this
computer: if a run stops (a step failed, you declined an approval, the terminal closed), run the
same command again and it goes on from there, repeating nothing that is done.

## Prepare

```bash
npx opscrew cloudflare move --to <account>
```

OpsCrew checks both tokens, lists the other OpsCrew apps it finds in the zone (by their hostnames)
and measures each R2 bucket on the app's server (in your Portainer, through it). Then it shows a
summary: the new zone, each environment's pieces in the new account, the buckets with their size,
object count and copy time, the finish's maintenance window, and the switch's HTTPS gap. Nothing in
Cloudflare changes until you approve its first plan.

Then, each from a plan you approve:

1. **The zone.** The domain is added to the new account as a new zone, pending until the switch.
   The old zone's records that belong to no OpsCrew app are copied into it with their proxied
   state, comments and TTL. A record that is in the new zone already with other content, or only
   there, is listed and never changed. Records Cloudflare manages itself (Email Routing's, a
   Worker's custom domains) aren't copied.
2. **Each environment's pieces:** OpsCrew's rules for its hostnames, its DNS records, its tunnel,
   its Access policies and service tokens, a site's Worker with the code it runs, its R2 buckets
   (with the same names), and [origin protection](origin-protection.md)'s client certificate with
   its per-hostname setting. Cloudflare Access applications, the records of the hostnames they
   protect and the new origin certificate can't be made on a pending zone: the switch makes the
   first two, the finish the certificate.
3. **The connector beside the old one.** On a server with a Cloudflare Tunnel, the new account's
   connector runs next to the old account's, from a host plan (in your Portainer, a stack plan).
4. **GitHub's extra deploy secrets:** the new account's Access credentials, and a site's account id
   and deploy token, next to the old ones (see [Deploys during the move](#deploys-during-the-move)).
   For a site, its deploy workflow then runs, so the new account's Worker runs the current code.
5. **The first copy of each R2 bucket** (see [R2 buckets](#r2-buckets)).
6. **The mark:** a TXT record whose name starts with `_opscrew-move.`, in the new zone, which tells any
   repository's switch that the app is ready. It holds the app's name, its environments, its
   hostnames and a site's Worker name: no secret, no id, no repository.

The new zone serves nothing while it is pending. Still, its nameservers answer anyone who asks them
directly, from the moment each record is made there: a proxied record with your server's own
address (not Cloudflare's), and a tunnel's record with the tunnel's id. With
[origin protection](origin-protection.md), your server still accepts the app's connections only
from Cloudflare acting for your zone.

## Switch

```bash
npx opscrew cloudflare move --switch
```

Run it once, from any repository whose app is prepared, with both Cloudflare tokens, your GitHub
token and the registrar's credentials set. It stops, naming the hostnames, while an OpsCrew app in the zone isn't prepared:
run the prepare in the repository that deploys them, or remove those records from the old account
if no app uses them. It also stops when it can't read something it needs to tell (a missing
permission, a damaged mark).

The switch plan lists the records the old zone gained since the prepare (copied the same way), the
nameservers before and after, the registrar, the DNSSEC change, every prepared app, and what it
does once the new zone is active. You approve it by typing the domain's name.

**Email Routing stops at the switch.** The zone copy leaves out
[Email Routing](https://developers.cloudflare.com/email-routing/)'s records, since Cloudflare
manages them itself. So from the switch, mail to the zone's addresses stops arriving until Email
Routing is set up in the new account, with its routing rules and destination addresses. If the
zone uses it, set it up there right after the switch.

Then:

1. The nameservers change (see [The registrar](#the-registrar)).
2. OpsCrew asks Cloudflare to check them and waits until the new zone is active: usually within an
   hour, at worst 24 hours. On the Free plan Cloudflare allows such a check once an hour.
3. Right after activation, for every prepared app in the zone: its Access applications, then the
   records of the hostnames they protect, then a site's custom domains attached to its Worker in
   the new account (detached from the old account's Worker first, when Cloudflare says it still
   holds them).
4. DNSSEC is turned on in the new zone when it was on in the old one.
5. OpsCrew waits for the new zone's certificate and for each hostname to answer over HTTPS, then
   reports how long each took (see [The HTTPS gap](#the-https-gap)).
6. It lists the finish to run in each repository, origin-protected apps first.

A run waits at most two hours. If the zone isn't active, the certificate isn't issued or a hostname
doesn't answer over HTTPS yet by then, it stops and says so: run it again later, and it goes on with the times measured so far.

### The registrar

| Where the domain is registered | What the switch does |
|---|---|
| Porkbun, Namecheap or GoDaddy, with its credentials set (`PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY`, `NAMECHEAP_API_USER` and `NAMECHEAP_API_KEY`, or `GODADDY_API_TOKEN`) | Sets the new account's nameservers through the registrar's API |
| [Cloudflare Registrar](https://developers.cloudflare.com/registrar/account-options/inter-account-transfer/), in the old account | Prints the dashboard steps of Cloudflare's move between accounts and stops: start it in the old account's dashboard (Domain Registration, Manage Domains, the domain, Configuration), then accept it in the new account's within five days. Cloudflare then gives the domain the new account's nameservers |
| Any other registrar | Prints the new account's nameservers for you to set at the registrar, and stops |

When OpsCrew can't set the nameservers itself, run `npx opscrew cloudflare move --switch` again
once you made the change: it finds the new nameservers and goes on.

At Cloudflare Registrar, the registration's settings in the old account are not kept. Cloudflare's
page above lists what its move needs, for example a domain older than 10 days and a verified
registrant email, and the domain can't be transferred to another registrar for 30 days after it.

### DNSSEC

With DNSSEC on, the domain's DS record must be gone from the registry, and resolvers must have
forgotten it, before the nameservers change. Otherwise visitors whose resolver checks DNSSEC can't
reach the domain at all. The domain keeps working from the old account meanwhile.

**At Porkbun,** whose API removes DS records, the switch takes two runs and two approvals:

1. **The first run** removes the DS record, as part of the switch plan you approve, and stops. It
   says when the switch can go on: 24 to 48 hours after the removal.
2. **The run after the wait** plans the switch again, and asks for a new approval.

**At Namecheap, GoDaddy, Cloudflare Registrar or another registrar,** you turn DNSSEC off yourself:

1. **The first run** stops with nothing changed and says where to turn DNSSEC off: in the
   registrar's dashboard, or at Cloudflare Registrar in the old account's dashboard (the zone's
   DNS, Settings, DNSSEC). There Cloudflare removes the DS record from the registry itself, usually
   within a day.
2. **Run it again** once you did. While the registry still publishes the DS record, it stops again.
   The first run that finds it gone says when the switch can go on: 24 to 48 hours from then.
3. **The run after the wait** plans the switch and asks for its approval.

After activation, DNSSEC is turned on in the new zone. Its DS record is published through the API
at Porkbun, and by Cloudflare itself at Cloudflare Registrar. At Namecheap, GoDaddy or another
registrar, the switch prints the DS record for you to add there.

## The HTTPS gap

Certificates don't move between Cloudflare accounts. The new zone's free
[Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/) certificate
is issued only once the zone is active, which takes minutes, at worst 24 hours. From the nameserver
change until then, HTTPS visitors may get certificate errors. The switch's approval says so, and its
report gives the measured times: from the nameserver change to activation, from activation to the
certificate, and to each hostname's first good answer.

- **A domain whose name is HSTS-preloaded** (every `.dev` domain, for example): browsers offer no
  way past a certificate error, so the gap is an outage for its visitors. Pick a quiet time.
- **Paid certificates** could close the gap: an
  [Advanced certificate](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
  ordered before the move ($10 a month) or a custom certificate uploaded to the pending zone (Business
  plan or higher). OpsCrew doesn't use either.
- **A site on [Cloudflare's hosting](cloudflare-hosting.md)** answers from the new account once the
  switch attaches its custom domains, right after activation, and then needs the certificate like
  any hostname.
- **Hostnames behind Cloudflare Access** (a tunnel's SSH hostname, Portainer or Beszel on a
  subdomain) have no record in the new zone until the switch makes their Access applications and
  records, right after activation. So from the nameserver change until then, resolvers that
  already ask the new account's nameservers get no answer for them.
- **An app with [origin protection](origin-protection.md)** may answer 526 from activation until its
  finish: until then its server serves the old account's origin certificate, and whether the new
  account's zone accepts it isn't confirmed. Run each finish right away; the switch lists them
  first.
- **[GitHub Pages](github-pages.md) and [hosting accounts](hosting-accounts.md)** have no gap: their
  records are DNS only, and the host serves its own certificate.

## Finish

```bash
npx opscrew cloudflare move --finish
```

Run it in each repository once the switch says the zone is active. It is refused before then, and
until every environment of the app is prepared. It handles one environment at a time:

1. **The new origin certificate** is issued in the new account, for an app with origin protection.
2. **The deploy secrets and settings that name the old account** take the new account's values, in
   one approval that lists their names (never their values): the origin certificate, the
   snapshots' bucket and, with an app bucket, the app's R2 endpoint and key. One deploy then writes
   them on the server and starts the app on them. In your Portainer, one stack plan does the same.
   With an app bucket on R2, this runs inside the maintenance window (see
   [R2 buckets](#r2-buckets)). In a terminal as in a script, OpsCrew asks this approval first,
   then the window's, both before the app stops, so nothing is asked while the app is offline.
3. **The snapshots' copies** made since the first copy are copied once more.
4. **The connector.** The server's connector takes the new account's tunnel token, then the one
   beside it goes.
5. **What the switch made** (the Access applications and their records, a site's custom domains)
   joins the app's infrastructure state. Then, in an approval of their own, the deploy's
   credentials take the new account's values (the Access deploy credentials, or a site's account id
   and deploy token), and the `_NEW` secrets are deleted.
6. **The state swap.** The new account's states become the app's, and only the ids change in each
   root's committed `terraform.tfvars.json`: the account's, the zone's and, with Access, the
   one-time PIN login's. A check plan follows: no change needs no
   approval. From here the move can't be aborted.

Then, for each environment, the old account's pieces are removed:

- its tunnels, once they have no connection left, and its Access applications, policies, service
  tokens and Worker, from a plan you approve by typing the app's name;
- each of its R2 buckets: OpsCrew checks that the new account's bucket holds every file, empties
  the old one after you type the bucket's name, and deletes it;
- its old origin certificate, revoked once the server serves the new one. If the server doesn't
  yet, the finish stops and asks you to run it again after the deploy.

Last, the app's mark goes from the new zone (a plan you approve by its hash), with the move's files
on this computer. The finish then lists the variables to change (see
[After the finish](#after-the-finish)), and asks you to commit and push the files it changed: each
environment's `opscrew/plan.yaml` and each root's `terraform.tfvars.json`.

## R2 buckets

The app's [R2](object-storage.md) bucket and the bucket of the
[snapshots' copies](snapshots.md#an-encrypted-copy-off-the-server) move to buckets of the same names
in the new account. The files are copied with rclone in a one-off container on the app's server
(in your Portainer, through it), never through this computer.

- **The keys.** OpsCrew needs a key for each new bucket, which you create once the prepare has made
  the bucket: R2 → Manage API tokens in the new account, Object Read & Write, limited to that bucket
  (see [The storage key](object-storage.md#the-storage-key)). A terminal asks for it once. In a
  script, set `OPSCREW_NEW_STORAGE_ACCESS_KEY_ID` and `OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY` for the
  app's bucket, and `OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID` and `OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY`
  for the snapshots' bucket. On a server, the keys reach rclone only on its standard input; in
  your Portainer, only in its one-off container's configuration file.
- **The first copy,** at the prepare, copies every file, after an approval that lists each bucket
  with its size, object count and time: about 2 minutes, plus one per GiB and one per 2,000
  objects. The app keeps using the old account's bucket until the finish.
- **The maintenance window,** at the finish, only with an app bucket. Its approval comes right
  after the approval of the new account's settings, before the app stops, and shows its length:
  about 2 minutes, plus one per 2,000 objects. In it, the app's deploys (and the
  [scheduled check](alerts.md)) pause, the app, its workers and cron stop, what changed in the
  bucket since the first copy is copied, the app's settings take the new bucket, and the deploy
  starts the app on them. If anything fails before the app's settings take the new bucket, OpsCrew
  puts the old account's settings back and starts the app again; the old bucket keeps every file. Once the settings point
  at the new bucket, OpsCrew only goes forward: running the finish again completes it.
- **The snapshots' copies** need no window: the app uploads new copies to the new bucket from the
  finish's deploy, and the copies made since the first copy follow right after. A restore from the
  copy then works from the new account. The new bucket's lifecycle rule counts each copy's age from
  the day it was copied, so the moved copies stay up to `--days` longer than they would have.

## Deploys during the move

Deploys keep working from the prepare to the finish, except in the finish's maintenance window.

- **Through Cloudflare Access** (a server in tunnel mode, Portainer's webhook with Cloudflare
  redeploys): the prepare adds the new account's credentials to GitHub next to the old ones, under
  the same names with `_NEW` at the end (for example `OPSCREW_TUNNEL_SERVICE_TOKEN_ID_NEW`). The
  deploy workflow tries the old account's first and, when Access refuses them, the new account's.
  Before the switch the old ones work; after it, the new ones. As the switch plan says, deploys
  through Access pause around activation: from the nameserver change, a deploy whose resolver
  already asks the new account's nameservers finds no record for the Access hostname until the
  switch makes it right after activation. Run such a deploy again after the switch.
- **A site on Cloudflare's hosting:** each deploy goes to both accounts, so the new account's Worker
  always runs the code the old one does.
- **At the finish,** the `_NEW` values take the plain names and the `_NEW` secrets are deleted. An
  abort deletes them.

## Several apps in one zone

A zone serving several OpsCrew apps, each from its own repository, moves with all of them:

1. Prepare each app from its own repository, with the same `--to`. The prepare's summary and output
   name the other apps' hostnames still to prepare.
2. Switch once, from any of these repositories. It refuses until every OpsCrew hostname in the old
   zone belongs to a prepared app.
3. Finish each app from its own repository.

An app in the zone whose repository you can't reach (another team's) blocks the switch until it is
prepared there, or until its records are removed from the zone. In a repository with
[several apps](several-apps.md), each app is its own move, with `--app <key>`.

**Environments.** Every environment of the app whose domain is in the zone moves, each with its own
pieces in the new account. An environment in another zone stays as it is, and one that isn't
deployed is skipped; the summary names both.

**Previews** per pull request don't move: turn them off before the move and on again after it. Their
zone and certificate are set up again by turning them on. Adding previews during a move is refused.

## What OpsCrew doesn't move

The move covers what OpsCrew made for its apps, and the zone's DNS records. Redo the rest in the new
account before the switch, or let it go; Email Routing right after the switch (see
[Switch](#switch)):

- **the zone's plan and paid add-ons** (the new zone starts on Free), and settings OpsCrew doesn't
  set: the SSL/TLS mode and edge certificate settings, caching and cache rules, page rules, your
  own transform, redirect and WAF rules, bot and DDoS settings, Speed settings;
- **[Email Routing](https://developers.cloudflare.com/email-routing/)**: its records are Cloudflare's
  own and aren't copied, so mail stops arriving at the switch until you set it up in the new
  account, right after the switch (see [Switch](#switch));
- **Workers and Pages projects** OpsCrew didn't create, and **R2 buckets** OpsCrew didn't create,
  among them your own R2 bucket used for the snapshots' copies as
  [`snapshots.offsite.provider: s3`](snapshots.md#your-own-s3-compatible-bucket): its endpoint names
  the old account;
- Turnstile widgets, Web Analytics, Zero Trust settings beyond the organization and the one-time PIN
  login, API tokens, members and their roles, notifications and Logpush;
- **the domain's registration** when it stays at another registrar. At Cloudflare Registrar, its
  own move between accounts carries the registration, but not its contacts.

## What stays in the old account

- **The old zone,** with the app's records, OpsCrew's rules and the origin-pull settings. Cloudflare
  shows it as moved once the new zone is active, and deletes it about 7 days later. Cancel its paid
  add-ons only after activation.
- **The account's Zero Trust organization and one-time PIN login,** which every app in the account
  shares: OpsCrew never deletes them.
- Everything OpsCrew didn't make.

Everything else of the app in the old account is removed by its finish.

## After the finish

Once every app in the zone has finished, give these variables the new account's values wherever you
run OpsCrew (this computer, your scripts), then remove the `OPSCREW_NEW_*` ones. The finish lists
those the app uses:

| Variable | Takes the value of |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` |
| `OPSCREW_STORAGE_ACCESS_KEY_ID`, `OPSCREW_STORAGE_SECRET_ACCESS_KEY` | `OPSCREW_NEW_STORAGE_ACCESS_KEY_ID`, `OPSCREW_NEW_STORAGE_SECRET_ACCESS_KEY` |
| `OPSCREW_OFFSITE_ACCESS_KEY_ID`, `OPSCREW_OFFSITE_SECRET_ACCESS_KEY` | `OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID`, `OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY` |
| `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN` | `OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN` |

While `CLOUDFLARE_API_TOKEN` is still the old account's, which shows the zone as moved,
`opscrew provision`, the add-on commands, Portainer's, and a site's `drift` and `status` stop and
say to set it to the new account's token; other commands fail on the new account's pieces. With
the new account's token, `opscrew provision`, `drift`, `status`, `rotate` and `destroy` work on the
new account only.

## Aborting the move

Before the switch, each prepared app can be taken back out of the new account:

```bash
npx opscrew cloudflare move --abort
```

In order, each after its approval: the app's mark goes (so no switch can start), then the `_NEW` deploy
secrets, the connectors beside the old ones, the new buckets (each emptied after you type its name),
the app's other pieces in the new account (after you type the app's name) and its rules there. The
new zone is deleted after you type its name, only when it holds no other app's mark, no other
OpsCrew record and no rule of another app; otherwise it stays, and the abort says why. The old
account was never changed, and keeps serving.

Once an abort has begun, run it to its end: prepare and finish refuse until then.

### When an abort is refused

Once the switch changed anything, the move must go on (`--switch`, then `--finish`). Any repository
can tell, and the abort refuses when:

- the domain's nameservers are no longer the old account's (read from the registrar's API, else
  from the public DNS);
- the registry published a DS record when the move started and publishes none now;
- the new zone is active, or the old one no longer is;
- the finish has moved an environment of the app.

When the nameservers can only be read from the public DNS, which can show the old ones for a while
after a change, and a switch plan was approved on this computer, the abort first asks you to check
the registrar and type the domain's name (`--confirm <domain>` in a script). OpsCrew never publishes
a removed DS record again.

## Moving back

A finished move can't be undone, but you can move again the other way: with the new account's token
in `CLOUDFLARE_API_TOKEN` and the old account's in `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`, run
`npx opscrew cloudflare move --to <old account>` and go through the same steps.

The old account still shows its zone as moved until Cloudflare deletes it, which
[Cloudflare's page on moving a domain](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/)
puts at 7 days after the new zone is active. Until then, the prepare of a move back stops and says
the zone moved.

## While a move runs

`npx opscrew status` shows the move's step for each environment, and the apps prepared in the new
account when `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is set. `opscrew provision`, `dns`, `drift`,
`destroy`, `retarget`, `rotate`, the add-on commands, `domain buy`, `domain connect` and adding
previews stop and say how to go on. `snapshot`, `rollback`, `advise` and `design` work as usual, and
so do deploys (see [Deploys during the move](#deploys-during-the-move)).

In [Claude Code](claude-code-plugin.md), `opscrew_status` shows the same and names the command to
run: the move runs only in your terminal, where you give every approval yourself.

## In scripts

A run without a terminal stops at each plan, prints its hash and the command to go on with. The
other answers take flags:

| Flag | What it does |
|---|---|
| `--approve <hash>` | Applies exactly the saved plan with this hash and goes on |
| `--confirm <name>` | A typed name: the app's, a bucket's, the domain's at the switch or an abort, the zone's when an abort deletes it; repeat it for each |
| `--allow-downtime` | Allows the finish's maintenance window |
| `--engine <name>` | `tofu` or `terraform` |

With an app bucket, the finish stops at the hash of the new account's settings before the window
begins, as a terminal asks that approval before the window's: run it again with
`--approve <hash> --allow-downtime`.

```bash
npx opscrew cloudflare move --to "Example Co"
# shows the summary, stops at the first plan and prints the command to go on, with its hash:
npx opscrew cloudflare move --approve <hash>
# ... one run for each plan; then, once every app in the zone is prepared:
npx opscrew cloudflare move --switch --confirm example.com --approve <hash>
# ... and once the zone is active, one finish run for each plan it stops at:
npx opscrew cloudflare move --finish --approve <hash> --allow-downtime
npx opscrew cloudflare move --finish --approve <hash> --confirm example-app
```
