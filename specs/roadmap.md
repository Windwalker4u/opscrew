# OpsCrew roadmap: the features after the current one

The features still to come, in order, with their scope and the founder's decisions so far. A
feature gets its own `specs/NNN-name/` folder when it starts, and its section here then points
there. The lead keeps this file current. Research for a feature goes in that feature's
`research.md`, never only in an agent's memory, so every session on every machine has it.

Done: 000–031. [027 shared hosting](027-shared-hosting/) shipped as 0.2.8 on 2026-11-14, build
arguments from the plan as 0.2.9 on 2026-11-15, [028 moving an app to another Cloudflare
account](028-cloudflare-account-move/) as 0.2.10. [029 hosting at home](029-home-hosting/), [030
several apps on a server OpsCrew created](030-shared-created-server/) and [031 a move's maintenance
window of about a minute](031-short-move-window/) shipped together as 0.2.11 on 2026-11-21.
**Next:**
- **0.2.12** (the founder, 2026-11-25): 046 an uptime check that doesn't use GitHub Actions, the
  agent tool policy's security fixes (#16 to #24), the fixes in #26, [032 a Codex
  plugin](032-codex-plugin/) (built; its live pass in the Codex CLI is left), and 047 an app's
  PostgreSQL never running as the superuser, and 048 changing an app's values without a full
  provision (the founder, 2026-11-25).
- **0.2.13:** 040 an agent on the server, which he wanted in 0.2.12 if there was room. Its live
  pass needs the dashboard's side merged behind an operator-only switch a few days before, which
  would hold 046 back. With it, 049 each app's own network on a shared server (the lead's
  hardening call, 2026-11-25).
- **Beside them:** 035's first providers, started by a second contributor, whose agent builds the
  dashboard's DevMem module first (the founder, 2026-11-26), then 035's Kamatera, IONOS Cloud and
  UpCloud.
- **After them:** 041 OpsCrew in the user's GitHub Actions, approved from the dashboard.
- **Then:** 033 scaling across servers (his choice on 2026-11-15, before AWS), then 034 AWS, then
  more providers in phases (035–039), then 042 GitLab and 043 Forgejo and Gitea, each once the
  founder gives the go-ahead.

## 019 Rollback

`opscrew rollback` puts an app's environment back on its previous deployment with one command,
or on an earlier version the user picks (founder, 2026-10-31). It became a feature of its own, right after 018, when the first outside feedback asked
how a failed deploy is recovered before pointing OpsCrew at a real app. Today OpsCrew has no
command that undoes a release which deployed fine but is wrong.

The lead's sketch, to settle in the spec:
- **The main case:** `opscrew rollback` with no arguments goes back to the deployment before the
  current one, whether the current one failed later or simply turned out wrong.
- **What it deploys:** an image the environment ran before, with no build. `promote` already
  deploys an image that exists, so rollback reuses that path, through the same switch, health
  check and check from outside as any deploy. It lists the recent versions and defaults to the one
  before the current.
- **Data is never rolled back:** migrations stay applied, so the earlier version must work with
  the newer schema (the guide's rule: add in one release, remove in a later one). OpsCrew says so
  before it switches.
- **Every target:** servers OpsCrew creates, the user's own server, Portainer and this computer.
  Cloudflare Workers and GitHub Pages through their own version history, where they keep one.
- **After a rollback:** what the next merge does (deploys forward again, or deploys stay paused
  until the user resumes them) is a spec question.
- **Research first:** how long earlier images stay in GitHub Container Registry and on the
  servers, and what each target's own rollback offers.
- **What exists to build on** (found while writing the failed-deploy guide page, 2026-10-31):
  - a healthy deploy labels the image it replaced `opscrew-<env>-previous` and keeps it on the
    server;
  - `promote --digest` redeploys an image, but refuses an environment that deploys from a
    branch, which is the default prod;
  - sites on Cloudflare's hosting or GitHub Pages already have `promote --version`, branch or not.
- **Also in scope, the rest of recovery:**
  - keep a failed copy's last log lines: today `docker rm -f` removes the copy that failed its
    health check together with its logs, so `opscrew logs` cannot show why;
  - a worker's failure hint (`docker compose logs <service>`) shows the old version's lines
    after the switch back;
  - say what to do about a migration that was half-applied when the release command failed.

**019 follow-up: a rollback undoes the database too** (founder, 2026-11-06, in the same release
as 023). 019 left the data and the schema as they are, so the earlier version had to work with the
newer schema. Now a rollback asks how to undo the database:
- **A snapshot before every release, the default:** before a deploy runs the release command
  (migrations), OpsCrew dumps the app's databases on the server; a rollback restores the dump taken
  just before the version being undone migrated. It works for every migration tool and can't stop
  halfway, but loses what was written since. **On by default for every environment except prod**;
  prod keeps its data as it is unless the user turns snapshots on.
- **Down migrations, per framework, when the user picks them:** the current image migrates the
  database down to the version the earlier one ran. Offered only where the app's migration tool
  has down migrations; rows the undone migrations don't touch stay.
- Done (2026-11-06, released in 0.2.4): [research R9](019-rollback/research.md), [spec US8](019-rollback/spec.md),
  [plan section 12](019-rollback/plan.md), [tasks T1930–T1938](019-rollback/tasks.md) and ADR 0028.

**Also in 019: logins for Kafka, Redpanda and OpenSearch** (founder, 2026-11-01). They get a login
of their own, generated like every other service's password. Today only the network protects
them: the app's Docker network on its server, the private network on another one. A login keeps
them closed when something else on the app's server is compromised. The lead's sketch:
- **Kafka and Redpanda:** SASL/SCRAM, opt-in per service, because a client sends a login only when
  the app's code configures it (kafkajs, librdkafka and sarama share no environment-variable
  convention). Turning it on gives the app the user, password and mechanism as variables, and the
  analyst says whether the app's code reads them. Redpanda's admin user must exist before SASL
  turns on (its bootstrap user), or nothing can log in.
- **OpenSearch:** its security plugin, with the HTTP API kept on plain HTTP and the login in the
  URL (`http://user:password@host:9200`), which its clients accept, so an app that reads one URL
  variable needs no change. The plugin also needs certificates for the traffic between its nodes,
  even with one node: OpsCrew generates them on the server, and they never leave it.
- **Between servers,** WireGuard already encrypts every packet (018), so no TLS goes on top.
- **Research first:** each pinned image's settings (Kafka's SCRAM users in KRaft mode, Redpanda's
  bootstrap user, OpenSearch's initial admin password and its security setup without the demo
  certificates), and what the detectors can read from the app's code.

## 020 Self-hosted monitoring

Done (2026-11-04): [spec](020-self-hosted-monitoring/spec.md), [plan](020-self-hosted-monitoring/plan.md),
[tasks](020-self-hosted-monitoring/tasks.md), ADR 0024, and the guide page `docs/guide/monitoring.md`. The sketch below is the
roadmap's, kept as the founder's input.

A private, self-hosted monitoring stack, opt-in (founder, 2026-10-18). Feature 017 left it out
by oversight, and on 2026-10-30 the founder made it a feature of its own, right after 018, since
it runs on 018's private network and extra servers. On 2026-10-31 rollback went in before it.

- **The stack:** Prometheus, Loki and Grafana, with node-exporter and cAdvisor (or Alloy), plus
  ready-made dashboards for the server, the containers, the app's HTTP traffic, Postgres and Caddy.
- **Where it runs:** by default on a separate small monitoring server (about €4–5 a month at
  Hetzner) that watches all of the user's OpsCrew servers. On the app's server only when it has at
  least 4 GB; the stack needs about 1–1.5 GB.
- **Reached only through 018's private network:** the dashboards listen on the network's address
  only, and the app servers send their metrics and logs over it.
- **Same gate as everything else:** plans approved by hash, pinned versions, and destroy removes
  only what OpsCrew installed.
- **Licences:** Grafana and Loki are AGPL-3.0, which is fine run as containers (never linked into
  the CLI); OpsCrew says so when the user turns it on.
- **Research first:** memory sizes, retention and disk use.
- **Loki rather than Elasticsearch** for logs (lead, 2026-10-30): Loki indexes only labels, so it
  fits a small server; Elasticsearch indexes every word and needs gigabytes of JVM heap. No
  Elasticsearch and Kibana stack on any provider (founder asked, 2026-10-30). Full-text search over
  large log volumes (OpenSearch with OpenSearch Dashboards on the monitoring server) is a later
  opt-in, only if users ask.
- **Not here:** dashboards across several projects, team notifications and spend alerts belong to
  the hosted control plane. On AWS (034), the light checks map to CloudWatch alarms.

## 021 Advise

Done (2026-11-05): [spec](021-advise/spec.md), [plan](021-advise/plan.md),
[tasks](021-advise/tasks.md), ADR 0025, and the guide pages `docs/guide/advise.md` and
`docs/guide/retarget.md`. The sketch below is the roadmap's, kept as the founder's input.

`opscrew advise` (founder, 2026-10-18: "analyze the current setup and then propose what to change
and how to scale"). It reads the live deployment (017's resource figures, and their history when
Beszel, Grafana Cloud or 020's stack is on), `plan.yaml`, the interview's expected traffic and
budget, and live provider prices. It proposes concrete changes, each explained, backed by the
figures and priced:
- **Size:** resize up or down; a disk that is filling.
- **Components:** add the cache the app already supports; move uploads to object storage; give a
  busy database its own server (018).
- **Cost:** a cheaper server type or location; spend above the interview's budget.
- **Reliability:** backups off; restart loops; a flapping health check; no uptime alert.
- **Upkeep and security:** waiting Dependabot updates; pending OS security updates; `secure`
  findings; tokens about to expire.
- **Moving:** `retarget` to a cheaper provider (023), or to AWS (034) when an app outgrows one
  server.

It changes nothing itself: each proposal is applied through the existing flows (a plan and a
hash-bound approval). Deterministic first (thresholds on the figures); a model only for the
judgment it adds. Placed by the lead after the figures exist and before AWS, so AWS's
managed-service choices reuse the same advice; the founder can move it.

## Later, if users ask: monitoring for several apps on one of the user's own servers

A server runs one Grafana Alloy, rendered from one app's plan, so a second OpsCrew app on the same
own server is refused Grafana Cloud and the self-hosted monitoring (017, 020). The founder asked
for it on 2026-11-04 and left the call to the lead, who left it out of 021: it needs several
OpsCrew apps on one own server with more than one wanting monitoring, the first app's monitoring
already shows the whole server, Beszel shows every container, and the change would rework the
Alloy path just released in 0.2.1. A design that works (one Alloy per server, a configuration
folder with one file per app, written by that app's own repository) is in
[021's research R4](021-advise/research.md).

## 022 Preview environments per pull request

Done (2026-11-05): [research](022-preview-environments/research.md),
[spec](022-preview-environments/spec.md), [plan](022-preview-environments/plan.md),
[tasks](022-preview-environments/tasks.md), ADR 0026, constitution 1.7.0 (the standing approval), and
the guide page `docs/guide/previews.md`. Previews live on a Cloudflare zone of their own at
`pr-<n>-<random>.<zone>` (research R6). Two opt-ins follow it (founder, 2026-11-05, research R7,
constitution 1.8.0): another environment's server (never prod's), and a name below the app's own
zone with Advanced Certificate Manager. The sketch below is the roadmap's, kept as the founder's
input.

Founder agreed, 2026-10-23. A short-lived environment per pull request: created when it opens,
updated on each push, destroyed on close or merge, at `pr-<n>.<domain>`.
- Previews run as extra apps on one shared, small preview server (013's several apps per server).
- Each has its own empty or seeded databases (never prod's data) and its own secrets.
- Secrets are never given to a fork's pull request (the `pull_request_target` trap).
- A cap on how many run at once, and automatic cleanup.
- **The approval model is the design question:** a standing approval of the preview recipe
  (server, size, cap, rules), approved once by hash. CI creates each preview within it
  automatically, and anything outside it stops. An ADR extends constitution I for it.

Placed after advise (its spend figures and budget checks cap previews) and before retarget and
AWS, so both support previews from the start. More relevant to teams than to solo users.

## 023 Retarget anywhere

Done (2026-11-06, released in 0.2.4): [research](023-retarget-anywhere/research.md),
[spec](023-retarget-anywhere/spec.md), [plan](023-retarget-anywhere/plan.md),
[tasks](023-retarget-anywhere/tasks.md). The sketch below is the roadmap's, kept as the founder's
input.

`opscrew retarget` from any target to any target: cloud ↔ own server ↔ Portainer (and AWS once it
exists), with all the app's data. Founder agreed, 2026-10-20 ("moving from every to every provider
no matter which should be supported"). Today's move is generic over cloud providers but refuses
own servers, Portainer, and stateful services other than Postgres and Valkey. The missing pieces:
- a dump and restore per catalog kind: MySQL, MongoDB, the brokers and engines, the SQLite and
  Garage volumes, and Valkey, Redis 8 and Dragonfly (which today start empty, so queued jobs are
  lost: copy their snapshot in the maintenance window);
- **buckets** (founder, 2026-10-20): a bucket at the provider being left (Hetzner Object Storage,
  Spaces) moves to the new provider's storage: a new bucket, the files copied, the app switched to
  it, and the old bucket deleted at `--finish`. Size, copy time and egress cost are shown first.
  It is the default when leaving that provider entirely, since the old bucket keeps billing;
  keeping it is the user's choice. R2 stays, since it is Cloudflare's;
- the copy on Portainer through a one-off container via its API (no SSH there);
- the own server's host plan on the target side;
- a choice per stateful component: copy its data (the default for databases, queues and brokers)
  or start empty (fine for a cache or a search index the app rebuilds);
- keeping a component on the old server while the app moves, through 018's private network;
- keeping (never deleting) the user's own old server on `--finish`.

Placed before AWS so AWS joins as just another target.

## 024 Snapshots and restores as commands

Done (2026-11-08, released in 0.2.5): [research](024-snapshots-and-restores/research.md),
[spec](024-snapshots-and-restores/spec.md), [plan](024-snapshots-and-restores/plan.md),
[tasks](024-snapshots-and-restores/tasks.md). The sketch below is the roadmap's, kept as the
founder's input.

Placed before AWS by the founder on 2026-11-06. Today a snapshot is taken only by `destroy`, and
a restore is done by hand in the provider's console or from a database dump (lead, 2026-10-31,
from the failed-deploy guide page). 019's database rollback (in the same release as 023) dumps
the app's databases before each release; this feature turns that into commands the user runs:
take a snapshot of an environment's databases or its whole server, list them, and restore one,
each restore approved like any other change that deletes data.

It reuses the database rollback's dump and exact restore, its files on the server, its disk check
and rotation. It also covers every case the database rollback leaves out, where viable (founder,
2026-11-06):
- Portainer, through 023's Docker API path;
- the app's own files (a SQLite database, uploads), with a safe copy while the app writes;
- a database on another server (018);
- the other services that keep data: Valkey and Redis queues, the brokers, the search and
  analytics engines, Garage.

The rollback's snapshot choice then works for them too.

New beside the rollback's snapshots:
- a restore without a rollback, checked against today's schema;
- whole-server snapshots at Hetzner and DigitalOcean, whose restore rebuilds the server;
- **scheduled snapshots, like backups** (founder, 2026-11-06, the lead's recommendation):
  - a timer on the server runs the same snapshot at the interval the user picks and keeps the last
    N; on Portainer, which has no timer, a scheduled container in the stack does;
  - off by default, turned on per environment;
- **The founder's choices before the spec** (2026-11-06, research R6): a brief stop of a service
  without a safe online copy (approved by hand, opt-in for schedules); whole-server snapshots live
  by default (`--stop` for a consistent one); the off-server copy encrypted to the recovery copy's
  age key; schedules weekly, keep 4, off-server 90 days.
- **an opt-in copy off the server** (founder, 2026-11-06), so that losing the server doesn't lose
  the data: each snapshot is encrypted on the server before it leaves, then copied to object
  storage (R2, Hetzner Object Storage or Spaces), with its own retention.
  - **Your own server and Portainer get real backups this way.** Today they have none, and the
    guide says backups are the user's to set up. This changes with 024.
  - Design proposes them when the interview says the data matters, as it turns on the cloud
    providers' backups today.
  - This supersedes the founder's 2026-10-13 decision that provider backups are enough.

## 025 Credential rotation

The founder asked for it on 2026-11-06 and placed it after 024, as the lead suggested: security
work that depends on no provider, with 024's snapshots in place to recover from a rotation that
goes wrong. Today OpsCrew rotates only the recovery copy's key (`opscrew secrets rotate`); every
other credential it generates is made once (019's guide says so for Kafka's and Redpanda's
logins), and a few guides (Beszel, Grafana Cloud, Portainer) rotate a token by hand.

What it rotates, each change a plan approved by its hash, the recovery copy updated each time, and
no old or new value in any output or log:
- **the services' passwords** OpsCrew generated: PostgreSQL, MySQL and MariaDB (app and root),
  MongoDB, Valkey and Redis, RabbitMQ, Kafka and Redpanda, OpenSearch, Elasticsearch,
  Meilisearch, Typesense, ClickHouse and Neo4j, without breaking the running app. Where a service
  takes two passwords for a moment (MySQL's `RETAIN CURRENT PASSWORD`, Valkey's ACL users) the
  switch is seamless; elsewhere (PostgreSQL) a short ordered swap: the database, the server's env
  files, then a rolling redeploy;
- **the app secrets OpsCrew generated** (`SECRET_KEY_BASE`, Laravel's `APP_KEY` and the like),
  each with its consequence said first (every user logged out, encrypted data unreadable), or
  refused;
- **the deploy SSH key:** a new key on the servers, the GitHub secret updated, the old key removed;
- **WireGuard keys** of the servers and the user's devices (018), and the GHCR pull entries on
  Portainer;
- **the user's own tokens** (Hetzner, Cloudflare, GitHub), which OpsCrew can't make: their age and
  expiry checked, and when to replace them said (advise does this for the GitHub token today);
- optionally on a schedule: advise or the scheduled check flags credentials older than a chosen
  age.

Research first: each service's way to change its password while clients are connected.

## 026 Contabo, opening with the provider plugin system

Done (2026-11-12, released in 0.2.7): [research](026-contabo-provider-plugins/research.md),
[spec](026-contabo-provider-plugins/spec.md), [plan](026-contabo-provider-plugins/plan.md),
[tasks](026-contabo-provider-plugins/tasks.md), ADR 0029 and `docs/guide/contabo.md`. The sketch
below is the roadmap's, kept as the founder's input.

The founder placed Contabo before AWS and the other hyperscalers on 2026-11-06. It is a cheap
VPS provider, so it joins as another server target like Hetzner and DigitalOcean: its connector,
profile, prices and IaC module, through `vpsConnector` and `providerProfile`.

**Research first:** Contabo's API and its official CLI `cntb`
(https://github.com/contabo/cntb, founder, 2026-11-06). The CLI's source shows the API's calls,
login and quirks. OpsCrew calls the API through its own typed connector and the IaC engine,
never through `cntb` (constitution IV).

**It opens with the contract for cloud server providers** (founder, 2026-10-16, moved here from
AWS on 2026-11-06; its scope set from the research on 2026-11-11,
[R5](026-contabo-provider-plugins/research.md#r5-the-founders-decisions-2026-11-11)):
- Everything about one cloud server provider lives in one place, behind a versioned contract of
  plain data and functions that a separate package could implement later: its connector, prices,
  profile, Terraform module, firewall checks, token rules, interview option and docs.
- Hetzner and DigitalOcean move into it; Contabo is the first provider written for it, built in
  like them.
- Own server and Portainer stay as they are: they are kinds of target with flows of their own,
  not providers.
- Installing provider packages comes with AWS (034), designed around its first real user.
- **Other areas get their own contract when a second implementation arrives** (founder,
  2026-11-11), not before, since a contract with one user tends to take the wrong shape:
  - DNS and the edge when Fastly is placed, with Cloudflare moved behind it;
  - the code host with GitLab, with GitHub moved behind it.

  Own server, Portainer, the serverless hosts, object storage, the registrars and the reverse
  proxies stay built in until then.

**Live tests:** one live pass at the end on one Cloud VPS 4, on an account the founder opens. A
destroy only cancels a Contabo server at the end of its term (at least a month), so the founder
is asked before any rerun that needs another server.

## 027 Shared hosting (cPanel, Plesk, DirectAdmin, SFTP) and LiteSpeed

Done (2026-11-14, released in 0.2.8): [research](027-shared-hosting/research.md),
[spec](027-shared-hosting/spec.md), [plan](027-shared-hosting/plan.md),
[tasks](027-shared-hosting/tasks.md), ADRs 0030 and 0031, and the guide pages
`docs/guide/hosting-accounts.md`, `cpanel.md`, `plesk.md`, `directadmin.md` and `sftp.md`. In the
same release, at the founder's request: Contabo's Object Storage and Auto Backup, the provider's
backups on by default only in prod, and the guide pages `hetzner.md` and `digitalocean.md`. The
sketch below is the roadmap's, kept as the founder's input.

The founder placed cPanel, Plesk, DirectAdmin and SFTP before AWS, as one feature, on 2026-11-07,
because most shared hosting providers run one of these three panels. Many apps live on hosting the
user already pays for: a control panel, no root, no Docker.
WordPress, Laravel, static sites and small Node.js apps are typical. LiteSpeed joined later
(founder, 2026-11-10 and 2026-11-11): on hosting accounts it serves, and as a third proxy on
servers.

- **A new kind of target, a hosting account.** There is no server to harden and no containers.
  - **What fits:**
    - static sites;
    - PHP apps (Laravel, Symfony, WordPress);
    - Node.js or Python apps where the panel runs them (cPanel's application manager, CloudLinux's
      Node.js and Python selectors);
    - the panel's databases (MySQL or MariaDB, PostgreSQL where offered), cron jobs, domains and
      subdomains, and its free certificates (AutoSSL).
  - **What doesn't fit** is refused with the reason and a VPS target suggested: long-running
    workers, Redis and queues, websockets, anything that needs Docker.
- **The panels:**
  - cPanel through its UAPI with an API token;
  - Plesk through its REST API;
  - DirectAdmin through its API with a login key.

  Each has a typed connector. Their changes go through a plan approved by hash, as an own
  server's host plans do (ADR 0011).
- **SFTP** is the plainest target, any host with SFTP: a built static site or a PHP app uploaded.
  There is no panel API, so databases and domains stay the user's, and the plan names them.
- **LiteSpeed** (founder, 2026-11-10): many shared hosts run LiteSpeed Web Server in place of
  Apache under the same panels; the founder's cPanel test account does. OpsCrew finds out which
  of the two serves the account and says so in the plan.
  - The `.htaccess` rules OpsCrew writes (HTTPS forced, the web root, secrets out of reach) work
    on both.
  - Each deploy and rollback empties LiteSpeed's page cache (LSCache, which the LiteSpeed Cache
    plugin for WordPress uses), so no visitor gets a page from the old release.
  - PHP serves the new release as soon as the switch happens, even where LiteSpeed's PHP
    processes keep running across it.
- **OpenLiteSpeed as a third proxy on servers** (founder, 2026-11-11), next to Caddy and nginx in
  `target.edge`, from LiteSpeed's official Docker image. It is the free, open-source edition;
  LiteSpeed Enterprise is paid.
  - It is mainly for PHP and WordPress apps: its page cache keeps the pages the app marks
    cacheable, and each deploy and rollback empties it.
  - Visitors get the same protections as from Caddy and nginx: TLS 1.2 and 1.3 only, the same
    security headers, WebSockets and long requests, and a refusal for hostnames the server does
    not serve. Its admin console stays off.
  - Certificates: origin certificates behind Cloudflare's proxy, and for DNS-only hostnames its
    own, renewed without dropping connections.
  - Its own additions file, checked by OpsCrew's rules and by the proxy's own configuration check
    before any change.
  - Everything the proxy choice reaches follows: one proxy per server and the switch between
    proxies, previews, localhost, retarget, status, `secure` and own-server inspection. A
    Portainer stack keeps Caddy.
- **Deploys** come from GitHub Actions into release folders with an atomic switch, so a rollback
  switches back. The token or key is a deploy secret.
- **Security:**
  - the scan;
  - the PHP version;
  - the app's secrets kept outside the web root;
  - file permissions;
  - HTTPS forced.
- **Snapshots (024):** the panel's database dumps and the app's files.
- **Live tests:**
  - on the founder's cPanel account (`OPSCREW_E2E_CPANEL_*` in `.env.e2e`), whose test objects are
    all named `e2e-…` (founder, 2026-11-07: fine on that account; the token doesn't expire);
  - SFTP on the same account when it has SSH access;
  - LiteSpeed on the same account (it answers with `Server: LiteSpeed`, checked 2026-11-10);
    Apache with fakes until an account served by Apache exists;
  - OpenLiteSpeed on a server as nginx's pass did: the first certificate and a renewal under
    load, an addition, the cache emptied by a deploy, origin TLS behind Cloudflare, two apps on
    one edge, and a switch to Caddy and back;
  - Plesk and DirectAdmin with fakes, as DigitalOcean is today, since there are no test accounts
    yet. Their live passes follow once an account exists.
- **Research first:**
  - cPanel's UAPI: tokens, Domains, Mysql, SSL, Cron, the application manager and VersionControl;
  - Plesk's REST API and DirectAdmin's API for the same operations;
  - their limits;
  - how the CloudLinux selectors are driven through the API;
  - LiteSpeed: which `.htaccess` directives it honours, how a deploy empties LSCache without
    root, how to make its PHP processes load the new release, and how it runs the selectors'
    Node.js and Python apps;
  - OpenLiteSpeed: WebSockets through its proxy, a configuration check like `nginx -t`, a reload
    without dropping connections, turning its admin console off, its own certificates (ACME),
    whether its cache keeps pages from any app behind it or only from apps that send LiteSpeed's
    cache headers, and the image's versions and licence.
- **Built in**, like the other targets: installing provider packages comes with AWS (034).

## 028 Moving an app to another Cloudflare account

Done (2026-11-18): [spec](028-cloudflare-account-move/spec.md), [plan](028-cloudflare-account-move/plan.md),
[tasks](028-cloudflare-account-move/tasks.md), ADR 0032, and the guide page
`docs/guide/cloudflare-move.md`; opscrew.dev itself moved to its new account on 2026-11-17 and 18.
The sketch below is the roadmap's, kept as the founder's input.

`opscrew` moves an app's whole Cloudflare setup to another Cloudflare account the user owns
(founder, 2026-11-14, for 0.2.10). Cloudflare moves nothing between accounts by itself: the domain
is added to the new account, its records and OpsCrew's rules copied, the app's Tunnels, Access,
Workers and R2 buckets created there, the nameservers switched, and the old account's pieces
removed after an approved plan. Research and the founder's decisions:
[research.md](028-cloudflare-account-move/research.md).

**The founder's decisions (2026-11-14):**
- It ships as its own release, 0.2.10; 0.2.9 carries build arguments from the plan and a further app's analysis fix, which the control plane waits for.
- A zone serving several OpsCrew apps moves with all of them: each app prepares its side from its
  own repository, one run switches the zone, each repository then finishes.
- The R2 buckets are copied to the new account and the app switched to them in a short
  maintenance window, so the old account can be closed afterwards.

**Also in 0.2.10 (founder, 2026-11-16):** `opscrew mcp install` adds OpsCrew's MCP server to
Claude Code, Claude Desktop, Codex, Cursor and VS Code in one command, and `opscrew mcp uninstall`
removes it (T2846, research R11). Claude Desktop's one-click `.mcpb` bundle comes later (the lead's
recommendation; the founder left it open).

## 029 Hosting at home: your own IP address and dynamic DNS

Done (2026-11-19, 0.2.11): [spec](029-home-hosting/spec.md), [plan](029-home-hosting/plan.md),
[tasks](029-home-hosting/tasks.md), ADRs 0033 and 0034, and the guide pages
`docs/guide/home-hosting.md` and `docs/guide/snapshots.md#restore-drills`. Also in it, at the
founder's word (2026-11-19): a Laravel queue run from cron on hosting accounts, PostgreSQL on cPanel
accounts whose host installed it (tested with fakes only, research R31), and pull request
checklists that tick what OpsCrew checked. The sketch below is the roadmap's, kept as the founder's
input.

An app served from a computer at home (a Raspberry Pi on a fiber line, say) at the home's own
public address, static or dynamic, with OpsCrew keeping the domain's record pointed at it. The
founder placed it next, before AWS, on 2026-11-15, after a suggestion that a 1 Gbps home line and a
Raspberry Pi can serve a site with plenty of traffic.

**What exists today:** [your own server](../docs/guide/own-server.md) reaches any machine OpsCrew can
SSH into, Arm included, and its tunnel mode already serves an app from behind a home router with no
open port and no static address (Cloudflare Tunnel). This feature adds the direct path: the app
answers at the home's own address, proxied through Cloudflare or not.

**Research** (started 2026-11-15 on the founder's go-ahead, while 028 waits for DNSSEC):
[research.md](029-home-hosting/research.md). **The founder's decisions (2026-11-15):** the research's five recommendations: proxied through Cloudflare when the domain is on Cloudflare, else DNS-only; no UPnP or NAT-PMP mapping; OpsCrew's own updater, Cloudflare first; the server's runner as the default deploy path, Cloudflare Access SSH as an option; no DNS-01. Then (2026-11-15) a MINOR constitution amendment for the updater's standing writes, worded so anything with root on the server can exceed them, and deploys through Cloudflare Access SSH cut from 029. It covers:
- **Dynamic DNS:** what keeps the A/AAAA record current when the address changes: an updater on the
  server (a small timer of OpsCrew's, or ddclient) through Cloudflare's API with a token limited to
  that zone's DNS, or a registrar's own dynamic DNS (Porkbun, Namecheap); how often, and what the
  record's TTL should be.
- **The router:** ports 80 and 443 forwarded to the server (OpsCrew can't change the router: it
  checks from outside that they answer and says what to forward; UPnP or NAT-PMP only as an
  option); no public IPv4 address (CGNAT, `100.64.0.0/10`) or double NAT detected, with tunnel mode
  or IPv6 offered instead; IPv6 alone.
- **TLS:** Caddy's certificate through HTTP-01 (port 80 forwarded) or DNS-01 (the same DNS token),
  and Cloudflare's proxy with origin TLS when proxied.
- **Safety:** the home network exposed as little as possible (only the forwarded ports, the
  server's firewall, SSH not opened to the internet), and what an ISP's terms say about hosting.

**Also in 029's release** (founder, 2026-11-15), as tasks of their own in 029's task list, the way
0.2.9's build arguments were tasks of 028; their spec and plan sections are written when 029's
build starts, before its tasks:
- **Restore drills:** the latest snapshot (024) restored into a throwaway preview environment
  (022), its health check run, then the preview removed, which proves the backups restore; later
  on a schedule. The drill must not reach the production app's outside services (mail, payments,
  webhooks), and the production data it restores must not be reachable from outside: research.
- **A read-only database check in `advise`,** PostgreSQL first: locks and blocked sessions, long
  and idle-in-transaction sessions, slow queries (where `pg_stat_statements` is on), connections
  near the limit and disk headroom, each query under a strict timeout so the check never weighs on
  a struggling database. An index it suggests is a proposal, never applied.

## 030 Several apps on a server OpsCrew created

An app from another repository (or another app of the same one) runs on a server OpsCrew created
for a first app, beside it, with no second server to pay for. The founder asked for it on
2026-11-19, to put a second app of his on the server his first one runs on, and chose to build it
rather than create a server. It is built beside 029's release. **Release** (the founder,
2026-11-19): it ships in 0.2.11 with 029 if its live pass has passed by the time 029's home pass
is done; 029 doesn't wait for it longer than that. **Built** (2026-11-19): every task merged, and
its live pass L1 passed (11 of 11 steps, run 7), so it ships in 0.2.11. L2, the founder's own
second app beside his first, runs once his domain and accounts are ready.

**What exists today:** a server the user owns already holds apps from several repositories (013),
and previews already share another environment's created server (022). A server OpsCrew creates
has only the `deploy` login, without root or sudo, so the own-server path can't reach it, and the
first app's commands don't know about other apps on it.

**Spec, plan and research:** [030-shared-created-server](030-shared-created-server/), ADR 0035.

**Found while building, fixed after 030** (lead, 2026-11-19): `adapt` never makes an app trust
the edge's forwarded headers. Examples: Laravel's `trustProxies`, Django's
`SECURE_PROXY_SSL_HEADER`, uvicorn's `--proxy-headers` and Express's `trust proxy`. Behind the
edge such an app can build `http://` links and see the proxy's address as the visitor's. The fix
needs a code-change kind in the plan and per-framework steps that trust only private ranges.
`'*'` would let a client choose its own address through `X-Forwarded-For`. Research per framework
comes first.

## 031 A move's maintenance window of about a minute

In [031-short-move-window](031-short-move-window/), building since 2026-11-20 for 0.2.11 (the
founder's request and decision that day). `opscrew retarget` copies the data while the old app
serves, starts and checks the app on the new side on that copy, and keeps only the changes, the
release command and a restart for the window. Left for later (its research R3):
- a direct transfer between the servers;
- replication for busy databases;
- a read-only mode kept up during the window.

## 032 A Codex plugin

The founder's decision of 2026-11-21: in the release after 0.2.11, OpsCrew ships as a plugin for
OpenAI's Codex, beside the Claude Code plugin. It carries the same skills and the same
deterministic MCP server, and every change still goes through a plan approved by its hash. That
approval is enforced in the MCP server and the CLI, whatever approval mode Codex runs in. Research,
from OpenAI's docs of 2026-11-21: [032-codex-plugin/research.md](032-codex-plugin/research.md).

- **What ships:**
  - a Codex plugin manifest in `plugin/`, beside Claude Code's;
  - the skills, which Codex reads in the same `SKILL.md` format;
  - the MCP server as a stdio server;
  - a marketplace entry in `.agents/plugins/marketplace.json`.

  The install is `codex plugin marketplace add opscrew-hub/opscrew`, then `/plugins`.
- **The settings a user needs**, said in the guide and checked where OpsCrew can:
  - **Network access:** Codex's sandbox has none by default, and OpsCrew runs `tofu`, `ssh` and
    `git` against the user's clouds.
  - **Timeouts:** an MCP tool call is cut off after 60 seconds by default, shorter than an apply or
    a deploy.
  - **Tokens:** each one reaches the MCP server by `env_vars`, never written in a config file.
- **Not in Codex's public directory:** it takes no local MCP server, so the plugin ships through
  the repository's marketplace, as Claude Code's does.
- **Research first:**
  - whether a plugin's `mcp.json` takes a stdio server (OpenAI's examples are HTTP), else the
    `codex mcp add` line;
  - where a plugin sets the tool timeout;
  - whether the IDE extension and Codex cloud load it;
  - a live pass in the Codex CLI with a throwaway app.

## 040 OpsCrew's agent on the server, for live logs and status

The founder's decision of 2026-11-21, at the hosted dashboard's request: in the release after
0.2.11, together with 032 in one release (his word the same day). Building starts after his weekly
usage resets, on Wednesday 2026-11-25 at 02:00. It is numbered 040 so that 035, already being built, keeps its
number.

**Why:** the dashboard's logs come from a GitHub Actions job, a 47-second median from request to
output. A small agent on the server streams them in about a second. Everything that changes the
server stays in Actions and in plans approved by their hash.

**What:** [ADR 0036](../docs/adr/0036-server-agent.md) (Proposed) gives the design and the
protocol:
- one outbound WebSocket, with an environment's own token (`OPSCREW_AGENT_TOKEN` for the first app's
  prod, prefixed like the other deploy secrets elsewhere);
- read-only Docker access, through a socket proxy;
- logs, the containers' status and a deploy's progress, redacted before they leave the server;
- installed only where the environment has a token, and removed with it.

**Research first:**
- the agent's image;
- the Portainer stack's access to Docker;
- the deploy steps it reports;
- a self-hosted dashboard's URL.

## 041 OpsCrew runs in the user's GitHub Actions, approved from the dashboard

The founder's go-ahead of 2026-11-21, for after 032 and 040: a user who builds their app elsewhere
(Lovable and the like) deploys and runs every check with nothing installed on their own computer.

- **Where OpsCrew runs:** in the user's own GitHub Actions. On their own server once there is one,
  through its self-hosted runner (`docs/guide/runners.md`); on GitHub's runners for the first setup
  and anything that changes the server itself (resize, move, whole-server restore, destroy).
- **Never through the server agent:** ADR 0036 keeps it read-only, because a command channel there
  would let whoever took over the dashboard run commands on every user's server.
- **Tokens:** they stay in the user's GitHub secrets.
- **The core's part:**
  - **The state:** what lives in `~/.opscrew` on a user's computer today (deploy keys, generated
    values, state passphrases) is kept encrypted in the repository or in GitHub secrets, so a
    runner that forgets everything between runs can go on.
  - **Every command in a script:** each command a novice needs runs non-interactively, approved by
    its plan's hash and the typed name (`--approve <hash> --confirm <name>`).
  - **Left out:** the targets that need the user's own machine (`localhost`, a server at home).
- **The dashboard's part** (the control plane): showing each plan, collecting the approval and the
  typed name, and starting the workflow run with them.
- **The split, agreed with the dashboard's lead (2026-11-21):**
  - **The workflow file and its dispatch are the dashboard's:** `opscrew-cloud.yml`, with one
    generic `operate` job (`op`, `targets`, `args`, `hash`, `confirm`).
  - **The commands, their flags and their report are the core's.** That makes the contract the
    commands, not the runner.
  - **Each change is two runs.** A plan (`--plan-only`) writes a `report.json`. The apply
    (`--approve <hash>`, plus `--confirm` where asked) plans again and refuses if the hash
    changed.
  - **Every command writes a versioned `report.json`** whose schema the core exports. It holds:
    - its status;
    - for a plan, the plan's hash, the changes, the cost before and after, the policy results, and
      whether a name must be typed;
    - for an apply, what changed and the verify result;
    - for a failure, the step and its first line;
    - what the user must do next.
  - **Small state** goes in GitHub secrets or variables, and **generated files** go through the
    pull request the run opens.
  - **The dashboard's model** drives the chat. A core step that uses a model reaches it through the
    dashboard's gateway (`ANTHROPIC_BASE_URL`), so no other model adapter is needed for this.
- **State a run creates** (a deploy key, a state passphrase), agreed with the dashboard's lead
  (2026-11-21). A run's own `GITHUB_TOKEN` can't write repository secrets, so:
  1. **The key comes in:** the dashboard passes the target's GitHub secrets public key (the
     repository's, or the deploy environment's) as two non-secret dispatch inputs, `secrets_key_id`
     and `secrets_key`.
  2. **The run seals each new value** to it with a sealed box, as GitHub's API expects, the way
     provision already seals deploy secrets.
  3. **The report carries only ciphertext:** `report.json` lists
     `secrets: [{name, keyId, encryptedValue, place}]`.
  4. **The dashboard stores them** with its GitHub App and records the names. It never holds a
     value it can read.
  5. **A key GitHub rotated meanwhile** is refused, and the run starts again.

  Nothing secret goes into the pull request, so a public repository needs no special case.
- **Research first:**
  - what of `~/.opscrew` each command needs, and where each piece can live encrypted;
  - which commands still prompt in a script;
  - the workflow the dashboard starts, and its permissions.
- **The spec goes to the dashboard's lead** as soon as it is committed (agreed 2026-11-22): each
  op's flags, the versioned `report.json` schema and where the core exports it, the `secrets[]`
  entry, and the `operate` job's inputs. The dashboard builds nothing on 041 before then. It is
  written during 040's build, so it is ready when 0.2.13 ships.
- **The run's AI cost goes into `report.json`** (the dashboard's lead, 2026-11-25): the cost
  ledger's entries for the run, totalled per model, so the dashboard shows AI spent on the user's
  own keys without reading a second artifact.

## 033 Scaling across servers

Copies of an app's web service and workers on several servers behind a load balancer: more copies
when the load rises, fewer when it falls, within limits the user approved once. The founder placed
it after 029 and before AWS on 2026-11-15, after a suggestion to let OpsCrew scale an app onto a
few cheap servers. Apps on Hetzner, Contabo or the user's own servers can't scale out today; on AWS
(034) the managed services scale by themselves.

**What exists today:** split placement (018) runs an app's services on several servers joined by a
WireGuard private network; deploys switch without downtime, and a release gets traffic only after
its health check passes; `advise` (021) proposes resizing and moving uploads to object storage; the
self-hosted monitoring (020) keeps the figures.

It covers, in order:
- **Copies by hand first:** the web service (and the workers) on several servers, at one provider
  or at several (founder, 2026-11-16: any mix of the providers OpsCrew creates servers at and the
  user's own servers), the front server's Caddy spreading requests across them over the private network (or the provider's
  own load balancer where there is one: research), each change a plan approved by hash. Deploys
  roll across the copies one at a time, so a healthy copy always serves.
- **Only stateless services get copies:** web and workers. Databases, caches and brokers stay on
  one server each (018). The app keeps uploads in object storage and sessions out of its local
  disk: OpsCrew checks that before it adds a copy and says what to change. Cron jobs run on one
  copy only. A connection pooler goes in front of the database once there are several copies
  (PgBouncer for PostgreSQL; research for the other engines), since each copy opens connections
  of its own and the database's limit is fixed (lead, 2026-11-15).
- **Then automatic scaling, within an approved recipe:** the user approves once, by hash, a recipe
  (the providers and server types, the fewest and most copies, the figures that add or remove one, a monthly spending
  ceiling), and OpsCrew adds and removes copies inside it without asking, the way previews run
  under ADR 0026's standing approval. That needs a MINOR constitution amendment, like 029's for its
  updater, which covers the release sent back below too. What watches the figures and decides
  (the front server itself, or a scheduled GitHub Actions run) is research.
- **A release that keeps crashing after the switch, sent back by itself** (founder, 2026-11-15):
  today a release that fails its health check never gets traffic, but one that passes and then
  keeps restarting stays. An opt-in rule, approved once like the recipe: that many restarts within
  a window after a deploy take the crashing copy out while the others serve, then redeploy the
  previous image through `rollback` (019), once, and alert. On an app with one copy, the
  redeploy alone.
- **Each provider by how it bills:** where billing is hourly (Hetzner bills a server even while
  it's switched off), a copy is created when it's needed and deleted when it isn't; where it's
  monthly and a new server takes longer (Contabo), the copies are servers the user keeps; on the
  user's own servers, the user lists the ones OpsCrew may use. So a fixed base can run at a
  monthly-billed provider and the extra copies at an hourly one. How a provider bills and how fast
  its servers are ready come from its definition (ADR 0029), never from code that names it.
- **Across providers, the distance counts:** copies reach the database over the internet
  (encrypted by WireGuard), so every query pays the round trip; design shows it, measured between
  the servers, and warns when copies sit far from the database. Surviving one provider's outage
  also needs the database's standby at another (database replicas, under Later).
- **Then, on top of the copies:** a release sent to a share of the requests first, promoted in
  steps or sent back, which needs copies to split traffic between.
- **Research first:** load balancing on each provider (Caddy over the private network, Hetzner's
  load balancer, Cloudflare's), how fast a new copy is ready (a prepared image or cloud-init), the
  figures that drive scaling (CPU, memory, request rate and latency from Caddy's own metrics, queue
  depth) and how to keep them from flapping, draining a copy before it's removed, and the cost of
  each step shown in the plan.

## 034 AWS

The first hyperscaler. **Direction (founder, 2026-10-13):** the most suitable setup using AWS's
managed services for each app, not just the backend on Fargate or EC2, while the user keeps
control of every decision:
- The Architect maps the detected needs (web/SSR, workers, cron, websockets, Postgres/Redis,
  files, email, queues) and the interview's answers (scale, budget, uptime, data criticality,
  region) to managed services.
- Cost traps are explicit decisions, with live prices: NAT gateway vs endpoints, Multi-AZ, load
  balancer minimums.
- `plan.yaml` records per component the choice, a plain-English why, the alternatives and the
  monthly cost. Presets: lean, balanced, production-HA. Overrides through interactive design,
  `opscrew design --set <component>.<field>=…`, or editing `plan.yaml` (validated, re-priced, the
  difference shown before apply). User pins: region, budget cap, no NAT, an existing VPC or
  database, keep Cloudflare DNS.
- Guardrails on by default (private database, encryption, backups, least privilege). Relaxing one
  is an explicit, recorded exception with a reason, never silent.
- Readable vendored modules per component (pinned **terraform-aws-modules**), **Infracost** for
  prices, keyless CI (GitHub OIDC), drift flags hand edits. Start with an ADR and the plan schema
  for components and overrides, before any provider code.

**Compute, chosen per use case:**
- EC2 + Compose (and Lightsail) for small steady apps; it plugs into the VPS seam and enables
  `retarget --to aws`;
- ECS Fargate for web plus workers, uptime needs or spiky load;
- App Runner for simple stateless HTTP;
- ECS on EC2 for large steady load or GPUs;
- Lambda only for small jobs. **Read first:** AWS's October 2026 announcement of Lambda web
  functions (https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/); if it
  makes Lambda a real option for serving web apps, weigh it per use case like the others
  (founder, 2026-10-14).

**Per component:** RDS or Aurora Serverless v2; ElastiCache (Valkey, no eviction for queues); S3
(+ CloudFront); SES; Secrets Manager or Parameter Store; EventBridge Scheduler for cron; SQS/SNS
when the app already uses them (otherwise a recommendation only); SNS for OpsCrew's alerts.

**Databases (founder, 2026-10-16):** a managed service only when the app's existing driver works
with it unchanged; the app's code is never rewritten for a cloud service:
- Postgres → RDS/Aurora; MySQL → RDS/Aurora MySQL; Redis → ElastiCache (Valkey);
- MongoDB → MongoDB Atlas on AWS, or DocumentDB with a compatibility warning;
- Elasticsearch/OpenSearch → Amazon OpenSearch Service (OpenSearch clients, Elasticsearch clients
  up to 7.10), else Elastic Cloud on AWS or a container;
- ClickHouse → ClickHouse Cloud (AWS Marketplace) or a container on EC2 (Redshift's SQL differs);
- Neo4j → Neo4j AuraDB or a container on EC2 (never Neptune: Neo4j's drivers can't talk to it);
- Cassandra → Amazon Keyspaces (CQL).
- A container on EC2 with EBS stays a cheaper choice the user can pick; Fargate is not used for
  databases.

**Observability on AWS (founder, 2026-10-30):** the same layers as 017 and 020, with AWS's own
services, each one explained, priced at design and changeable:
- **Logs:** CloudWatch Logs (ECS and App Runner send container logs there; EC2 through the
  CloudWatch agent), queried with Logs Insights. `opscrew logs` reads them through AWS's API.
  Retention and sampling are settings with their price shown.
- **Figures:** CloudWatch metrics and Container Insights, plus RDS's and ElastiCache's, read on
  demand by `opscrew status`.
- **Alerts:** CloudWatch alarms to SNS (email or a chat webhook) for health, errors, CPU, memory
  and database storage. The GitHub-issue check (017) can stay too.
- **Dashboards and history, opt-in:** Amazon Managed Grafana with Amazon Managed Service for
  Prometheus. Grafana reads CloudWatch Logs directly, so there is no second log store. CloudWatch
  dashboards are the cheaper default. Grafana Cloud (017) stays an option.
- **Full-text log search, opt-in:** Amazon OpenSearch Service with OpenSearch Dashboards (the
  Kibana equivalent), only for large log volumes or users who already work that way. A
  provisioned domain bills around the clock, and serverless has a minimum capacity charge, so
  design says so plainly. Not the default: indexing every word costs far more memory and money
  than CloudWatch Logs or Loki's label index. Elastic Cloud (Elasticsearch and Kibana, Elastic
  License) stays the user's own choice.
- **Traces, opt-in:** X-Ray or CloudWatch Application Signals.
- **Collection** through OpenTelemetry (the AWS Distro for OpenTelemetry), so the destination is a
  setting. Research first: current prices and free tiers, Container Insights' cost per container,
  and what each compute choice sends by default.
- Azure and Google Cloud follow the same pattern with Azure Monitor and Google Cloud Monitoring
  and Logging.

**Opens with installing provider packages** (moved here from 026 on 2026-11-11, founder; 026's
research R3 and R4): AWS ships as the first separately installed package
(`@opscrew/provider-aws`, `opscrew plugin add aws`, or offered by the interview), then Azure and
Google Cloud. The contract for such packages is shaped by AWS, which is not a VPS; 026's contract
for cloud server providers is where it starts.
- The safety gate stays in core: packages only produce plans; hash-bound approval, policy, apply
  through the IaC engine and redaction are core's (constitution I and IV).
- Only official `@opscrew/*` packages at first, pinned to an exact version, installed with npm
  and no install scripts into OpsCrew's own folder (as the Claude Agent SDK is), and checked
  against npm's provenance: built by OpsCrew's repository and release workflow from a tag.
  Third-party packages later, behind an explicit opt-in.
- Only plain data and functions cross into a package; the core validates everything it returns.
- The Claude Code side follows the same split: one provider = one npm package plus one Claude
  Code plugin `opscrew-<provider>@opscrew` that depends on the core plugin, released together;
  the core plugin keeps the provider-neutral skills and the one MCP server. Research first: a
  spike that a skill in one plugin can call the core plugin's MCP tools (not documented).
  One ADR covers both.
- Each package released adds one npm approval for the founder (staged publishing approves one
  package at a time).

**Testing (founder, 2026-10-18; LocalStack added 2026-11-13):** an AWS emulator for nearly all
tests, OpenTofu plan and apply included, instead of a real account. Two candidates; the feature's
research compares them and the lead decides: one of them, or both, each for what the other lacks.
- **floci** (https://github.com/floci-io/floci; MIT; one Docker image, `floci/floci`, on port
  4566; Terraform and OpenTofu through the standard AWS provider; EC2, ECS, ECR, RDS, ElastiCache,
  S3, SQS/SNS, Secrets Manager/SSM, IAM/STS, Route 53, ACM, CloudWatch, EventBridge Scheduler,
  Lightsail, ELB and more; RDS, ECS and Lambda need the Docker socket). What it can't show:
  - IAM permissions (not enforced: any credentials work), so least privilege goes untested;
  - GitHub OIDC trust against real AWS;
  - real networking, load balancers and certificates; its prices are a static snapshot.
- **LocalStack** (https://www.localstack.cloud). floci's README says LocalStack Community ended in
  March 2026; the research checks that, its licence and price, which services and features its free
  tier covers, and whether it enforces IAM, all against these gaps and the services the AWS design
  uses.

A small optional live pass on a throwaway account covers only what the chosen emulator can't show,
rarely run. If it never runs, those stay "not tested live" on the coverage page.

## After AWS: more providers, in phases (founder, 2026-11-16)

The founder listed the providers to add and left the phases to the lead. Hetzner and DigitalOcean
are built in already; AWS is 034. A phase that brings a provider brings its live test only with an
account the founder opens, so each phase's live tests are decided when it starts.

**Amazon CloudFront comes with 034** (S3's files behind it, in its per-component list); in front of
a whole AWS app it joins 036's contract. **Azure Front Door comes with Azure** (038).

### 035 More server providers, first wave: OVHcloud, Kamatera, IONOS Cloud, UpCloud

Each is a provider package on 026's contract (ADR 0029), installed as 034 makes provider packages
installable, so none of them grows the core, and each can host 033's extra copies.

**Started early** (the founder's decision, 2026-11-21): a second contributor builds this wave beside
032, from OVHcloud on. Until 034 brings installing, each provider is built in, as Contabo is in
`packages/providers/`. The contributor and the core's lead coordinate through GitHub issues whose
titles start with `[035]`.

**Order** (the founder's decision, 2026-11-20): OVHcloud first, then Kamatera, IONOS Cloud and
UpCloud. Vultr, Akamai Cloud and Scaleway follow in 037.

**Their shapes differ from Hetzner's more than the second wave's do:**
- OVHcloud's Public Cloud runs on OpenStack with its own projects and keys.
- IONOS Cloud builds servers inside a virtual data centre.
- Kamatera has an API and account model of its own.
- UpCloud's servers are Hetzner's shape.

**Research first, per provider:**
- its API and Terraform provider;
- how it bills a server, and a switched-off one;
- its firewall and private networking;
- its backups and snapshots;
- its regions, and its prices read live;
- how its account's projects or data centres map to an app.

**Kamatera's firewall** (the founder, 2026-11-25, issue #13). Kamatera has no cloud firewall
OpsCrew can manage (no API route or Terraform resource), so its servers get a firewall on the
server itself:
- nftables, default deny, installed as the first step of the first boot;
- `opscrew secure` and SecOps check its rules in place of a cloud firewall, and fail the server
  until they are there;
- the plan, design's summary and the guide say "cloud firewall: none; server firewall: on", and
  name the few seconds after boot before the rules apply.

This is the one provider where the firewall is the server's own.

### 036 Edge providers in place of Cloudflare's proxy: Bunny.net, Gcore and Fastly

**Started early** (the founder, 2026-11-25): a contributor builds it after 045, ahead of 033 and
034, coordinating through issues titled `[036]`.

It opens with the contract for the DNS and edge provider, with Cloudflare moved behind it (026's
rule: a contract when the second implementation arrives); designing it with three at once keeps it
from being shaped by one. Bunny.net and Gcore also host DNS, so a domain can leave Cloudflare
entirely; Fastly hosts none, so its domain stays at Cloudflare (DNS only) or the user's DNS host.
What stays Cloudflare's (Tunnel, Access, Workers hosting, R2) is said in design, and an app behind
another edge has its server reachable only from that edge. For each one: OpsCrew's rule against
probes for secrets and admin panels, the edge's certificates for the app's hostnames, and its
cache kept off what must not be cached.
- **Fastly** (founder, 2026-11-11, moved here from Later): a Fastly service through its official
  Terraform provider (`fastly/fastly`), with Fastly's certificates for the app's hostnames (5
  domains free, then $20 a domain); the probe rule written into the service, since Fastly's WAF is
  sold in paid packages; later, if users ask, sites on Fastly Compute (like Workers) and Fastly
  Object Storage (like R2). Its free tier covers 100 GB and 1M requests a month (its pricing page,
  2026-11-11).
- **Research first:** how the origin is restricted to each edge (published IP ranges, a shared
  secret header, mutual TLS), how hostnames and the apex point at it, how certificates are
  validated, which of them can block those paths on their free or cheapest plan, their Terraform
  providers, and their prices.

### 037 More server providers, second wave: Vultr, Akamai Cloud (Linode), Scaleway

After the first wave (the founder's decision, 2026-11-20). **Started early** (the founder's
decision, 2026-11-22): 035's contributor builds it right after 035, ahead of 036, coordinating
through issues titled `[037]`. Their servers are the shape OpsCrew
already handles at Hetzner (a server, a firewall, an SSH key, backups or snapshots, billed by use).
**Research first:** the same list as 035's.

### 038 Azure and 039 Google Cloud

After the providers above, as provider packages, reusing 034's managed-services design, Azure
Verified Modules, terraform-google-modules and Infracost. Azure brings Azure Front Door and Azure
DNS as its edge and DNS; Google Cloud brings Cloud CDN, Cloud Armor and Cloud DNS. Both join 036's
contract.

### Later, if users ask
- **Enterprise edges:** Akamai's CDN and security services, and Imperva, both aimed at large
  companies.
- **A website firewall in front of a hosting account (027):** Sucuri, common with WordPress on
  shared hosting.
- **CDNs for an app's files:** KeyCDN and CDN77, used mostly for an app's static files and media
  rather than in front of the whole app.
- **Cloudways:** a managed hosting platform on servers it runs at DigitalOcean, AWS, Google Cloud,
  Vultr and Akamai. OpsCrew would deploy into a Cloudways application through its API, the way it
  deploys into a hosting account (027).

## 042 GitLab, opening the contract for git platforms

**The decision:** GitLab, Forgejo and Gitea join GitHub as git platforms, in the core and in the
dashboard, which reaches each through one adapter (founder, 2026-11-21). They come after 039, so
the order above stays as it is; he can move them earlier.

**The contract:** GitLab comes first, as decided on 2026-10-14. It opens with a contract for the git
platform, with GitHub moved behind it (026's rule, as ADR 0029 did for cloud providers). Each
platform is one package, and no code outside it branches on a platform's id. The contract covers
what `@opscrew/connector-github` does today:
- the repository's files and branches, and deploy keys;
- environments, secrets and variables: GitLab's protected and masked CI/CD variables, scoped to an
  environment;
- the deploy pipeline (`.gitlab-ci.yml`), started and read;
- the image registry: GitLab's container registry beside GHCR;
- the runner on the user's server (GitLab Runner) and the runners guide;
- previews per merge request (022), with CI's standing approval (ADR 0026) enforced the same way;
- `opscrew init` telling the platform from the remote: gitlab.com, or a self-managed host.

**What waits:** 041's runs started from the dashboard reach each platform once it has the
contract. GitHub Pages as a site host stays GitHub's unless research finds GitLab Pages worth
adding.

**Research first:** GitLab's API for CI/CD variables, deploy keys and pipeline triggers; the
registry's tokens; and which of these the Free tier has, such as protected environments.

## 043 Forgejo and Gitea

**How they come in:** after 042, through its contract. Forgejo (a fork of Gitea, which Codeberg
runs) and Gitea, hosted or on the user's own server.

**What it builds:**
- **The deploy workflow:** Forgejo's and Gitea's Actions read GitHub Actions' workflow syntax for
  the most part, so the workflow is GitHub's template with the differences research finds.
- **One connector or two:** one connector serves both if their APIs still match (secrets,
  variables, deploy keys, containers in the package registry); otherwise two.

**Research first:**
- the version of each that has the Actions secrets and variables API;
- whether a workflow can be started through the API (for 041);
- the workflow folder and `runs-on` labels;
- how far each one's runner differs from GitHub's.

## 044 OpenAI API keys beside Anthropic's

The founder's request (2026-11-25, through the dashboard's lead): "we should also add openai api
key alongside anthropic and openrouter support". Today only the phases that use a model (the
Analyst's reading of the code and the Code-change agent's edits) need one, through
`@opscrew/runtime-claude`, with an Anthropic key, Bedrock, Vertex, Foundry, or an
Anthropic-compatible gateway such as OpenRouter's.
- **A second runtime,** `@opscrew/runtime-openai`, behind the same `AgentRuntime` contract, used
  when the run has `OPENAI_API_KEY` and no Anthropic credentials (both set: Anthropic, unless
  `OPSCREW_RUNTIME=openai`). `OPENAI_BASE_URL` points it at a compatible gateway.
- **The same safety:** every tool call the model makes goes through OpsCrew's tool policy
  (`packages/core/src/policy.ts`), the same profiles and the same redaction as the Claude runtime.
  An SDK whose built-in tools run outside that policy is ruled out.
- **The same accounting:** each phase's spend goes into the cost ledger (`.opscrew/costs.jsonl`),
  priced from the model's list price, and `--max-budget` stops it the same way.
- **Research first** (official sources only): OpenAI's SDKs for an agent loop with our own tools
  (the Responses API, the Agents SDK, and whether 032's Codex work helps), the default model and
  effort, structured output validated with zod, and pricing for the ledger.

## 045 Postgres extensions for an app's database

The dashboard's lead (2026-11-25), for a module that keeps vectors in pgvector, before that
module's first version: an app's PostgreSQL service names the extensions it needs, for example
`extensions: [vector]`.
- **The image:** OpsCrew picks a pinned image that has every named extension (the official
  `pgvector/pgvector` image for `vector`), and refuses an extension it has no image for, before
  anything changes, with the list it supports.
- **PostGIS too** (the founder, 2026-11-25: many apps use maps and geodata): the official
  `postgis/postgis` image, after `vector`. It is built for amd64 only, so design then offers only
  amd64 servers. Its config tables and `topology` schema keep 047's restore rules.
- **The database:** `CREATE EXTENSION IF NOT EXISTS` runs before the app's migrations, as the
  role that may create them, so the app's own role needs no more rights.
- **The lifecycle:** snapshots, restores, restore drills and moves keep the extensions, and
  switching an existing database's image is shown in the plan with its restart.
- **Built by a contributor** (the founder, 2026-11-25), once 047 is on `main`, since both change
  the same PostgreSQL service. Issue `[045]`.

## 046 An uptime check that doesn't use GitHub Actions

The founder's decision (2026-11-25): built first and released as 0.2.12, with 032; 040 follows in 0.2.13. In a private
repository the scheduled check costs Actions minutes, so a user who turns it off has no down alert
at all. Cloudflare's standalone Health Checks need the Pro plan, but Workers' free plan has Cron
Triggers (5 per account), with fetch time not counted as CPU.
- **The setting:** `observability.check.runner: actions | cloudflare`, with `actions` as the
  default and as today.
- **What it checks:** with `cloudflare`, a Worker in the user's own Cloudflare account fetches each
  app's health address over HTTPS every 5 minutes. A failed request counts as down, and that
  includes an invalid certificate and the whole server being down. The server reports its disk
  and snapshot checks itself (below).
- **Alerts:** the same Slack, Discord or ntfy webhook the Actions check uses, stored as a Worker
  secret. One message when an app goes down and one when it recovers, with the state kept in
  Workers KV and written only when it changes. It opens no GitHub issue: that would need a GitHub
  token in the Worker.
- **Several apps in one account:** the free plan allows 5 Cron Triggers per account, so one shared
  OpsCrew Worker per account checks every app that chose it. Each app owns only its own entry. Its
  provision adds the entry and its destroy removes it, and the last app's removal removes the
  Worker.
- **The safety gate:** the Worker, its trigger, its KV namespace and its secrets are changed only
  through a plan approved by its hash, like the rest of the app's Cloudflare setup, and the plan
  names the other apps' entries it keeps. Tests use fakes, with no live Cloudflare.
- **A complete alternative** (the founder, 2026-11-25; 0.2.12 waits for it). With `runner:
  cloudflare`, nothing needs GitHub Actions any more. Each environment chooses its own runner.
  - **The server checks itself:** a timer on each server OpsCrew manages, installed by a host
    plan approved by its hash, checks the disk, the last snapshot and the restore drill against
    the Actions check's thresholds.
  - **It reports only on change:** to the Worker's own address, signed with the app's own
    secret, when a check fails or recovers, plus one heartbeat a day. Workers KV's free writes
    (about 1,000 a day per account) allow nothing more frequent.
  - **The Worker alerts** through the same webhook, and also when a server's heartbeat is more
    than a day late. Together with the 5-minute address check, that covers a server that's down.

## 047 An app's PostgreSQL never runs as the superuser

The dashboard's lead (2026-11-25), for DevMem's row-level security, which a superuser ignores even
when forced. Today an app connects as the image's `POSTGRES_USER`, a superuser, so a bug or an
injection in the app has every right.
- **Two logins:** an owner used only by the release command (migrations), and a runtime login for
  the web, worker and cron processes, which is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS`, with `PUBLIC` revoked and default privileges, so new tables just
  work. The bootstrap superuser stays with database administration only.
- **The default** for new databases. An existing database gets a guided switch, in place, through
  a plan approved by its hash, and a failed switch changes nothing.
- **The starting point:** the PostgreSQL part of an outside contribution reviewed on 2026-11-25
  (separate logins, the grants replayed after each release, restore and moves keeping the roles).
  That part reviewed as sound; its rotation must not restart the database.
- **Research:** a library that creates its own schema at runtime (pg-boss) needs that schema made
  by the owner first, or `CREATE` on it.
- **In 0.2.12** (the founder, 2026-11-25), built in parallel with 046's server checks. 045, which
  changes the same PostgreSQL service, comes after it.

## 048 Change an app's values without a full provision

The founder's request (2026-11-25): add or change one app value for an environment without
running `provision` again. A re-provision reapplies the Cloudflare, DNS and host plans just to
store a value.
- **The commands:**
  - `npx opscrew values set --env <env> NAME` reads the value from stdin or `--from-file`,
    never from argv or shell history;
  - `values unset NAME` removes one;
  - `values list --env <env>` shows names and where each comes from, never a value.

  Multi-line values (a PEM key) work.
- **What it changes:** only the environment's stored app values, in its GitHub environment
  secret, OpsCrew's home and the recovery copy, through the same approval rules as provision's
  secret step. No infrastructure plan runs.
- **The app sees them after a deploy:** with `--redeploy` it starts one, and otherwise it says the
  next deploy applies them.
- **In 0.2.12** (the founder, 2026-11-25: build it now). A value is taken only from stdin or a
  file, never from argv, and every output shows names only, so no value can be echoed back.

## 049 Each app's own network on a shared server

A security review of an app on a shared server (2026-11-25). Every OpsCrew app on a server joins
the edge's one network, `opscrew-edge`. So a taken-over container of one app can reach another
app's port directly, from a private address. An app that trusts proxies on private addresses (as
it should, for the real path: Cloudflare, Caddy, kamal-proxy) then takes that container's forged
`X-Forwarded-For` as the client's address, which defeats limits kept per address.
- **The fix (the lead's call):** each app gets its own network, which only that app's containers
  and the edge's kamal-proxy join. Caddy reaches only kamal-proxy, on the edge's own network. A
  fixed kamal-proxy address that apps trust exactly was the other option. It was turned down
  because a neighbour could still reach the app's port.
- **What to keep:** when the edge's containers are recreated (a new edge version), kamal-proxy
  joins every app's network again before it routes, so no app on the server goes down. An
  existing server switches over at the next deploy of each app, under the host plan approved by
  its hash.
- **In 0.2.13**, beside 040. It changes the edge, the deploy's switch step and the host plans.

## Later, not yet placed

- **A connection pooler for an app's PostgreSQL** (from a profile of a deployed PHP app,
  2026-11-26): a PHP app opens a new PostgreSQL connection on every request. On a small VPS a fresh
  backend measured about 160 ms per page (the connection itself 28–35 ms, the rest the new
  backend warming its caches), against about 26 ms on a kept connection. TLS isn't part of it:
  OpsCrew's PostgreSQL runs without SSL on the app's own network, so `sslmode=prefer` falls back
  after one packet. An optional PgBouncer in transaction mode between the app and its database
  would give every such app kept backends without a code change (prepared statements need
  PgBouncer 1.21 or later, or emulated prepares). Apps that can change their code can use
  persistent connections or a worker mode (FrankenPHP's, Octane) instead.
- **Previews checked by a test run before promoting** (the dashboard's lead, 2026-11-25, for a
  module that writes end-to-end tests and runs them in the user's Actions): `promote` reads a named
  check's result for the preview's commit and refuses a failed one unless the user overrides it,
  and each preview's address is published in a known place a later workflow can read. Nothing is
  needed before that module's second version.

- **Node.js and Python apps through cPanel's Application Manager and Plesk's Node.js, if users
  ask** (founder, 2026-11-18, from 027's plan 8.): on a cPanel host without CloudLinux. 027 runs
  such apps through CloudLinux's selector, which most shared hosts with cPanel have and which
  installs the runtime and the app's packages itself; Application Manager
  (`PassengerApps::register_application`) only registers an app already on disk, so OpsCrew would
  bring the runtime and the packages, and the founder's test account (CloudLinux, LiteSpeed, no
  `node` or `npm` outside the selector) can't test it live.
- **Database replicas** (founder, 2026-11-15): a second database server that copies the main one
  continuously, for reads (Rails and Laravel send reads there by configuration; Django through a
  database router) and as a standby, at the same provider or a second one, so that 033's copies at
  two providers survive one of them failing. The standby takes over through an approved switch the
  user starts first; taking over by itself only after research (Patroni and the like).
- **Left out** (founder, 2026-11-15, from an outside proposal of 20 features, a third of which
  OpsCrew already has): a local dashboard (the hosted control plane is the dashboard), a templates
  marketplace, an operations knowledge base, chaos testing, and compliance evidence reports until
  a customer asks. Sharding a database too: the app must be written for it, it pays off only far
  beyond one large server, and AWS's managed databases (034) serve apps that big.
- **Down migrations for Alembic projects with several heads, if users ask** (founder, 2026-11-06,
  from 019's database rollback): Alembic's several bases or `branch_labels`, which modular
  codebases use on purpose; no widely used package is known to ship its own branch. Since T1943
  they deploy with `alembic upgrade heads` and their rollback offers the snapshot or keep. Down
  migrations would record one revision per head and migrate each branch down
  (`alembic downgrade <branch>@<rev>`, to check against a real container).
- **A password in front of an environment, as a follow-up to 022** (founder, 2026-11-05, from
  022; kept for later as 022's follow-up, founder, 2026-11-06): HTTP basic authentication in the
  Caddy site (a bcrypt hash made on the user's computer; the health route left open), opt-in per
  environment, because a login can break what calls the app (webhooks, OAuth callbacks, API and
  mobile clients). 022 gave previews and the other environments hidden addresses instead (022
  research R6). Cloudflare Access in front of Cloudflare-hosted sites belongs here too.
- **Moves between a site and a server, through a Cloudflare Tunnel, or between two Portainer
  environments** (lead, 2026-11-05, from 023's plan): `retarget` moves between any two server
  targets and between site hosts. A site becoming a server app (or back) changes its whole design.
  A tunnel on either side needs two DNS changes with an outage between them. Two Portainer
  environments would share one deploy branch and webhook. All three stay refused with the steps to
  do them by hand.
- **Tailscale or Headscale as the private network** (lead proposal, 2026-10-18; the founder is
  interested in Headscale), next to 018's plain WireGuard:
  - Tailscale for users with a tailnet: OpsCrew joins the servers with tags and writes the ACLs,
    with an auth key. Its free Personal plan is for non-commercial use only, and OpsCrew says so.
  - Headscale (BSD-3-Clause) coordinates the official Tailscale apps from the user's own server,
    with no Tailscale account. Research first: its version, how far its ACL support goes, and the
    mobile apps' custom-server setting.
- **A Docker Swarm the user already runs, and Swarm environments in Portainer** (founder,
  2026-10-21). Swarm gives true zero-downtime redeploys (`deploy.update_config.order:
  start-first`). It needs a Swarm variant of the stack: Portainer's swarm-stack API,
  `deploy.resources` for memory limits, overlay networks, no `depends_on` conditions, and no
  `env_file: stack.env`. Do it when users with Swarm ask. 018's research chose WireGuard plus
  Compose over Swarm for OpsCrew's own servers.
- **Proxmox VE as a provider, maybe** (founder, 2026-10-15): OpsCrew creates the VM through the
  Proxmox API from a cloud-init template, then 009's host setup and tunnel path (Terraform
  provider `bpg/proxmox` to be researched). Until then, Proxmox users create a VM themselves and
  use their own server (009) or their Portainer (010).
- **Other code hosts and CI** (founder, 2026-10-14):
  - **Placed:** GitLab is now 042 and Forgejo and Gitea 043 (founder, 2026-11-21).
  - **Azure DevOps stays here:** pull requests, variable groups, `azure-pipelines.yml` and
    workload-identity service connections. It pairs with Azure and joins 042's contract.
  - **Not planned:** Jenkins; Ansible is not used.
- **Kubernetes:** out of v1. Later, deploying into a cluster the user already runs (EKS, GKE,
  AKS, DOKS, k3s) with Helm charts and the same plan, approval and security gates; OpsCrew never
  creates clusters.
