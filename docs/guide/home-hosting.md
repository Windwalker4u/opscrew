# Host your app at home

OpsCrew can serve your app from a computer at your home, such as a Raspberry Pi or a mini PC, at
your home connection's own public address. Your router forwards the web ports to the computer, an
address updater on it keeps the domain's DNS records at your current address when your provider
changes it, and SSH stays closed to the internet. The computer is set up as
[a server you already have](own-server.md): everything on that page applies, and this page adds
what is different at home.

OpsCrew never changes your router. It tells you exactly what to set there and then checks from
outside your home that it works.

## At home, or through the tunnel

A computer at home can serve your site in two ways:

- **At your home's own address** (this page). Visitors reach the computer over your connection,
  through Cloudflare's proxy if you choose it, with no tunnel connector on the server and no
  Cloudflare Zero Trust. It needs forwards on your router, and a connection with a public IPv4
  address, or IPv6 behind Cloudflare's proxy.
- **Through a [Cloudflare Tunnel](own-server.md#the-cloudflare-tunnel).** The computer connects
  out to Cloudflare, and nothing on your router changes. It works on any connection, including one
  without a public IPv4 address or with blocked ports, and needs a domain on Cloudflare and Zero
  Trust (free).

Pick the tunnel when you can't or don't want to set forwards on your router, when your
connection has no public IPv4 address of its own, or when your provider blocks ports 80 and 443.

## What you need

- A computer at home that meets [a server you already have](own-server.md#what-you-need)'s needs:
  Ubuntu or Debian, amd64 or arm64 (a Raspberry Pi with the 64-bit OS).
- Access to your router's settings, for the forwards and a fixed address for the computer.
- A domain. With its DNS on Cloudflare, OpsCrew keeps the records at your address by itself; with
  its DNS elsewhere, only a fixed home address works (see [DNS outside Cloudflare](#dns-outside-cloudflare)).
- With DNS on Cloudflare, a second Cloudflare token for the address updater (see
  [The updater's token](#the-updaters-token)).
- This computer on your home network (or connected to it through a VPN) whenever OpsCrew works on
  the server: SSH answers only there.

## Step by step

1. `npx opscrew interview`: choose **A server you already have**, give the computer's address on
   your home network, and answer **yes** when OpsCrew asks whether the server is at your home (the
   default for a private address such as `192.168.1.30`). Then choose how it serves the site:
   - **behind Cloudflare's proxy** (recommended, and the default with a domain on Cloudflare):
     visitors never see your home's address;
   - **DNS only**: the DNS records show your home's address to anyone who looks it up, and
     everyone reaches the server directly (the only choice without a domain on Cloudflare);
   - **through a Cloudflare Tunnel** (see above).

   In scripts, put the answers in a file and pass `--answers <file>`:

   ```yaml
   provider: own
   server.host: 192.168.1.30
   server.user: ana
   server.key: agent
   server.home: yes
   server.serve: proxy      # proxy, dns-only or tunnel
   # server.sshFrom: 192.168.1.0/24 10.8.0.0/24
   ```

   `server.reachable` isn't asked for a server at home, and an answers file that gives it is
   refused: your router's forwards reach the server.
2. `npx opscrew design`: OpsCrew connects, you confirm the server's host key, and it reads the
   server and what the server sees of your network (read-only). It says:
   - that it found your home's public address. Behind Cloudflare's proxy it never shows it; with
     DNS only it prints it, since the records publish it anyway;
   - what to set on your router (see [Your router](#your-router));
   - when your connection looks like it has no public IPv4 address (see
     [No public IPv4 address](#no-public-ipv4-address-or-blocked-ports));
   - your provider's terms and, behind the proxy, the note on large media (see
     [Your provider's terms, and large media](#your-providers-terms-and-large-media));
   - with DNS on Cloudflare, how to make the updater's token and what it can reach;
   - on a Raspberry Pi with its data on an SD card, a warning (see [A Raspberry Pi](#a-raspberry-pi)).

   Design writes `target.home` into `opscrew/plan.yaml` and has deploys run on
   [the server's own runner](runners.md#the-servers-runner), unless the plan names a runner
   machine (see [SSH only from your home network](#ssh-only-from-your-home-network)).
3. Set your router as design said.
4. `npx opscrew adapt`, then merge its pull request.
5. With DNS on Cloudflare, set `OPSCREW_DNS_UPDATER_TOKEN`, then run `npx opscrew provision`. Its
   host plan shows, besides the usual steps, SSH limited to your home network, the address updater
   with its records and what its token can reach, and the deploy runner. Each plan is approved by
   its hash. The deploy-setup pull request also brings `.github/workflows/opscrew-outside-check.yml`
   and repeats the router settings, without your server's address.
6. Merge the deploy-setup pull request. The first deploy runs on the server.
7. `npx opscrew verify` checks from outside your home (see
   [The check from outside your home](#the-check-from-outside-your-home)).

In scripts, approve as on [a server you already have](own-server.md#in-scripts):
`npx opscrew design --host-key SHA256:...`, `npx opscrew provision --plan-only --yes`, then
`npx opscrew provision --approve <hash> ... --yes`.

## Your router

Design, provision and a failed outside check tell you the same settings, with your server's
address filled in:

- **Forward TCP 80 and TCP 443 to the server's address on your home network**, for example
  `192.168.1.30`.
- **Reserve that address for the server in the router's DHCP settings**, so it stays fixed. If the
  router gives the server another address later, the forwards point at nothing and the site goes
  down.
- **Don't forward SSH.** OpsCrew reaches the server over your home network.
- **Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall** whenever the site
  has an AAAA record (see the table below). Over IPv6 there is no forward: the server has its own
  global address, and most home routers block inbound IPv6 connections until you allow them.

When your server has its public IPv4 address on its own network interface (no router doing NAT in
front of it), no forwards are needed. Design then stops and asks you to name the networks that may
reach SSH in `server.sshFrom`, since there is no home network to default to.

With DNS only, set the forwards before you merge the deploy-setup pull request: the first deploy
fetches the site's certificate through them. Behind Cloudflare's proxy, Cloudflare reaches your
server through them.

## How the site is served

| You chose | Your connection | Records the updater keeps | Who reaches ports 80 and 443 |
|---|---|---|---|
| Behind Cloudflare's proxy | public IPv4 | A, proxied | only Cloudflare, over IPv4 |
| Behind Cloudflare's proxy | no IPv4, but IPv6 | AAAA, proxied | only Cloudflare, over IPv6 |
| DNS only | public IPv4 | A, and AAAA while the server has IPv6 | everyone |
| DNS only, IPv6 only (`target.home.ipv4: false`) | IPv6 | AAAA | everyone with IPv6 |

- **Behind the proxy**, the app gets [origin protection](origin-protection.md), and OpsCrew's
  Cloudflare-only filter lets only Cloudflare's addresses reach the web ports. Over IPv6 the filter
  is OpsCrew's own nftables table `inet opscrew-web`, beside the IPv4 filter. Cloudflare still
  answers visitors over IPv4 when your server is reached over IPv6.
- **With DNS only**, the server gets a public certificate from its proxy, and the records have a
  60-second lifetime: a new address is in the records within about 2 minutes, and reaches
  visitors within a minute after that.
- **No IPv4 at all, but IPv6:** design serves the site over IPv6 behind Cloudflare's proxy and
  says so. With DNS only it stops, since visitors without IPv6 couldn't reach the site. To serve
  only visitors with IPv6 anyway, set `target.home.ipv4: false` in `opscrew/plan.yaml` and run
  design again; design keeps your setting from then on.

Provision reads your network again on every run, and stops before any change when the address
family the plan serves over is gone (for example, the plan serves over IPv4 and the connection has
no IPv4 any more): run `npx opscrew design` again.

## The address updater

With your domain's DNS on Cloudflare, OpsCrew installs a small updater on the server, through the
host plan you approve by its hash. It is a shell script and two systemd units you can read, and it
keeps working without OpsCrew:

| File | What it is |
|---|---|
| `/usr/local/sbin/opscrew-dns-updater` | the script, shared by every app on the server |
| `/etc/systemd/system/opscrew-dns-updater@.service` and `opscrew-dns-updater@.timer` | the units; each app runs its own instance, `opscrew-dns-updater@<app>` |
| `/etc/opscrew/dns-updater/<app>.json` | the app's settings: the zone, the name, which records, proxied or not; no secret and no address |
| `/etc/opscrew/dns-updater/<app>.token` | the app's updater token, readable by root alone (mode 0600, in a folder only root opens) |
| `/var/lib/opscrew-dns-updater/<app>/state.json` | what the last runs saw and did |

**How often.** The timer runs the updater a minute after the server starts, then every 2 minutes.
systemd hands it the settings and the token as credentials, and it runs as an unprivileged,
sandboxed user.

**What a run does:**

1. It reads the server's own public address: IPv4 as two outside sources see it
   (`one.one.one.one/cdn-cgi/trace` and `checkip.amazonaws.com`), which must agree, and the
   server's stable global IPv6 address, never a temporary privacy address.
2. It reads the records at the app's domain at Cloudflare.
3. It writes only what differs, and only its own records: the A and AAAA records that carry the
   comment `Managed by OpsCrew (address updater)`. It creates them when they are missing, updates
   them when the address (or their lifetime or proxied setting) changed, and removes the AAAA
   record when the server positively has no IPv6 address any more. An address it couldn't read
   changes nothing, so a failed detection never removes a record.

It never touches another record. An A or AAAA record at the app's name that it didn't write, or a
CNAME there, stops it with an error until you remove that record. The `www` name and the CAA
records are kept by the infrastructure plan, as for any server.

**When something fails** (Cloudflare unreachable, a refused token, a rate limit, the two IPv4
sources disagreeing), the records keep the last address and the next run tries again. Each run
writes one line to the journal, without any address:
`journalctl -u opscrew-dns-updater@<app>.service`.

`npx opscrew status` shows the updater's last run, what it sees, whether the records match, its
last write and its last error with what to do; `npx opscrew verify` fails when its last success is
more than 10 minutes old or the records don't hold what the server sees.

You approve the updater once, in the host plan, and it then changes the records on its own. The
plan names its bounds: these records, these address families, the server's own address only,
every 2 minutes. The script keeps to them, and every change it makes is recorded on the server.

### The updater's token

The updater uses a Cloudflare token of its own, never OpsCrew's `CLOUDFLARE_API_TOKEN`. Make it at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) under My
Profile (not under the account's API tokens): **Create Token → Create Custom Token**, with:

- permission **Zone → DNS → Edit**;
- zone resources **Include → Specific zone →** your zone, for example `example.com`.

```bash
export OPSCREW_DNS_UPDATER_TOKEN=...   # it goes only to your server
```

`npx opscrew init` says when it is missing, with the same recipe. Before any change, provision
checks that the token works, isn't OpsCrew's own token, can read the zone's DNS records, and can do
nothing else OpsCrew can test: a token that can also reach the zone's rules, SSL or settings, or
the account's tunnels, Access, R2 or Workers, is refused. Cloudflare can't limit a token to one
record, so the zone's DNS is as narrow as it gets.

The token reaches the server only on the SSH connection's standard input and is written to
`/etc/opscrew/dns-updater/<app>.token`. OpsCrew keeps no copy: the host plan holds only its
SHA-256, and no file in your repository, GitHub secret, log or report holds it. Once the server has
it, later provisions without the variable keep the server's file.

**What the token can reach, plainly:** the updater changes only this app's A/AAAA records, but the
token can change any record in its zone. Anything with root on your server can use it, the deploy
runner included: it runs your repository's code in the docker group, which is as good as root.

## The check from outside your home

A request from inside your home proves nothing about visitors outside: your router may let it
through when the forwards are missing, or refuse it when they work. So `npx opscrew verify` checks
from GitHub's machines instead. It starts `.github/workflows/opscrew-outside-check.yml` in your
repository, which requests:

- `https://<your domain><health path>`, with a query that keeps Cloudflare's cache from answering;
- `http://<your domain>/`.

Each request is tried up to six times over about two minutes. The workflow gets only your domain,
the health path and whether the site is proxied, never your home's address, and it has no
permissions, no secrets and logs only status codes. It changes nothing, so it needs no approval;
OpsCrew records the result on this computer and in its audit log.

The check runs once your domain has a record, so after the first deploy. It needs a GitHub token
(`GITHUB_TOKEN` or `gh auth login`) and the deploy-setup pull request merged: without them it is
skipped and says why.

- **When a port doesn't answer,** verify names it, repeats your router's settings, and says the
  possible causes: not forwarded, blocked by your provider, or no public IPv4 address. OpsCrew can't
  tell which from outside. A Cloudflare Tunnel works on any of them.
- **Behind the proxy,** port 443 passing means Cloudflare reached your app's health path. The port
  80 result reads "Cloudflare answered on port 80": it proves your forward on port 80 only when the
  zone sends plain-HTTP requests on to your server.
- **When the run didn't finish** (cancelled or timed out), verify says to run it again; that is not
  a port failure.

What it doesn't prove: that visitors reach the site over IPv6 (it requests over IPv4 from
GitHub's machines), that the site is reachable from every network, that SSH is closed (see
`npx opscrew secure`), or that your address stays the same.

### Hairpin NAT

Many home routers can't loop a request from inside your network back to your own public address.
With DNS only, opening your site from a computer at home can then fail while visitors outside
reach it. When the outside check passed on port 443, verify reports this computer's failed site
requests as warnings, saying so. The deploy's own health check reaches the server directly on your
network, so hairpin NAT never fails a deploy. Behind Cloudflare's proxy requests from home go out
to Cloudflare, so this doesn't apply.

`npx opscrew secure` also labels its own port probes from this computer "from inside your network:
not proof", and never counts them as failures.

## No public IPv4 address, or blocked ports

Some connections share one public IPv4 address among many customers (carrier-grade NAT, the range
`100.64.0.0/10`), put a second router between yours and the internet (double NAT), or block ports
80 and 443. Forwards on your router can't help then.

OpsCrew reads what the server can see, before any change:

- **No IPv4 route and no IPv6:** design stops: use the tunnel.
- **The server couldn't see its public IPv4 address** (the two outside sources didn't answer, or
  disagreed): design stops and asks you to check the server's outgoing HTTPS connections.
- **A sign of carrier-grade NAT** (a carrier-grade NAT address on the server's interface, or a
  carrier-grade NAT or private address on a router after yours): design warns and goes on,
  because the sign isn't certain. It offers the tunnel (answer `server.serve tunnel`) and, when your
  server has IPv6, serving over IPv6 behind Cloudflare's proxy (`target.home.ipv4: false` in
  `opscrew/plan.yaml`).

The outside check has the final word: a connection without a public IPv4 address or with blocked
ports fails it. OpsCrew can't tell those causes apart from outside, and can't see your provider's
blocks before the site runs.

To switch to the tunnel, run `npx opscrew interview`, answer `server.serve tunnel`, then
`npx opscrew design` and `npx opscrew provision`.

## SSH only from your home network

A server at home answers SSH only from your home network. Provision adds OpsCrew's own nftables
table, `inet opscrew`, which accepts SSH from the networks in `server.sshFrom` and drops it from
every other address, over IPv4 and IPv6, even when a router forwards SSH by mistake. It is the
[runner machines' SSH firewall](runners.md#hardening-a-runner-machine), with the same address guard
and revert timer, and it installs `nftables` when the server lacks it. ufw's rules stay as they are.

- **The default sources** are the home network design finds (such as `192.168.1.0/24`) and IPv6
  link-local addresses (`fe80::/10`).
- **Your own sources** go in `server.sshFrom` in an answers file, up to 32 addresses or networks.
  They must include the address this computer connects from; over a VPN, add the VPN's network.
  The terminal interview doesn't ask for them.
- They stay on this computer (`.opscrew/server.json`) and in the host plans saved in
  `.opscrew/plans/`, never in your repository.

Deploys don't need SSH from outside: the [server's runner](runners.md#the-servers-runner) asks
GitHub for jobs over an outgoing connection, so GitHub never holds your home's address. A
[runner machine](runners.md#runner-machines) on your home network also works
(`environment.runner: host`); `github` is refused at home, since GitHub's machines can't reach SSH.
The [scheduled check](alerts.md) reads the server's disk only when the deploys run on the server's
own runner.

### If SSH stops answering after your network changed

A new router can give your home network other addresses, and the server then refuses SSH from
them. On the server's console (a screen and keyboard attached to it), remove OpsCrew's SSH table:

```bash
sudo nft delete table inet opscrew
```

Then put the new network in `server.sshFrom` in an answers file, run
`npx opscrew interview --answers <file>`, `npx opscrew design` and `npx opscrew provision`, which
puts the table back for the new network after your approval. Name the network explicitly: the
interview keeps the earlier sources for the same server otherwise. Check that the router's
forwards point at the server's new address too.

## Several apps on one server at home

Several OpsCrew apps can share a server at home, each from its own repository. Each app has its
own updater instance, settings and token file; the script, the units, the SSH table and the web
filter are shared. Every app on the server must be at home, and all of them served over the same
address families (all with `target.home.ipv4: false`, or none): OpsCrew refuses the app before any
change otherwise.

## A Raspberry Pi

- **The 64-bit OS** is needed (arm64).
- **Storage:** SD cards wear out under a database's writes and can fail without warning, taking
  the data with them. When the server is a Raspberry Pi whose `/srv` or Docker data is on an SD
  card (or a memory card OpsCrew can't tell from eMMC) and the app keeps data on the server, design
  warns and recommends a USB or NVMe SSD: boot from it, or mount it at `/srv` and Docker's data
  root. It doesn't refuse.
- **Power:** a weak supply causes under-voltage, which slows the Pi down and can corrupt its
  storage. `npx opscrew verify` and `npx opscrew secure` read it on the server: a failure while it
  happens, a warning when it happened since the Pi started. A Raspberry Pi 4 needs a 5 V / 3 A
  supply and a Pi 5 a 5 V / 5 A one, with a short, good USB-C cable.

## DNS outside Cloudflare

With your domain's DNS at another provider, OpsCrew can't update the records when your home's
address changes, so there is no updater: only a fixed home address keeps working. The site is
served with DNS only, and you add the records yourself at your DNS provider, pointing at the
address design printed. `npx opscrew verify` compares them with the address your server sees. If
your provider changes your address, move the domain's DNS to Cloudflare, or update the records by
hand.

## Away from home

SSH answers only on your home network, so away from it:

- `npx opscrew status` says your server answers SSH only on your home network, and shows the last
  outside check from this computer's record;
- `npx opscrew verify` still runs the outside check from GitHub's machines, and skips the
  updater's and the power checks, saying why;
- `npx opscrew secure` skips its checks on the server, saying to run it from your home network;
- the commands that change or read the server, such as `provision`, `drift`, `rotate dns-updater`,
  `snapshot` and `destroy`, can't connect: run them at home, or through a VPN into your home
  network.

## Rotating the updater's token

Make a new token with the same recipe, set `OPSCREW_DNS_UPDATER_TOKEN` to it, and run:

```bash
npx opscrew rotate dns-updater
```

OpsCrew checks the new token as provision does, replaces the server's copy through the host plan
(approved by its hash), waits for a successful run with it, and names the page where you delete the
old token. A refused token shows in `status` and `verify` with these steps. See
[Rotating your app's credentials](credential-rotation.md) for the rest.

## Switching away from home, and removing the app

**Switching** to the tunnel or to [a server reached at its own address](own-server.md#how-visitors-reach-your-server):
answer `server.serve` (or `server.home no`) again, then run `npx opscrew design` and
`npx opscrew provision`. Leaving home goes in this order:

1. a host plan, approved by its hash, removes the app's updater from the server, and OpsCrew's SSH
   table when no other app on the server is at home;
2. the records the updater kept are deleted at Cloudflare, from a plan of their own that lists
   them by type and name (never their content); you approve it by typing the app's name;
3. for the tunnel, the setup at home's other records go;
4. the new setup follows.

The app is unreachable until the switch finishes. In a script, `--plan-only` prints the hashes,
and the deletion needs `--confirm <app>` with them. Switching to home from public mode deletes the
old A and AAAA records in the infrastructure plan, then the updater writes its own.

**`npx opscrew destroy`** removes the app as on [a server you already have](own-server.md#removing-the-app-and-undoing-opscrews-changes),
and also:

- the app's updater instance, settings, token file and state (the shared script and units with the
  last app);
- then the records it kept, from their own plan, approved by typing the app's name;
- with the repository's last app at home, the outside check's workflow, in a pull request;
- with `--undo-host`, the IPv6 web filter and the SSH table.

OpsCrew can't revoke the updater's token: destroy names
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens), where you
delete it.

**Moving the app elsewhere:** `npx opscrew retarget` refuses a server at home, as the source and
as the destination: destroy the app there and provision the other target, or add an
[environment](environments.md). A [move to another Cloudflare account](cloudflare-move.md) does
work for an app at home.

## Your provider's terms, and large media

- **Check your internet provider's terms:** many home plans restrict running servers. OpsCrew can't
  check them and says nothing about any provider.
- **Don't serve videos or large downloads through Cloudflare's proxy:** Cloudflare's terms limit
  that without its paid services. A normal website is fine.

## Known limits

- **Your router isn't changed:** no UPnP or NAT-PMP. You set the forwards and the IPv6 firewall
  rule yourself.
- **Carrier-grade NAT, double NAT and blocked ports** can't be fixed from your side: use the tunnel.
- **Dynamic DNS needs Cloudflare:** another provider works only with a fixed address.
- **Previews** can't run on a server at home, and a home app can't go with extra servers or the
  [private network](private-network.md).
- **Retarget** to or from a server at home is refused (see above).
