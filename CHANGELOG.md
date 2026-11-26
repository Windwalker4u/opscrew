# Changelog

What changed in each release of OpsCrew: the `opscrew` CLI on npm and the Claude Code plugin, which
installs the same version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until 1.0, a release can change the files OpsCrew writes and the commands' flags.

## [0.2.12] - 2026-11-26

Every deploy workflow changes: its deploy jobs now run only on their environment's own branch, and
the workflow no longer names the OpsCrew version. Run `npx opscrew provision` for each environment
and merge its pull request. An existing app's PostgreSQL keeps its one login until you switch it
(see below), and nothing else needs redoing.

### Added

- **An uptime check in your own Cloudflare account.** Set `observability.check.runner: cloudflare`
  and the check runs as a Worker in your Cloudflare account, with no GitHub Actions minutes. The
  server reports its own checks to the Worker as well: its disk, its snapshots, its restore drills,
  its certificates and the age of its credentials. The Worker posts to your alert webhook when a check
  fails, and when a server's report stops arriving for 26 hours. The Cloudflare token needs two more
  permissions, which design and provision check for. It isn't for hosting accounts yet. See
  [Alerts](docs/guide/alerts.md#in-your-cloudflare-account-instead-of-github-actions).
- **Two logins for an app's PostgreSQL.** The release command migrates as the schema's owner, and
  the app, its workers and its cron run as a login that can only read and write data, with no
  right to change the schema. New databases get both by default. An existing database switches
  with `logins: separate` and `npx opscrew provision`: the switch is an approved plan, with a
  snapshot taken first. Moves, restores, restore drills, rotation and `destroy` know both logins.
  See [Databases](docs/guide/databases.md#two-logins).
- **`npx opscrew values set|unset|list`.** Change one app value of an environment without a full
  provision, and list what is set. OpsCrew keeps the values you set in its own home folder, and a
  terminal's `provision` offers to reuse them. See
  [Environments](docs/guide/environments.md).
- **PostgreSQL extensions on a new database.** Name them in the plan, such as `extensions: [vector]`
  for pgvector; PostGIS is available on amd64 servers, and PostgreSQL's built-in contrib
  extensions work too. OpsCrew pins the images and creates the extensions as the database's
  superuser, once, so the app never runs as one. Changing the extensions of an existing database
  is refused for now. See [Databases](docs/guide/databases.md#postgresql-extensions).
- **An optional connection pooler for PostgreSQL.** Set `pooler: pgbouncer` and PgBouncer runs in
  session mode beside the database. `npx opscrew design` turns it on for new PHP apps. The web
  process and cron go through the pooler; workers and the release command's migrations connect to
  PostgreSQL directly. Rotating the app's password, a restore drill and a move bring the pooler
  along. See [Databases](docs/guide/databases.md#a-connection-pooler-for-php-apps).
- **OpenAI API keys beside Anthropic's.** Set `OPENAI_API_KEY` (and `OPENAI_BASE_URL` for a
  compatible endpoint) and OpsCrew's AI steps run on OpenAI. `OPSCREW_RUNTIME` picks one when both
  keys are set. The same policy and budget limits apply as with Claude. See
  [AI models](docs/guide/ai-models.md).
- **A Codex plugin.** OpsCrew's skills and its MCP server install in Codex as they do in Claude
  Code. See [The Codex plugin](docs/guide/codex-plugin.md).
- **OVHcloud as a server provider.** `opscrew interview`, design, provision, snapshots and the
  restore drills work with OVHcloud servers, with the provider's own price table. A move's finish
  and `destroy` name the snapshots that outlive the server before you type its name. See
  [Deploy to OVHcloud](docs/guide/ovhcloud.md).

### Changed

- **`opscrew scan` leaves out a guessed secret in test code and in ignored paths**, and counts
  it. A secret in a provider's own format, a private key and a committed `.env` with values still
  keep their severity anywhere. See [Security](docs/guide/security.md).
- **Generated files no longer name the OpsCrew version.** The version is recorded in
  `opscrew/plan.yaml`, so an upgrade changes the files only when their content changes. A build
  between releases names its commit.
- **Caddy keeps your app's own `X-Content-Type-Options`, `X-Frame-Options` and
  `Referrer-Policy`**, and adds OpsCrew's only to answers that have none. It removes `Server` and
  `X-Powered-By` from every answer. See
  [your app's own headers](docs/guide/reverse-proxy.md#your-apps-own-headers).
- **`SECURITY_REPORT.md` and `ARCHITECTURE.md` no longer name the OpsCrew version.**
- **The MCP server's tool list is about a third of its size** (39,193 characters instead of
  108,213), so it takes less of your AI's context.
- **Workers, the release command and seed commands run without a shell** when they need none.
- **Removing a container removes its anonymous volumes too**, so none are left behind.

### Fixed

- **A Laravel app's database gets `DB_URL`** when its `.env.example` comments out `DB_HOST`. Laravel's
  own config defaults make a variable optional, and a Laravel app with its own Dockerfile keeps its
  release command.
- **A restore with the two logins works.** A restore loads as the schema's owner, the superuser
  restores a schema's comments first (so PostGIS's topology loads), and a whole-server restore sets
  both logins again. A dump with event triggers is refused with the reason.
- **A database on a cloud server never applied has no data to protect**, so the logins' switch
  doesn't take a snapshot of it or wait for one.
- **A rotation in a script no longer asks for the uptime host plan** with the rotation's hash.
- **`opscrew provision` stops before any work when you are off the environment's branch.**
- **OpsCrew's own files that your `.gitignore` ignores are still committed** to the pull request.
- **A base image whose binary has a file capability** (such as `ping`) is warned about at design,
  and the deploy names a refused binary only when the image logs it.
- **`drift` reports an uncommitted plan** and `provision` warns, in the temp folder, instead of
  failing.
- **`opscrew mcp install` from a build between releases** sets up its own release.
- **The report-only image scan never fails the deploy.**
- **A whole-server snapshot's ID can be a UUID**, as OVHcloud's are, and the agent's environment
  leaves out OVHcloud's `OVH_` variables.
- **A move's finish reads the earlier snapshots before every approval.**
- **Design offers a dedicated server type when no shared one holds the app.**
- **The uptime Worker** drops a hostname that left its entry from the state at once, refuses
  an account with no workers.dev subdomain before anything changes, and fails an apply whose
  secret another app's upload dropped. A destroy that can't find the uptime entry stops instead
  of skipping it.
- **OpenTofu runs without the home address updater's tokens** in its environment.
- **A credential name over 128 characters no longer stops provision**: it is left out of the
  uptime report, with a line saying so.

### Security

- **The agent's tool policy closes a set of bypasses.** Bash commands that contain a carriage
  return are denied. Every path and redirect in a Bash command is checked for where it really
  leads, a `..` after a link is refused, and only commands named without a path are pre-approved.
  A `Grep` that shows lines needs a glob that keeps secret files out, `tree -R` and `tree -o` are
  no longer pre-approved, and a `]` right after `[` in a glob is a member of the class. A write
  to a GitHub Actions workflow or action asks first, and shows what it says.
- **A directory named like a secret file counts as secret.** Anything inside a folder named
  `.env` is kept out of the agent's reach, as a `.env` file is.
- **Generated deploy workflows run deploy jobs only on their environment's own branch**, so a
  workflow started from another branch never deploys with your production secrets.
- **The Cloudflare Worker rollback checks its version ID** before it passes it on, and passes it
  through an environment variable, never into the command line.
- **A site's own security headers are never weakened.** A header your `_headers` file sets is
  kept as you wrote it, and `npx opscrew verify` checks the Content-Security-Policy,
  Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy that file sets.

## [0.2.11] - 2026-11-21

Every deploy workflow of an app on a server or in your Portainer changes. Run `npx opscrew
provision` for each environment and merge its pull request. A move with `opscrew retarget`
proposes the new workflow first when yours is older. At that provision, two plans change once, and
you approve each as usual:

- **Every app with its DNS on Cloudflare** gets an infrastructure plan that only renames its A and
  AAAA records in OpenTofu's state (`module.dns.cloudflare_dns_record.a` becomes `a[0]`): nothing
  changes at Cloudflare, but the plan's hash does.
- **Every server with the Cloudflare-only filter** gets one more file in its host plan, a drop-in
  for the `nftables` service, so a restart or reload of nftables restarts Docker and the filter
  comes back with it.

### Added

- **Hosting at home.** Serve your app from a computer at home, such as a Raspberry Pi or a mini PC,
  at your connection's own public address: answer **yes** when `npx opscrew interview` asks whether
  the server is at your home. OpsCrew tells you what to forward on your router, serves the site
  behind Cloudflare's proxy with origin protection (over IPv6 too) or with DNS only, and keeps SSH
  open to your home network alone. With your DNS on Cloudflare, an address updater on the server
  keeps the domain's A and AAAA records at your current address, with a token of its own limited
  to the zone's DNS (`OPSCREW_DNS_UPDATER_TOKEN`), installed through the host plan you approve by
  its hash. Deploys run on the server's own runner, so GitHub never holds your home's address.
  `npx opscrew verify` checks from outside your home through a GitHub workflow,
  `opscrew-outside-check.yml`. Design tells you when your connection has no public IPv4 address of
  its own and offers the Cloudflare Tunnel or IPv6 instead, and warns about a Raspberry Pi's SD card
  and power supply. `npx opscrew rotate dns-updater` replaces the updater's token, and `status`,
  `drift`, `secure`, `destroy` and the move to another Cloudflare account know a server at home.
  See [Host your app at home](docs/guide/home-hosting.md).
- **Restore drills.** `npx opscrew restore --drill` restores the latest snapshot (or the one you
  name, `--only <service>` for one service) into a throwaway copy beside the app, with no internet,
  no route in and none of your production values, checks that the app starts on it and passes its
  health check, and removes it. It never touches the app's own data. You approve it by typing
  `<app>-drill`. It works on servers OpsCrew created, your own server (at home too), your computer,
  your Portainer (in a second stack) and a hosting account with a panel (in the account's drill
  database, where the dump is loaded and counted). `--keep` keeps the copy to look at, `--remove`
  removes it, `--allow-other-version` starts today's image when the snapshot's is gone. See
  [Restore drills](docs/guide/snapshots.md#restore-drills).
- **Scheduled restore drills.** `npx opscrew snapshot drill schedule on` (weekly, or `--every
  daily`), and the next `npx opscrew provision` installs them with the plan you approve by its hash
  and `<app>-drill` typed: one crontab line on a server, one small dump check per database in a
  Portainer's stack, OpsCrew's agent on a hosting account. Each keeps its bounds on the target: its
  own names, the latest snapshot only, no internet, 30 minutes at most. `npx opscrew status` shows
  the last drill, and the [scheduled check](docs/guide/alerts.md) opens an issue when a drill failed
  or none ran. See [On a schedule](docs/guide/snapshots.md#on-a-schedule).
- **A database check in `advise`.** On a server OpsCrew created or your own, `npx opscrew advise`
  reads each PostgreSQL database read-only, each question under a strict time limit: sessions
  waiting for a lock, transactions left open, long queries, connections near the limit, slow
  statements (with `pg_stat_statements`), the database's size against its disk, and tables that
  look like they miss an index. It creates no login and changes nothing; an index is only ever a
  proposal. See [The database check](docs/guide/advise.md#the-database-check).
- **A second app on another app's server.** Run a second app, from another repository or as a
  further app of the same one, on the server OpsCrew created for your first app: no second server
  to pay for.
  - **Setting it up:** in the second app's `npx opscrew interview`, choose **A server another of
    your OpsCrew apps runs on** and name the first app's repository folder on this computer. There
    is no budget to give for it.
  - **A server of yours works too**, when the first app is served at its public address: the
    second app takes the server's login from the first app on this computer, and design warns
    that both apps run as the same `deploy` user. A Cloudflare Tunnel or a server at home is
    refused there: answer the server questions with the server's own login instead.
  - **Moving an app onto it:** `npx opscrew retarget --to own --answers <file>`, with
    `server.shares` in the file, moves a live app and its data onto another app's server, from a
    server of its own, your Portainer or another app's server, with the checks design runs and a
    plan you approve by its hash at each step. The other app keeps serving throughout. See
    [Moving onto another app's server](docs/guide/retarget.md#moving-onto-another-apps-server).
  - **What design checks:** the app must fit in memory beside the others. Its name and hostnames
    must be its own. It must be served the way the first app is, behind Cloudflare's proxy or with
    DNS only, and through the same proxy. Design also says plainly that both apps run as the same
    `deploy` user, who can become root through Docker.
  - **What provision changes:** the second app's Cloudflare rules, its DNS records pointing at the
    server, and on the server only its own deploy key line, folders and record, each as a plan you
    approve by its hash. It checks the memory again first, so a limit raised by hand in
    `opscrew/plan.yaml` that no longer fits beside the other apps is refused before any change.
  - **What the second app can then do:** deploy, `verify`, `drift`, take snapshots of its own data,
    rotate its deploy key, `destroy` (which removes only its own parts) and `retarget` to another
    server.

  See [A second app on another app's server](docs/guide/shared-server.md).
- **The first app's commands protect the apps beside it.** On a server OpsCrew created, these
  commands now look at the server first, read-only, and refuse while another app runs there:
  - `destroy` and `retarget`;
  - a `provision` that would replace the server, switch between Cloudflare's proxy and DNS only,
    or create a private network;
  - `restore --server`, `secure --close-public-ssh` and `vpn add`;
  - turning on Beszel or Portainer.

  A resize must still hold every app. When the server can't be reached, they stop and say why.
  `--skip-other-apps-check` goes on in that case, or when only another app's kept data is there,
  but never past an app that runs there. The MCP tools `opscrew_plan`, `opscrew_apply`,
  `opscrew_addon_enable` and `opscrew_portainer_enable` take it as `skipOtherAppsCheck`.
- **A Laravel queue on a hosting account.** A Laravel app whose jobs go through Laravel's database
  queue now deploys to a hosting account with a panel: its `php artisan queue:work` runs from cron
  every minute until the queue is empty (`--stop-when-empty --max-time=50`, unless the command sets
  its own), beside the scheduler's line, so a queued job starts within about a minute. A queue
  OpsCrew would run itself, such as Redis or RabbitMQ, is still refused there. See
  [What fits](docs/guide/hosting-accounts.md#what-fits).
- **PostgreSQL on a cPanel account** whose host installed it: OpsCrew makes the app's database and
  user through the hosting plan you approve by its hash, gives the app its `postgresql://` values,
  and snapshots, restores and drills it with `pg_dump` and `psql`, as it does a MySQL database.
  Provision stops before making anything when the account's shell lacks either tool. Not tested
  on a real account yet: tell us how it goes on yours. See
  [cPanel](docs/guide/cpanel.md).
- **A new server whose first boot failed is repaired.** A server OpsCrew just created can come up
  without its network at its first boot, and its setup then never runs: no Docker, no firewall.
  `provision`, and `retarget` to a new server, now name the steps that failed, as the server
  recorded them, and offer a repair through your provider, at most once each per run:
  - **A server that never opens SSH** is restarted, after you type the app's name.
  - **A server whose setup failed** is installed again from the same image with the same
    first-boot setup, keeping its addresses. It is offered only while the server shows no app (no
    app folder, no running container), and approved by its own hash with the app's name typed:
    `--approve <hash> --confirm <app>` in a script. OpsCrew then trusts the server's new SSH host
    key itself and goes on.

  See [`opscrew provision` stops half-way](docs/guide/when-a-deploy-fails.md#opscrew-provision-stops-half-way).
- **`opscrew/plan.yaml` records every cost, with its times.**
  - **Each item** of the plan's cost says which provider bills it and how: by the hour up to a
    monthly cap, by the month, or free. It also gives the hourly price, and from when the item
    bills.
  - **Past costs:** what ended this month or last stays listed, with when it ended. One-time fees,
    such as Contabo's setup fee or a domain OpsCrew bought for you, are listed with when they were
    charged.
  - **During a move,** the old server's costs are listed beside the new one's until
    `opscrew retarget --finish`.
  - **A domain OpsCrew bought** also has its yearly renewal. From 30 days before it,
    `npx opscrew status` checks the registrar and records the renewal once it happened. It warns
    when auto-renew is off.
  - **Older plans** get their times at the next `npx opscrew provision`.

  See [Domains](docs/guide/domains.md).
- **`npx opscrew providers --json` prints the providers' facts as a catalogue, for tools.** It
  covers every provider OpsCrew works with: the cloud server providers, Cloudflare and the
  registrars. For each it gives:
  - its sign-up and console pages;
  - the tokens it needs and the steps to create them;
  - for a server provider, its sizes with their list prices, setup fees and locations.

  It also gives what design would pick for a small app. It reads no network, no credential and no
  project, and comes with a JSON Schema in `@opscrew/plan-schema`. Without `--json` it lists the
  providers.
- **The secrets recovery copy in a script, to your own key.** `npx opscrew provision --recipient
  <age1…>` encrypts the first recovery copy of the app's secrets to an age public key you already
  hold, so a setup applied from a script or GitHub Actions keeps a copy only you can open. No key
  is written anywhere. Give it twice for a backup key, or with `--key-out` for a new key and yours.
  See [The first time](docs/guide/secrets-recovery.md).
- **Your Dockerfile's build can use the workflow's GitHub token.** A build that calls GitHub's
  API, for example to check a module's commit, shares GitHub's limit for calls without a login (60
  an hour per address) with every job on GitHub's runners, and can fail on it. Set
  `app.build.githubToken: true` in `opscrew/plan.yaml` and run `npx opscrew provision`: the build
  from your own Dockerfile then gets the token as the secret mount `GITHUB_TOKEN`
  (`RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN …`), never in the image. The job can
  also push to your repository's packages with it, so mount it only where the API is called. See
  [Your own Dockerfile](docs/guide/builders.md).
- **The Claude Code plugin's deploy skill and the MCP server** know a server at home and restore
  drills.

### Changed

- **A move's maintenance window is much shorter.** `opscrew retarget` copies the app's data to
  the new side while the app still serves, then starts and checks the app there on that copy, all
  before the window. Its databases are copied there by a consistent dump.
  - **The window itself:**
    - the app stops;
    - only the files that changed since are copied, each copy checked by its digest as before;
    - the release command runs once more, and the app starts again in place;
    - then DNS switches.

    No GitHub Actions run happens inside the window.
  - **Example:** an app with 262 MB of files and a 219 MB MySQL database is offline about 5
    minutes, after about 12 minutes of copying while it serves.
  - **Still in the window:** a PostgreSQL database is dumped and restored there again, and a
    MySQL or MariaDB database's folder is copied about whole, so a large database still lengthens
    the window.

  See [The maintenance window](docs/guide/retarget.md#the-maintenance-window).
- **The interview asks the monthly budget last**, once it knows where the app runs, and not at all
  for a server shared with another app.
- **The pull requests OpsCrew opens say what OpsCrew checked.** Their review list has two parts:
  "Checked by OpsCrew", ticked, for what the run checked itself (its secret rules found no secret
  value in the files the pull request changes; every action the workflow uses is pinned to a
  commit SHA), and "For you to check", for what only you can judge. A finding moves its item to
  your list, named, never with its value. The line "The workflow only uses pinned, first-party
  actions" is gone: the workflow's actions that aren't GitHub's own are named for you instead.

### Fixed

- **A move no longer starts the app on the new server before its data is there.**
  - **What went wrong:** `opscrew retarget` to a server deployed the app there before the
    maintenance window copied its data. A release command or a health check that needs the app's
    existing schema failed on the empty database, and the move stopped. Some PHP frameworks'
    `migrate`, for one, needs a settings table to exist.
  - **Now:** until the copy, the new server gets only the image and the app's services, and a
    rollback there is refused. In the window, once the data is copied, the deploy runs again with
    the same image (no build): the release command runs on the copied data, then the app starts,
    and OpsCrew checks it on the server before DNS switches. The window is a few minutes longer for
    it, and a deploy run that waits for a required reviewer says so.
  - **Also:** a dispatch of the deploy workflow with an image's digest now deploys that image
    without a build.
- **A server type the provider has none of is refused before anything changes.** `opscrew
  provision` refuses a type the provider can't place in the server's location right now, such as an
  out-of-stock type at Hetzner Cloud, which switches a server off before it changes its type. Pick
  another type, or try again later.
- **A failed type change no longer leaves the server off.** When a server's type change fails at a
  provider that switched it off first (Hetzner Cloud), provision starts the server again and says
  so. A server it can't start is named as off, with where to start it.
- **A Laravel or Rails app's migrations run on each deploy.** A Laravel app with Vite, which Railpack
  builds as PHP, or a Rails app that Buildpacks build as Ruby, no longer loses its release command
  (`php artisan migrate --force`, `bin/rails db:migrate`) to a warning that its image lacks PHP or
  Ruby. When the builder builds the migration tool's own language, the command and the app's
  migrations stay.
- **A move keeps the provider's backups as you had them.** `opscrew retarget` to another cloud
  provider turned the automated backups on there again, although you had turned them off on the
  old server, and its first plan then failed the backups policy for the old server. The move keeps
  your choice, and checks the old server against it.
- **A move keeps a plain PHP app's web root.** `opscrew retarget` rewrote the plan's image build
  for the new side without `app.build.webRoot`, so the image built there served the whole app
  instead of its `public/` folder, and failed its health check. The working directory of your own
  Dockerfile's image (`app.build.workdir`) was dropped the same way.
- **The release command runs on apps built by Railpack or Buildpacks.** On a server, or in your
  Portainer, `app.releaseCommand` (your migrations, for example) never ran when Railpack or
  Buildpacks built the image, and the deploy still said it finished: the image's own shell ran an
  empty shell instead. It now runs the way each builder's image expects, as workers and cron
  already did, and its output is in `release.log` on the server. Run `npx opscrew provision`
  once to rewrite the compose file, then deploy, so the migrations you missed run.
- **A variable you added to `app.env` by hand stays.** `npx opscrew design` rebuilt the plan's
  variables from what it found in the code, so one you added because detection misses it (a
  setting the code reads with a default) disappeared without a word, and the next deploy never
  passed its value. Design now keeps every variable you provide (`source: user`) and names the ones
  it can't find in the code, so you can remove them when the app no longer reads them. See
  [A variable OpsCrew does not find](docs/guide/builders.md#a-variable-opscrew-does-not-find).
- **A Laravel app built by Railpack reads your server's settings in every container.**
  - **What went wrong:** Railpack's build saves Laravel's settings into the image with their
    defaults (SQLite, `APP_ENV=production`), and only the web container cleared them at its start.
    So the release command migrated SQLite instead of your database, and the first deploy of an app
    on PostgreSQL or MySQL failed. Workers and cron jobs ran with every setting at its default.
  - **Now:** the image keeps none of those saved settings, so the release, the workers and cron read
    the server's. With a release command, your migrations run once per deploy in the release step,
    no longer again each time the web starts.

  Run `npx opscrew provision` once to get the new deploy workflow.
- **A Filament app built by Railpack has Filament's scripts, styles and fonts.** Filament publishes
  them into `public/` from a Composer script, which Railpack's build doesn't run, and an app's
  `.gitignore` keeps them out of the repository. So the admin pages rendered without them: menus
  that wouldn't open, a sign-in button without its label. The build now publishes them when the
  app's `composer.lock` has Filament. Run `npx opscrew provision` once to get the new workflow.
- **A Laravel app's Horizon worker gets the memory it needs.** Design gave every worker 256 MB, but
  Horizon runs several PHP processes (a master, a supervisor per entry of `config/horizon.php`, and
  their workers), so it was killed for lack of memory within seconds and every deploy failed its
  worker check. A worker running `php artisan horizon` now gets 768 MB by default, and design says
  why. A limit you set in `opscrew/plan.yaml` stays.
- **Migration records and down migrations run on apps built by Railpack or Buildpacks.**
  - **What went wrong:** the image's own entrypoint already runs commands through a shell, so the
    status of the app's migrations never ran there. Each deploy warned that it could not record
    them, and a rollback couldn't migrate the database down.
  - **Now:** both run the way the image expects. After a rollback's down migrations, OpsCrew reads
    the status again. The rollback's database step fails, instead of being reported as done, when
    the down migration changed nothing, when its result can't be read, or when it stopped short of
    the earlier version's migrations (which would start that version on another schema). This
    applies on every builder.
- **A PHP app built by Railpack gets the extensions its Composer packages need.** Railpack installs
  only the extensions the app's own `composer.json` asks for, so a package that needs another one
  (`pcntl` for a queue dashboard, `sockets` for a test tool) stopped `composer install` in the image
  build. Design now reads `composer.lock` too, records the list in `app.build.phpExtensions` and
  says which package needs each one. The deploy workflow reads `composer.lock` again at every
  build, so a package you add later gets its extensions without another provision. Run
  `npx opscrew provision` once to get the new workflow.
- **The plan records the PHP version Railpack builds.** For a PHP app whose `composer.json` asks
  for `^8.3`, `opscrew/plan.yaml` and `npx opscrew status` said PHP 8.4, while Railpack builds the
  newest 8.3. Design now records 8.3; run `npx opscrew design` once to correct an existing plan.
- **An infrastructure plan with no changes** shown with `--plan-only` can now be approved by its
  hash in a script: `--approve <hash>` no longer says "No saved plan has the hash".
- **The old-image cleanup no longer turns a successful deploy red.** A deletion GitHub answers with
  a passing error (429 or 5xx) is tried twice more. An image still left, or a deletion the network
  cut off, is now a warning: the next deploy deletes it. A cleanup that can't list the images still
  fails, since it stays broken until someone looks.
- **A short GitHub outage no longer stops a command** while it reads from GitHub: a read GitHub
  answers with a server error (500, 502, 503, 504) is tried twice more, a few seconds apart. Writes
  are never sent twice.
- **A Cloudflare token without R2 is named as one.** Cloudflare's R2 API answers a valid token that
  lacks R2 with an authentication error, so the move to another Cloudflare account stopped as if
  the new account's token were refused. It now names the missing permission, Account → Workers R2
  Storage → Edit.
- **MongoDB as a one-node replica set in your Portainer** (`options.replicaSet: true`) starts
  again: since credential rotation came in, its setup read the root password from a file that a
  Portainer stack doesn't have, so the replica set never started and the deploy failed. It now
  falls back to the stack's variable.

### Security

- **The Cloudflare-only filter comes back after nftables restarts.** On a server whose iptables
  runs on nftables (Ubuntu 24.04's default), `systemctl restart nftables` or `reload` emptied
  OpsCrew's filter and Docker's own rules, and they stayed empty until Docker restarted. Now the
  filter is put back and Docker restarts with nftables. ufw's own rules still
  need `sudo ufw reload` after one (see
  [a server you already have](docs/guide/own-server.md)).
- **A server's address stays out of the audit log when its SSH host key changed.** The question
  whether to trust the new key named the server's address in its title, which OpsCrew keeps in
  `.opscrew/approvals.jsonl` and the audit log. The address is now shown with the question only.

## [0.2.10] - 2026-11-18

Nothing to redo. At your next `npx opscrew provision`, the Cloudflare plan of every app in a zone
shows a new rule, "OpsCrew: redirect plain HTTP to HTTPS", once a site in the zone is on
Cloudflare's hosting, so its hash changes; approve it as usual. A site on Cloudflare's hosting now
needs the token permission Zone → Single Redirect → Edit.

### Added

- **Moving an app to another Cloudflare account.** `npx opscrew cloudflare move --to <account>`
  prepares the app's whole Cloudflare setup in an account you own: the zone and its records,
  OpsCrew's rules, Tunnels, Access, Workers and the R2 buckets, which are copied. `--switch` then
  moves the domain over (at Cloudflare Registrar, you start and accept the move in the two
  dashboards), and `--finish` moves each app onto the new account and removes its pieces from the
  old one, each removal after an approval and the app's name typed. `--abort` undoes a prepare
  before the switch. Several OpsCrew apps in one zone move together, each from its own repository,
  and deploys keep working throughout. The move also lists what it doesn't move, such as Email
  Routing, so you can set it up in the new account. See
  [Moving your app to another Cloudflare account](docs/guide/cloudflare-move.md).
- **OpsCrew in other AI apps.** `npx opscrew mcp install` adds OpsCrew's MCP server to Claude Code,
  Claude Desktop, Codex, Cursor and VS Code in one command, and `npx opscrew mcp uninstall` removes
  it. It writes no token. See [OpsCrew in other AI apps](docs/guide/mcp-clients.md).
- **Ignore rules for the scan.** `opscrew/scan.yaml` lists paths (and, optionally, rules) the scan
  leaves out, each with a reason, and the report counts what was left out. Test code, mocks and
  fixtures are left out by default. A recognisable secret keeps its severity anywhere. See
  [What the scan leaves out](docs/guide/security.md#what-the-scan-leaves-out).

### Changed

- **Plain HTTP to HTTPS on Cloudflare's hosting.** A site on Cloudflare Workers now redirects
  `http://` to `https://` with a 301 before the Worker runs, through one rule OpsCrew keeps in the
  zone for all its sites. See [Plain HTTP](docs/guide/cloudflare-hosting.md#plain-http).
- **A shorter wait before a nameserver switch.** Before `domain connect` or the move switches
  nameservers after DNSSEC was turned off, OpsCrew asks the registry itself: how long resolvers may
  keep the old DS record (for `.dev`, about 2 hours rather than a day), and, from its public
  record, when the record was removed, so a record removed long before doesn't hold the switch.
- **Each app's recovery copy follows its own rule** in `opscrew/.sops.yaml` when a repository has
  several apps, so a further app's copy can be sealed to keys of its own. See
  [Each app's copy](docs/guide/secrets-recovery.md#each-apps-copy).

### Fixed

- **The `www` redirect** of a site on Cloudflare's hosting no longer loops on plain HTTP.
- **The scan's client-exposed-secret check** skips test code and test fixtures, like the other
  configuration checks.
- **On Windows, a project opened as `d:\…` in one terminal and `D:\…` in another** no longer stops
  with "Backend configuration changed".

### Security

- **A saved plan no longer holds an Access service token's client ID.** The plans OpsCrew keeps in
  `.opscrew/plans` while they wait for an approval mask it, as they already masked the client
  secret. It is half of the credential your deploy workflow reaches your server or Portainer with
  through Cloudflare Access.

## [0.2.9] - 2026-11-15

Nothing to redo.

### Added

- **A build argument of your own.** A variable in `opscrew/plan.yaml` marked `buildArg: true`
  reaches your image's build whatever its name, the way the browser-prefixed variables do: as a
  Dockerfile `--build-arg` (in the deploy workflow, for your Portainer and on your computer), and to
  Buildpacks and Railpack builds. It never goes into the running app's settings, and it can't be a
  secret or a value OpsCrew generates. See
  [How OpsCrew builds your app's image](docs/guide/builders.md#a-build-argument-of-your-own).
- **Vite's `loadEnv`.** Settings a Vite app reads through `loadEnv` in `vite.config.*`, or in the
  files it imports, are detected as public build-time values.

### Fixed

- **A further app reads only its own folder.** `npx opscrew analyze --app <key>` (and interview's
  and design's own reading) take an app added with `opscrew app add` from its folder, its workspace
  packages and `app.sharedPaths`: no longer the repository root's `.env.example`, nor another app's
  database or frameworks, which could make design refuse a target. The first app reads the
  repository root as before. See [Several apps in one repository](docs/guide/several-apps.md).

### Changed

- **The whole repository is Apache-2.0.** The `ee/` folder, reserved for features that won't be
  built here, is gone. Anything primarily useful to an individual developer stays free.

## [0.2.8] - 2026-11-14

Nothing to redo. Two defaults change at your next `npx opscrew design` and `npx opscrew provision`:
prod takes a snapshot of the app's data before each release too, and the cloud provider's
automated backups are on by default only in prod. A staging or dev plan that already has
`target.backups: true` keeps it until you change it.

### Added

- **Shared hosting accounts.** OpsCrew deploys static sites and PHP apps (plain PHP and Laravel,
  with MySQL or MariaDB) to a hosting account you already pay for: one with cPanel, Plesk or
  DirectAdmin, or a host you reach only over SFTP. See
  [Deploy to a hosting account](docs/guide/hosting-accounts.md).
  - Nothing on the account changes until you approve the plan by its hash, and OpsCrew only ever
    changes or removes what it made there.
  - On a panel, a small agent on the account pulls each release, switches to it in one step, keeps
    the releases before it and checks the app after every switch. No credential for the account
    goes to GitHub. On an SFTP-only host, GitHub Actions uploads the release and switches to it
    over SFTP.
  - Node.js and Python apps run through CloudLinux's selector on a panel that has it.
  - `opscrew rollback`, `destroy`, `status`, `logs`, `verify`, `secure`, `drift` and `snapshot`
    work there too.
  - Each panel has its page: [cPanel](docs/guide/cpanel.md), [Plesk](docs/guide/plesk.md),
    [DirectAdmin](docs/guide/directadmin.md) and [SFTP](docs/guide/sftp.md).
- **OpenLiteSpeed** as a third reverse proxy on a server, beside Caddy and nginx: certbot's
  certificates, your own rules in `opscrew/proxy/additions.openlitespeed`, and the app's page cache
  emptied at each deploy. See [The reverse proxy](docs/guide/reverse-proxy.md).
- **Contabo's Object Storage** for your app's bucket on Contabo, when it stores up to 250 GB.
  OpsCrew orders it only after you approve its own plan, reuses one you already have in the region,
  and never cancels it. See [Object storage](docs/guide/object-storage.md).
- **Contabo's Auto Backup** as the provider's backups on Contabo, turned on through Contabo's API
  once you approve the plan. Contabo publishes no price per plan for it, so OpsCrew says it is
  priced on Contabo's order page and never counts it in a total. You turn it off and restore a
  backup in Contabo's Customer Control Panel. See [Deploy to Contabo](docs/guide/contabo.md#auto-backup).
- **Snapshots' copies on storage you already have.** `opscrew snapshot offsite on --to s3` sends
  the encrypted copies to your own S3-compatible bucket (Wasabi, Backblaze B2, MinIO, AWS S3,
  Contabo and others), and `--to sftp` to a machine of yours over SFTP, its host key confirmed
  once. OpsCrew never creates or deletes that bucket or folder: it deletes only the app's copies
  older than `--days`, and before the first copy it checks that the server can write there. See
  [Snapshots and restores](docs/guide/snapshots.md#an-encrypted-copy-off-the-server).
- **The app's queues in a rollback.** A rollback that restores the snapshot names each queue
  (RabbitMQ, NATS, Kafka, Redpanda, and a Valkey, Redis or Dragonfly that holds background jobs)
  and what happens to its jobs; `--keep-queues` keeps them as they are. See
  [Rollback](docs/guide/rollback.md#the-apps-queues).
- **Guide pages** [Deploy to Hetzner Cloud](docs/guide/hetzner.md) and
  [Deploy to DigitalOcean](docs/guide/digitalocean.md).
- **The Claude Code plugin** covers hosting accounts in its deploy skill and tools, and the
  snapshots' copies to your own bucket or SFTP machine in its snapshots skill.

### Changed

- **The snapshot before each release is on in prod too**, in every environment but previews, and
  it copies ClickHouse and Neo4j by default, each stopped for a moment. `deploy.snapshots` and
  `deploy.snapshotStop` in a plan still decide. See [Snapshots and restores](docs/guide/snapshots.md).
- **The provider's automated backups are on by default only in prod,** when the interview says
  the data matters; dev and staging rely on OpsCrew's own snapshots. `target.backups` in a plan
  still decides, and `opscrew advise` proposes backups only for prod.

### Fixed

- The check of your proxy additions downloads the proxy's image first, and says so, so a slow
  download is no longer reported as a refusal of your rules.
- The MCP server's promote tool says what a rollback does with the database and the queues.
- In your Portainer, the off-server copies on DigitalOcean Spaces older than `--days` are deleted,
  as the guide says and as on a server.

## [0.2.7] - 2026-11-12

Nothing to redo: projects on Hetzner Cloud and DigitalOcean keep their files as they are. A PHP
app that Railpack builds gets `intl` and `zip` at its next `npx opscrew provision` and deploy.

### Added

- **Contabo.** OpsCrew deploys your app to a Contabo Cloud VPS on your own account, as it does on
  Hetzner Cloud and DigitalOcean: the same hardened server, deploys, checks and rollback. See
  [Deploy to Contabo](docs/guide/contabo.md).
  - Contabo's four API credentials (`CNTB_OAUTH2_CLIENT_ID`, `CNTB_OAUTH2_CLIENT_SECRET`,
    `CNTB_OAUTH2_USER`, `CNTB_OAUTH2_PASS`) stay on your computer. When only they are set, the
    interview chooses Contabo without asking.
  - `opscrew design` prices Cloud VPS 4 to 12 from Contabo's price list and shows its date, the
    monthly price before VAT, Cloud VPS 4's one-time €2.00 setup fee and the one-month minimum term.
  - `opscrew provision` makes the server with Ubuntu 24.04, its SSH key and a Contabo firewall with
    the same rules as elsewhere, after you approve the plan by its hash. A create that stopped
    halfway is found and taken over by the next provision, never bought twice.
  - `opscrew destroy` says that Contabo cancels the server at the end of its term and bills it
    until then, shuts it down at once, removes its DNS records, firewall and SSH key, and shows and
    records the day its contract ends.
  - Whole-server snapshots are included in the server's price, up to the plan's limit;
    `opscrew restore --server` puts the server back to one.
  - `opscrew retarget --to contabo` moves an app there, and `opscrew rotate contabo` replaces its
    credentials. A new size is refused with the two ways to get one.
- **`opscrew advise` compares providers on the same basis:** the same data protection on both
  sides, prices before VAT, and a move proposed only when it pays any setup fee back within three
  months.
- **The chosen option's terms in a script:** `opscrew design` prints the setup fee, the minimum
  term and the included snapshots of the option it chose, not only in its chooser.
- **The Claude Code plugin** covers Contabo in its skills and tools.

### Changed

- **Whole-server snapshots keep the app's last saves.** `opscrew snapshot --server` first writes
  what the server holds in memory to its disk, so a snapshot taken while the server runs holds the
  data the app saved, on every provider.
- **PHP images:** every PHP image Railpack builds has the `intl` and `zip` extensions, which many
  apps use when present without requiring them.

### Fixed

- A provision whose run stopped after its apply (for example when setting a firewall failed) is
  recorded by the next `npx opscrew provision`, so `drift` and the other commands see the
  deployment again.
- A second `opscrew analyze` no longer reads OpsCrew's own files in the repository.

### Security

- Contabo's API password, and any variable whose name ends in `_PASS`, is a secret: OpsCrew masks
  it everywhere, and the agent that edits your code never gets Contabo's credentials.
- A provider's cached login is deleted before and after every OpenTofu or Terraform command:
  Contabo's provider keeps one in `~/.cache/contabo/terraform/token`.

## [0.2.6] - 2026-11-09

Every deploy workflow changes, a site's too. Run `npx opscrew provision` for each environment
and merge its pull request. Your plans keep working as they are.

- At its next deploy, each MySQL, MariaDB, Valkey, Redis, Dragonfly, Kafka, Redpanda, OpenSearch
  and Elasticsearch service starts once again with a new start command, for a few seconds, its
  data kept.
- An app on your Portainer, on Cloudflare's hosting or on GitHub Pages whose `APP_KEY` or
  `BETTER_AUTH_SECRET` OpsCrew generates gets `APP_PREVIOUS_KEYS` or `BETTER_AUTH_SECRETS` named
  in its stack template or deploy workflow at its next provision. It stays empty until a rotation
  keeps an old key there.

### Added

- **Rotate your app's credentials: `opscrew rotate`.** It replaces a password, key or token
  everywhere OpsCrew put it, in the right order and without breaking the running app, and never
  shows the old or the new value.
  - `npx opscrew rotate` lists every credential OpsCrew made for the environment, how it rotates
    and when it was made or last rotated, then your own tokens with their expiry.
  - Each rotation is a plan you approve by its hash. Services and the app's own secrets rotate
    together (`npx opscrew rotate db cache app`); everything else rotates alone. After a leak,
    `--all` rotates every service and app secret in one plan.
  - Services rotate seamlessly where they take two passwords (MySQL, Valkey, Redis, Dragonfly,
    Garage's access key), with a short swap or a short restart otherwise, on a cloud server, your
    own server and this computer. In your Portainer, every service of the stack restarts once with
    its new value. The app's deploys pause until it ends.
  - Laravel's `APP_KEY` rotates without logging anyone out, and Better Auth's secret keeps what it
    encrypted readable: the old value stays as the previous one until `--drop-previous`. App
    secrets that log users out, Better Auth's included, ask you to type the app's name first.
  - The deploy, check and preview keys, the private network's keys, a device's key and its
    logins, Cloudflare's Access and Tunnel tokens, the state passphrase, the monitoring's,
    Portainer's and Beszel's passwords and the recovery key each have their own name.
  - Your own tokens (Hetzner, DigitalOcean, Cloudflare, GitHub and the others you gave OpsCrew):
    make the new one at the provider, then `npx opscrew rotate <name>` checks it and replaces
    every copy OpsCrew made.
  - A rotation that stops goes on when you run it again, or `--undo` puts the old values back.
    Each one is recorded, names and dates only, in `opscrew/credentials.yaml`.
  - A restore of a snapshot taken before a rotation, including a whole-server one, sets the
    current passwords again.

  See [Rotating your app's credentials](docs/guide/credential-rotation.md).
- **Old credentials:** `opscrew advise` lists every credential older than a year
  (`credentials.maxAgeDays` in the plan changes the age), and with `check.credentials: true` the
  [scheduled check](docs/guide/alerts.md) opens an issue for one.
- **Two computers:** provision stops before changing anything when this computer's generated
  values are older than the last rotation, and says to run `npx opscrew secrets restore` first.
- **Plain PHP apps.** A PHP app without a framework, as made for shared hosting (a `composer.json`
  and a `public/index.php`), is built and deployed like any other app: only `public/` is served,
  its PHP extensions come from `composer.json` and the services it uses, and a `cron.php` runs
  every minute. See [A plain PHP app](docs/guide/builders.md#a-plain-php-app).
- **The app's kept folder:** the folder an app writes its files to (a plain PHP app's `storage/`,
  Laravel's `storage/app`) is a volume that every deploy keeps, in every snapshot and moved by
  `opscrew retarget`. See [The app's kept folder](docs/guide/components.md#the-apps-kept-folder).
- **A PHP app's database settings one by one:** an app that reads `DB_HOST` gets the host, port,
  database, user and password of its PostgreSQL, MySQL or MariaDB by the names it reads. See
  [The split settings](docs/guide/databases.md#the-split-settings).
- **The Claude Code plugin** has a rotation skill and the read-only tool `opscrew_credentials`.

### Changed

- Laravel apps are read as they are built: Laravel Sail's development settings are never asked
  for, its `storage/app` is kept, and a health route declared with `Route::get` is found.
- Each pull request provision opens after the first names what it changes, in its title and its
  body. A run that only updates the plan's records opens none, and a run while OpsCrew's deploy
  pull request is open updates that one.

### Removed

- `opscrew secrets rotate`: run `npx opscrew rotate recovery-key` instead.

### Fixed

- Analyze no longer warns about a missing Dockerfile for a PHP app with a `package.json` for its
  assets.
- `opscrew scan` no longer reports words, constant names or product tokens as high-entropy
  secrets, and reports values in test files as information only. Its vulnerability check reads
  `composer.lock`.
- Self-hosted monitoring's log masking leaves `APP_URL` readable.
- Provision and the other infrastructure commands try again when the OpenTofu or Terraform
  registry doesn't answer.
- OpsCrew keeps following a GitHub Actions run for up to five minutes while GitHub answers with a
  server error, instead of failing.

## [0.2.5] - 2026-11-07

Every server deploy workflow changes. Run `npx opscrew provision` for each environment and merge
its pull request. Your plans keep working as they are.

### Added

- **Snapshots and restores: `opscrew snapshot` and `opscrew restore`.** A snapshot copies every
  service of an environment that keeps data, and the app's SQLite files, on a server OpsCrew
  created, your own server, your computer or your Portainer.
  - PostgreSQL, MySQL, MariaDB, MongoDB, Valkey, Redis and Dragonfly are copied while they run.
    The brokers, the search engines, Garage and the other services with data each stop alone for
    their copy, and only when you allow it (`--allow-downtime` in a script); `--skip <service>`
    leaves one out.
  - A snapshot stays where the data is, named by the UTC time it was taken.
    `opscrew snapshot list` shows them, newest first; `opscrew snapshot delete <id>` deletes one.
  - `opscrew restore <id>` puts the data back exactly and keeps the version that runs. The app's
    requests wait while it runs, the data as it is now is saved as a new snapshot first, and you
    approve it like a destroy, with the app's name typed. `--only <service>` restores one service.

  See [Snapshots and restores](docs/guide/snapshots.md).
- **Snapshots on a schedule:** `opscrew snapshot schedule on --every daily|weekly|<n>h --keep <n>`,
  put on the server or in your Portainer by the next provision. `opscrew status` and the
  [scheduled check](docs/guide/alerts.md) report a scheduled snapshot that failed.
- **An encrypted copy off the server:** `opscrew snapshot offsite on --to r2|hetzner|digitalocean`
  uploads each snapshot, encrypted with age to your recovery copy's key, to a bucket of its own,
  kept for `--days` (90 by default). The server never holds the key.
  `opscrew restore <id> --from offsite --key-file <file>` brings the data back after the server is
  lost. See [An encrypted copy off the server](docs/guide/snapshots.md#an-encrypted-copy-off-the-server).
- **Whole-server snapshots at Hetzner and DigitalOcean:** `opscrew snapshot --server`, live or
  with `--stop`, shows its price; `opscrew restore --server <id>` rebuilds the server in place,
  with its addresses and firewall kept. See
  [Whole-server snapshots](docs/guide/snapshots.md#whole-server-snapshots).
- **The snapshot before each release covers all the data:** every service with data, a database
  on another server, SQLite, and your Portainer. `deploy.snapshotStop` adds a service that must stop
  for its copy. `opscrew rollback --database snapshot` restores it in your Portainer too. See
  [Snapshots before each release](docs/guide/rollback.md#snapshots-before-each-release).
- **Design and advise propose snapshots** on your own server or Portainer when the data matters,
  with a copy off the server.
- **The Claude Code plugin** has a snapshots skill and the read-only tool `opscrew_snapshots`,
  and its status answer names the last snapshot.

### Changed

- An app's key and an environment's name can no longer be `backups` or start with `backups-`:
  the off-server copy's bucket uses those names.

### Fixed

- `opscrew drift` no longer reports a server's image as changed after the server was rebuilt.
- On your computer, a port another container publishes counts as taken, so OpsCrew uses 8080 and
  8443 instead of failing when the app starts.
- `opscrew destroy` with nothing deployed removes what a provision that stopped part-way left in
  OpsCrew's shared Cloudflare rules, instead of refusing with "Nothing is deployed".

## [0.2.4] - 2026-11-06

Every server deploy workflow changes. Run `npx opscrew provision` for each environment and merge
its pull request, and approve a preview environment's recipe again with
`npx opscrew provision --env preview`. Your plans keep working as they are.

### Added

- **Move your app anywhere: `opscrew retarget`** now moves a live app with its data between any
  two of Hetzner Cloud, DigitalOcean, a server you already have and a Portainer you already run,
  in any direction, and a site between Cloudflare's hosting and GitHub Pages.
  - Every service's data moves in a maintenance window: PostgreSQL through its dump, the others
    (MySQL, MariaDB, MongoDB, Valkey, Redis, Dragonfly, the brokers, the search engines, Garage,
    your app's own files, self-hosted monitoring) by copying their stopped volumes, checked by
    SHA-256 on both sides. `--empty <service>` starts one empty instead.
  - A bucket at Hetzner Object Storage or DigitalOcean Spaces moves with the app, its size, copy
    time and cost shown first; `--keep-bucket` keeps it where it is.
  - Apps on several servers and self-hosted monitoring move too, and a move to an Arm server
    builds the image for it.
  - Your own server and your Portainer are never removed: `--finish` removes only the app.
  - A copy that fails puts the old side back with its data unchanged.

  See [Moving your app somewhere else](docs/guide/retarget.md).
- **A rollback can undo the database too.** `opscrew rollback` asks how to treat it:
  - **restore the snapshot** OpsCrew took before the release you undo: on by default for every
    environment except prod, for PostgreSQL, MySQL, MariaDB and MongoDB on the app's server, the
    last 3 kept (`deploy.snapshots`, `deploy.keepSnapshots` in the plan);
  - **migrate it down** with your app's own tool: Rails (with several databases too), Django,
    Alembic, Flask-Migrate, Knex, Sequelize, TypeORM or Laravel;
  - **or keep it** as it is.

  `--database snapshot|migrations|keep` chooses in a script. A choice that changes data is
  approved like a destroy, with the environment's name typed (`--confirm`). The server changes
  data only with a one-time approval OpsCrew leaves there, so a hand-made "Run workflow" can't,
  and a restore that fails puts the database back. See [The database](docs/guide/rollback.md#the-database).
- **Previews on your dev or staging server, or below your app's domain**, each opt-in:
  `opscrew env add preview --previews --share-server dev` runs them on that environment's server
  instead of one of their own, and `--app-zone` lets their domain sit below your app's (with
  Cloudflare's Advanced Certificate Manager). See
  [Fewer servers or one domain](docs/guide/previews.md#fewer-servers-or-one-domain).
- **The Claude Code plugin** knows the moves and the rollback's database choice.

### Changed

- A deploy run you cancel during its start step goes back to the version that ran before, as a
  failed one does.
- When OpsCrew stores deploy secrets, it also deletes the ones it stored earlier that the deploy
  no longer reads (for example `OPSCREW_ORIGIN_TLS` once origin TLS is off), named in the same
  approval. Your app's own variables are never deleted.
- Alembic and Flask-Migrate projects whose migrations have several heads deploy with
  `alembic upgrade heads` (`flask db upgrade heads`), and analyze says why.

### Fixed

- Valkey and Redis 8 couldn't start again in the same container on Ubuntu servers, for example
  after a reboot: each start now removes the previous start's password file first.
- Following a deploy run no longer fails when GitHub answers "Not Found" for a moment right after
  the run starts.

## [0.2.3] - 2026-11-05

Nothing to redo for an app without previews: your plans keep working as they are.

### Added

- **Preview environments: a link for every pull request.**
  - `opscrew env add preview --previews --domain <zone>` sets them up once on a small server of
    their own (at Hetzner, at DigitalOcean, or a server you already have that runs nothing else),
    and `opscrew provision --env preview` creates it. From then on, every pull request from a
    branch of your repository that changes the app gets its own preview: built and started when it
    opens, updated on each push, removed with its data and images when it is closed or merged. A
    comment on the pull request gives its address, and "View deployment" opens it.
  - Previews live on a Cloudflare domain used only for them, at `pr-<number>-<random>.<domain>`,
    behind Cloudflare's proxy with one Cloudflare Origin CA certificate: no public certificate ever
    names a preview, so its address can't be guessed or read from certificate logs. The preview
    server accepts web traffic only from Cloudflare.
  - Each preview runs its own databases and services, empty, then your release command, then your
    seed command once (found for Prisma, Rails, Laravel, Knex, Sequelize, AdonisJS and a
    `db:seed` script; `--seed` or `--no-seed`). Its passwords are made on the preview server;
    your values for previews come from `.env.preview` (test keys only).
  - You approve the previews' setup once, by its hash, typing `<app>-preview` to accept that each
    preview's data is deleted without asking again. The preview server itself enforces what you
    approved: the only key GitHub gets can run one command there, which checks every request, so a
    pull request that edits its workflow still can't go further.
  - Forks, Dependabot and drafts get no preview. At most 3 run at once by default (`--cap`); one
    without a push for 7 days is removed (`--lifetime`).
  - `opscrew preview list`, `opscrew preview logs <n>` and `opscrew preview destroy <n>`;
    `opscrew destroy --env preview` removes the server, the record, the certificate and every
    preview.

  See [Previews: a link for every pull request](docs/guide/previews.md).
- **Names nobody can guess for your other environments.** `opscrew env add <env>` now suggests
  `<env>-<random>.<zone>` when your app is behind Cloudflare's proxy, and `--hostname <name>` puts
  an environment on any name, another domain included. See
  [dev, staging and prod](docs/guide/environments.md).
- **The Claude Code plugin** knows previews: the read-only `opscrew_preview_list` tool, and when to
  suggest them.

### Changed

- Once a repository has previews, every app's deploy secrets must sit where a pull request can't
  read them: `opscrew provision --env preview` refuses until they do and names the command that
  moves them. A GitHub environment that has no rule at all, such as the `production` one GitHub
  creates by itself at your first deploy, now gets OpsCrew's branch rule after your approval; one
  with rules of yours stays as it is.
- `opscrew provision --env preview` refuses a `.env.preview` that git would commit; add `.env.*`
  to your `.gitignore`.
- Every deploy workflow now always deletes its intermediate images, and pull requests' images older
  than 31 days, even with image retention off. Run `opscrew provision` to have it.

## [0.2.2] - 2026-11-05

Nothing to redo: your plans keep working as they are.

### Added

- **`opscrew advise`: is the app the right size, can it cost less, is anything about to break.**
  - It reads each server's figures, with 14 days of history when
    [self-hosted monitoring](docs/guide/monitoring.md) is on, your plan and the interview's budget,
    the providers' live prices, the repository's Dependabot alerts and pull requests, the scheduled
    check's issues, `opscrew secure`'s host checks, and when your GitHub and Cloudflare tokens
    expire. It only reads: nothing changes on any server, account or repository.
  - It lists what it would change, the most urgent first (now, soon, when convenient), each with its
    figures, the monthly price before and after, and how to apply it: a larger or cheaper server, a
    higher memory limit for a container, a fix for a filling disk, backups, the scheduled check, a
    restart loop or a flapping check, Dependabot alerts, a reboot or security updates waiting, a
    token about to expire, Postgres on a server of its own, object storage.
  - It never proposes a smaller server on one reading, or with fewer than 7 days of history.
  - `opscrew advise --apply <id>` writes one field of `opscrew/plan.yaml` (a server's type, a
    container's memory limit, backups or the scheduled check), and `opscrew provision` applies it
    once you approve its hash. For the other proposals it prints the command to run, or what to do
    by hand. `--json` prints the proposals as JSON.
  - To have the Dependabot alerts read, give your GitHub token "Dependabot alerts: Read"; without
    it, advise says so and gives the rest of its advice.

  See [Advice on size, cost and upkeep](docs/guide/advise.md).
- **The Claude Code plugin** gives Claude advise's proposals through the read-only `opscrew_advise`
  tool when you ask "is it the right size?" or "can it cost less?". Applying one stays in your
  terminal.
- **A guide page for `opscrew retarget`:**
  [Moving your app to another cloud provider](docs/guide/retarget.md).

### Fixed

- **`opscrew provision` refuses a server type with a smaller disk than the server has,** before
  changing anything, even in a plan edited by hand. Before, Hetzner Cloud refused such a change
  only after switching the server off, and left it off.

## [0.2.1] - 2026-11-04

Nothing to redo: your plans keep working as they are. The first deploy after your next
`npx opscrew provision` updates the shared edge on the server once, as its version is raised.

### Added

- **Self-hosted monitoring: Prometheus, Loki and Grafana on a server of your own.**
  - `opscrew addon enable monitoring` writes it into your plan, with the server's type and monthly
    price, the agent's memory on each of your servers, the retention and the disk it takes.
    `opscrew provision` then sets it up, each change approved by its hash.
  - By default the stack runs on a small server of its own at your app's provider and location.
    `--on app` puts it on the app's server (from 4 GB). Another app or environment in the
    repository sends to the same server; `--new-server` gives it one of its own.
  - Grafana Alloy on every server sends the server's and the containers' figures, Caddy's and
    Postgres's figures, and your app's log lines, with secrets masked before they leave the server.
  - Six ready-made dashboards: servers, containers, HTTP traffic, Caddy, Postgres and logs.
  - Nothing is reachable from the internet. `opscrew addon open monitoring` gives Grafana's private
    address when this computer is a device on the private network, or opens an SSH tunnel.
  - Figures are kept 15 days and logs 7 by default; `--metrics-days` and `--logs-days` change it.
    `opscrew addon status` and `opscrew status` show each server's last data.
  - `opscrew addon disable monitoring` removes everything it installed; the monitoring server is
    deleted only after you type its name.

  Grafana and Loki are licensed AGPL-3.0 and run unmodified as containers. See
  [Self-hosted monitoring](docs/guide/monitoring.md).
- **The Claude Code plugin** shows monitoring's status and turns it on or off; its
  troubleshooting skill says how to open the dashboards and what each shows.

### Changed

- **Caddy keeps figures per hostname in every OpsCrew edge,** on the edge's internal network only,
  never published. Nothing reads them unless monitoring is on; every app on a server now shares
  the same edge again.
- **Grafana Alloy 1.21.3.** A plan that names 1.21.2 for Grafana Cloud keeps running it, by its
  tag; `opscrew addon enable grafana-cloud` moves it to the pinned version.

### Fixed

- **A new secret now reaches the server:** a rotated Grafana Cloud or Beszel token through
  `opscrew addon enable`, and a device's new database password from `opscrew vpn grant` after this
  computer lost the old one. Before, the server's check saw its files unchanged and skipped writing
  the new value.
- **A changed Alloy or Beszel configuration restarts its container.** Before, the new file was
  written but the running container kept the old one.
- **`opscrew provision` no longer refuses a plan whose extra server keeps no backups** while the
  app's server does: each server is checked against its own setting.

## [0.2.0] - 2026-11-01

Every deploy workflow changes in this release. Run `npx opscrew provision` for each environment
and merge its pull request; until then, `opscrew rollback` says so and changes nothing. An app
with OpenSearch gets its login with that same provision.

### Added

- **`opscrew rollback`: back to the version that ran before, with one command.**
  - It deploys that version's image by its digest: nothing is rebuilt and no release command runs.
  - It uses a deploy's own switch and checks, so with rolling deploys your site keeps serving.
  - `--list` shows the versions you can go back to, and `--to <commit or digest>` picks one.
  - It asks for approval in a terminal; a script passes `--approve <hash>`. `--yes` never
    approves a rollback.
  - Your data, schema and secrets stay as they are now. The guide says what that means for
    migrations.

  It works on servers OpsCrew creates, your own server, your Portainer and this computer. On
  Cloudflare's hosting it activates an earlier Worker version, and on GitHub Pages it re-runs an
  earlier run. See [Rolling back a release](docs/guide/rollback.md).
- **Deploys pause after a rollback,** so the next push doesn't undo it unnoticed: a push still
  builds, but doesn't deploy. `opscrew rollback --resume` turns deploys back on, and `--deploy`
  also deploys the branch's latest commit now.
- **`opscrew status` shows which version runs,** the one before it, and whether deploys are
  paused. `opscrew_status` in the Claude Code plugin includes the same.
- **`opscrew logs --failed`** shows the last lines of a new version that failed its health check.
  The server keeps them after the failed copy is removed, and the failure messages point there.
- **Logins for Kafka, Redpanda and OpenSearch.**
  - OpenSearch runs its security plugin, and its address carries the login: an app that reads
    `OPENSEARCH_URL` needs no change.
  - Kafka and Redpanda ask for a login when you set `login: true` in the service's options in
    `opscrew/plan.yaml`. Your app gets `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`,
    `KAFKA_SASL_PASSWORD` and `KAFKA_SECURITY_PROTOCOL`, and its Kafka client sends them.
  - `opscrew design` turns the login on when your app's code already reads those variables.

  See [Message brokers](docs/guide/brokers.md) and
  [Search and analytics](docs/guide/search-and-analytics.md).
- **The Claude Code plugin** suggests `opscrew rollback` in the terminal when a recent release is
  the likely cause, after stating what it leaves as it is.

### Changed

- **`promote` and `rollback` accept images built by GitHub's "Run workflow"** on the deploy
  branch, as well as those built by a push.
- **Going back on Cloudflare's hosting and GitHub Pages** is `opscrew rollback`, which also pauses
  their deploys. The runbooks and the deploy failure messages name it.
- **A failed release command** now says the migration may have run partly, where its output is, and
  what to do next.

### Fixed

- After a worker or cron process failed following a switch, the failure message pointed to the
  lines of the version restarted in its place, not to the failed one's.

## [0.1.3] - 2026-10-31

### Added

- **A server of its own for a service.** Put a database, cache or broker on another server by
  adding it under `servers` in `opscrew/plan.yaml` and naming it in the service's `server`. It can
  be another Hetzner Cloud server, a DigitalOcean Droplet or a server you already have.
  - `opscrew design` sizes and prices each server, and estimates the delay each query then adds.
  - Your app's code doesn't change: only the address it is given does.
  - `status`, `logs`, `drift`, `secure`, `verify` and `destroy` cover every server.

  See [A server of its own for a service](docs/guide/split-placement.md).
- **Moving a running service to another server, with its data.** `opscrew provision` copies
  PostgreSQL's data in a short maintenance window it shows you first, and pauses deploys meanwhile.
  `opscrew provision --finish-move` then deletes the old copy, after you type the service's name.
  In a script, `--allow-downtime` approves the window. Valkey, Redis and Dragonfly start empty on
  the new server; other services that keep data can't move yet.
- **A private network between your app's servers** (WireGuard): databases and caches on another
  server listen only there.
- **Your own devices on that network** (see
  [Your devices on the private network](docs/guide/private-network.md)):
  - `opscrew vpn add <name>` writes a WireGuard configuration for a laptop, or for a phone with
    `--qr`.
  - `opscrew vpn list` shows each device and when it last connected; `opscrew vpn remove` takes one
    off.
  - `opscrew vpn grant <device> <service>` gives a device its own login to a database or cache,
    read-only unless `--full`; `opscrew vpn revoke` removes it. See
    [Your production database from your device](docs/guide/database-access.md).
- **SSH closed to the internet.** `opscrew secure --close-public-ssh` makes every server answer
  SSH only on the private network, and `--open-public-ssh` opens it again. If you lose this
  computer's tunnel, the guide says how to get back in. See
  [Close public SSH](docs/guide/public-ssh.md).
- **Removing a server in a script.** `opscrew provision --confirm <app>-<server> --yes` lifts the
  delete protection of a Hetzner server you took out of `servers`, then prints the command that
  deletes it.
- [When a deploy fails, and how to recover](docs/guide/when-a-deploy-fails.md): what your visitors
  get, what OpsCrew already put back and what to do next, for each kind of failure.
- **The Claude Code plugin** shows each server and the private network in `opscrew_status`.
  `opscrew_placement_estimate` prices a placement and estimates its delay before you change
  anything, and the deploy and troubleshoot skills know about several servers.

### Fixed

- A script that runs `opscrew provision --approve` again with every hash it was given, the
  infrastructure plan's and each host plan's, no longer fails with "Saved plan is stale" on servers
  OpsCrew creates: an infrastructure plan that was already applied is planned afresh.
- `opscrew drift` no longer reports a Hetzner firewall rule as changed outside OpsCrew after a
  provision changed the firewall. The next `opscrew provision` updates the firewall once.
- `opscrew design` no longer makes a server it already created smaller than its disk allows: neither
  Hetzner Cloud nor DigitalOcean can shrink a disk, so the change used to fail at the provider. It
  keeps the server's type, says why, and keeps the server in its location rather than proposing to
  replace it.
- `opscrew destroy` stops before changing anything while the server's own runner is running a job,
  which GitHub would refuse to delete, and says to wait for the job or cancel it.
- `opscrew promote` names the branch an environment really deploys from. Its hint for `--version`
  on a server environment now says how to go back to an earlier version.
- `opscrew secure`'s advice for a pending reboot no longer suggests `sudo` on servers OpsCrew
  created, where the deploy user has none.

## [0.1.2] - 2026-10-29

### Added

- `opscrew logs` shows your app's latest log lines wherever it runs: on a server, in your Portainer,
  on this computer, or a server-rendered site on Cloudflare. `--follow` keeps showing new lines
  until Ctrl+C, and `--service`, `--since` and `--tail` choose which lines. Secrets are masked
  before a line is shown. See [Your app's logs and resource figures](docs/guide/logs-and-status.md).
- `opscrew status` shows how the app is doing right now: the server's load, memory and disk, and
  each container's CPU, memory, restarts and uptime. It flags a container near its memory limit, a
  disk past 85% and a restart since the last deploy, with what to do. On Cloudflare it shows the
  Worker's requests, errors and CPU time of the last day.
- A scheduled check in GitHub Actions, on by default for prod, checks that your app answers, that
  its certificate is valid and that its server's disk has room. When something fails it opens a
  GitHub issue, and it can post to Slack, Discord or ntfy; when the app recovers it closes the issue
  and says how long the problem lasted. `design` shows its Actions minutes a month, and `destroy`
  and `retarget` pause it. See [Alerts: the scheduled check](docs/guide/alerts.md).
- Two add-ons for a server OpsCrew deploys to, each turned on with `opscrew addon enable` after a
  plan you approve, and removed with `opscrew addon disable`:
  - [Beszel](docs/guide/beszel.md): charts and history of the server and its containers.
    `opscrew addon open beszel` opens its dashboard through an SSH tunnel;
  - [Grafana Cloud](docs/guide/grafana-cloud.md): your app's log lines and the server's metrics,
    sent to your own free Grafana Cloud stack by Grafana Alloy, with the app's secrets masked
    before they leave the server.

  Both see Docker only through OpsCrew's read-only proxy.
- The Claude Code plugin reads the logs (`opscrew_logs`), shows the figures and open alerts in
  `opscrew_status`, and turns the add-ons on and off. Its new `/opscrew:opscrew-troubleshoot`
  skill finds out why your app is failing or slow. See
  [the plugin's guide](docs/guide/claude-code-plugin.md).

### Changed

- With the scheduled check on, the GitHub token needs Issues: Read and Variables: Read and write. For
  a server-rendered site's past requests in `opscrew logs`, the Cloudflare token needs Workers
  Observability: Read. See [Security](docs/guide/security.md).
- Hints that pointed to `docker compose logs` on the server now name `opscrew logs`.

### Fixed

- On Debian, Ubuntu and other Linux systems where `sh` is dash, `provision` of an environment on
  this computer could not log in to GitHub Container Registry to pull the app's image. Docker got no
  token, though the token was right.

## [0.1.1] - 2026-10-24

### Added

- Host a site on Cloudflare, with no server: static sites from Workers static assets, and
  server-rendered Astro, Next.js (through OpenNext), Nuxt and SvelteKit apps as a Worker. `adapt`
  adds the Cloudflare adapter when the app does not use it yet. See
  [Host your site on Cloudflare](docs/guide/cloudflare-hosting.md).
- Publish a static site on GitHub Pages, on your domain. See
  [Publish your site on GitHub Pages](docs/guide/github-pages.md).
- `provision`, `verify`, `status`, `drift`, `secure`, `promote` and `destroy` work for both, with
  environments, from the CLI, the MCP server and the Claude Code plugin.
- On Cloudflare, `promote --version` refuses to roll back to a version from before one of the app's
  secrets changed, and names the secrets. If their old values are still safe,
  `--allow-old-secrets <name>` rolls back anyway, after an approval that names them.
- `app add` takes a site that has no manifest, such as a Hugo site.

### Changed

- A push runs an app's deploy workflow only when something the app deploys changes: its folder,
  the paths in `app.sharedPaths`, the workflow itself and the OpsCrew files the deploy reads. See
  [When a push deploys your app](docs/guide/when-deploys-run.md).
- Running `design` again keeps the plan's own settings, such as the app's name, the workflow's path
  and the Worker's name. Where you changed a value `analyze` found (the port or the health path, for
  example), design keeps yours and says what analyze found.
- An app in a folder takes its environment variables from its own folder, the workspace packages
  it uses and the committed env files at the repository root.
- `provision` commits only OpsCrew's own files to its deploy-setup branch, and says how to get back
  to the branch you were on.
- The CLI no longer installs the Claude Agent SDK (about 300 MB). The first AI step asks before
  downloading it once (`--yes` agrees); commands without AI never need it.
- The Claude Code plugin installs OpsCrew from a pinned lockfile instead of running `npx`: about
  35 MB.

### Fixed

- The provider lock files (`.terraform.lock.hcl`) go into the deploy-setup pull request instead of
  staying uncommitted.
- A Cloudflare deploy retries for up to 2 minutes when Cloudflare cannot find the Worker version it
  has just uploaded yet.
- `provision` on Cloudflare raises the zone's minimum TLS version to 1.2 when every proxied hostname
  in the zone is OpsCrew's, as it does for apps on a server. Other OpsCrew apps' Worker domains now
  count as OpsCrew's.
- A rollback with `--allow-old-secrets` no longer fails on Cloudflare's short answer: OpsCrew reads
  the latest deployment back to confirm it.
- On Windows, OpsCrew can start npm, npx, pnpm and yarn, which failed with `EINVAL`.

## [0.1.0] - 2026-10-23

The first release. OpsCrew takes an app from its GitHub repository to a hardened production
deployment on your own account:

- `scan` checks a repository for leaked secrets, exposed Supabase and Firebase data and risky
  config, free and without AI.
- `init`, `analyze`, `interview`, `design`, `adapt`, `provision`, `verify` and `secure` take the app
  from its code to a live, checked deployment. Every infrastructure change waits for your approval
  of its exact plan.
- Targets: Hetzner Cloud, DigitalOcean, [a server you already have](docs/guide/own-server.md),
  [a Portainer you already run](docs/guide/portainer-target.md) and
  [your own computer](docs/guide/localhost.md), with OpenTofu or Terraform.
- [Environments](docs/guide/environments.md) such as dev, staging and prod, and
  [self-hosted runners](docs/guide/runners.md).
- [Several apps in one repository](docs/guide/several-apps.md), and several apps in one
  [Cloudflare zone](docs/guide/cloudflare.md).
- Domains: `domain buy` and `domain connect`, through Cloudflare, Porkbun, Namecheap or GoDaddy.
- [Components](docs/guide/components.md) next to the app: databases, object storage, message
  brokers, search engines, workers and cron jobs.
- `destroy`, `retarget`, `status` and `drift` after the first deploy.
- The MCP server (`opscrew mcp`) and the Claude Code plugin.

[0.2.12]: https://github.com/opscrew-hub/opscrew/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/opscrew-hub/opscrew/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/opscrew-hub/opscrew/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/opscrew-hub/opscrew/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/opscrew-hub/opscrew/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/opscrew-hub/opscrew/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/opscrew-hub/opscrew/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/opscrew-hub/opscrew/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/opscrew-hub/opscrew/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/opscrew-hub/opscrew/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/opscrew-hub/opscrew/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/opscrew-hub/opscrew/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/opscrew-hub/opscrew/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/opscrew-hub/opscrew/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/opscrew-hub/opscrew/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/opscrew-hub/opscrew/compare/0dfc0e91...v0.1.1
[0.1.0]: https://github.com/opscrew-hub/opscrew/tree/0dfc0e91
