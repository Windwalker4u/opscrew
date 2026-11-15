# 029 Hosting at home: research

Research for the feature "an app served from a computer at home at the home's own public address,
static or dynamic, with OpsCrew keeping the domain's DNS record current". Written 2026-11-15.

Conventions: every fact has a URL. **UNCONFIRMED** marks what the fetched official page did not
say; those are either from general knowledge (stated as such) or open. About 30 fetches were made
(over the budget of 25, because several returned 404 or truncated pages). No blog or forum was
used. Example domain: `example.com`.

## What OpsCrew has today

From the guides in `docs/guide/` (read as the user sees them):

- **Own-server target** (`own-server.md`): OpsCrew reaches any Ubuntu 22.04/24.04/26.04 or Debian
  12/13 machine on amd64 or arm64 (a Raspberry Pi with the 64-bit OS is named) over SSH with a key.
  Host plan: Docker 28+, `deploy` user, SSH hardening, ufw (SSH plus 80/443 when the server serves
  the web itself), fail2ban, unattended upgrades, a shared edge (Caddy or nginx+certbot, plus
  kamal-proxy) in `/srv/edge`. Every change is listed, approved by plan hash, and SSH/firewall
  changes run under a self-undo safety switch.
- **Three ways visitors reach it** (`server.serve`): `tunnel` (default; Cloudflare Tunnel, no
  inbound web port, only SSH allowed in), `proxy` (directly behind Cloudflare's proxy with a
  Cloudflare-only filter in Docker's `DOCKER-USER` chain that fails closed, plus origin
  protection), and `dns-only` (the server answers everyone on 80/443, public certificate, CAA
  records; with non-Cloudflare DNS the user adds the record by hand).
- **Home servers today:** the guide says a server the internet cannot reach "always uses the
  tunnel". `server.reachable: false` forces tunnel mode. Interview asks the SSH port "when a router
  forwards another port to the server". `.opscrew/server.json` keeps the address locally only.
- **Deploys to an own server:** GitHub Actions over SSH as `deploy` to the address held in an
  encrypted deploy secret; in tunnel mode over a separate hostname (`ssh-<app>.example.com`)
  protected by Cloudflare Access with a service token, so Actions never sees the server's address.
  There is also "the server's runner" (`runners.md`), where the deploy job runs on the server
  itself so GitHub no longer reaches it over SSH. The computer running `opscrew provision` must
  reach the server directly (same network or VPN).
- **Origin protection** (`origin-protection.md`): for proxied hostnames, a 15-year Cloudflare
  Origin CA certificate, a per-hostname client certificate with Authenticated Origin Pulls, and
  refusal of unknown hostnames. Not applied to tunnel hostnames or DNS-only hostnames (those get
  a public certificate and CAA).
- **Cloudflare token** (`cloudflare.md`, own-server.md): Zone Read, DNS Edit, Config Rules,
  Zone WAF, SSL and Certificates, Zone Settings; tunnel mode adds Account Tunnel and Access
  permissions.
- **Domains** (`domains.md`): registrars Porkbun, Namecheap, GoDaddy and Cloudflare Registrar;
  buying needs extra Cloudflare token permissions; a domain you own can be connected.
- **Builders** (`builders.md`): images build for the server's architecture; Arm is handled by the
  builder choice. Actions has Arm runners (below).
- **Gap this feature fills:** `proxy` and `dns-only` already exist for servers with a public
  address, but nothing (a) detects the home's public address or CGNAT, (b) keeps an A/AAAA record
  current when the address changes, (c) checks reachability from outside, or (d) offers a deploy
  path that does not need the home address in a GitHub secret.

## 1. Public address detection

Facts:
- `/cdn-cgi/trace` is a Cloudflare-managed endpoint that cannot be modified
  (https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/). Cloudflare's docs
  mention it only for the `colo` field
  (https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/gathering-information-for-troubleshooting-sites/).
  **UNCONFIRMED in official docs:** the `ip=` field, rate limits and any stability guarantee. From
  general knowledge the output is key=value lines including `ip=` and `loc=`, and calling it over
  IPv4 or IPv6 (`curl -4` / `curl -6` against a Cloudflare-served host) returns the family used.
  Relying on an undocumented field is a risk; mitigate with a fallback.
- Porkbun's API has a ping call that returns the caller's address, and Namecheap's dynamic DNS
  update takes no `ip` and then uses the requester's address
  (https://www.namecheap.com/support/knowledgebase/article.aspx/29/11/how-do-i-use-a-browser-to-dynamically-update-the-hosts-ip/).
  The Porkbun ping endpoint is **UNCONFIRMED** (its docs page did not list it;
  https://porkbun.com/api/json/v3/documentation points to `/llms-full.txt`, not read).
- ddclient can detect through a router status page (`fwv4=`, `usev4=fwv4`, `fw-login`) among other
  methods (https://github.com/ddclient/ddclient). Router scraping is brand-specific: not for
  OpsCrew.
- CGNAT: `100.64.0.0/10` is the IANA shared address space for carrier-grade NAT; it is not globally
  routable and providers must not forward it across their borders
  (https://datatracker.ietf.org/doc/html/rfc6598).

Detection logic (no source needed beyond the above): compare the address the router/WAN side shows
to the address the internet sees. Signals of "no usable public IPv4":
1. The detected public IPv4 is in `100.64.0.0/10` (only visible if the router reports it; the
   server's own view is the private LAN address, so it must come from the router or an external
   service seeing the same address).
2. Outside-seen address differs from the server's default-gateway WAN address (needs router
   access; not generally available to the server). Double NAT behind a private (RFC 1918) WAN is
   found by a traceroute whose first hops are private (`10.`, `172.16/12`, `192.168/16`,
   `100.64/10`): **UNCONFIRMED as an official method; heuristic.**
3. Definitive test: the outside reachability check on port 80/443 fails while the address looks
   public (could be a closed port, so say "not reachable" rather than "CGNAT").

Recommendation: detect with Cloudflare `/cdn-cgi/trace` over `-4` and `-6` as the primary source
(domain already on Cloudflare in most flows) with a plain HTTPS fallback of OpsCrew's choosing;
treat a result in `100.64.0.0/10` or RFC 1918 as "no public IPv4"; otherwise rely on the outside
reachability check (section 3) as the truth. Keep sources behind an interface so tests use fakes.

## 2. Dynamic DNS updaters

### Cloudflare API record update
- Rate limit: 1,200 requests per 5 minutes per user/token, cumulative across dashboard, keys and
  tokens; exceeded means HTTP 429 and a 5-minute block, with `retry-after`
  (https://developers.cloudflare.com/fundamentals/api/reference/limits/). A check every minute
  that only writes on change is far below it; one list/GET per check is 5 of the 1,200 per 5 min.
- Token scope: DNS permission groups are zone-level (`DNS Read`, `DNS Write`; the dashboard shows
  "Edit"), scoped to zone resources
  (https://developers.cloudflare.com/fundamentals/api/reference/permissions/). **Record-level
  scoping is not documented** in what was fetched; treat it as impossible: the narrowest token is
  Zone.DNS edit on one zone (Caddy's module README also recommends `Zone.Zone:Read` +
  `Zone.DNS:Edit` on the managed domains: https://github.com/caddy-dns/cloudflare). So a token on
  the home server can change every record in the zone; that is the real exposure. Mitigation:
  a dedicated token per app on that one zone, never OpsCrew's broader deploy token; stored on the
  server only; revoked by `opscrew destroy`/rotation.
- TTL: DNS-only records 60 s to 1 day (30 s on Enterprise), Auto = 300 s; proxied records are fixed
  at Auto = 300 s and cannot be edited
  (https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/). The page does not say
  a proxied record's address cannot change; the proxied record's visible address is Cloudflare's
  anycast address, so visitors never see the change and resolvers cache only 300 s of Cloudflare's
  own IPs. Changing the origin address of a proxied record is an ordinary record update
  (the API PATCH/PUT of `content`); **UNCONFIRMED** whether Cloudflare's edge needs a moment to
  pick up the new origin (general knowledge: effective within seconds).
  Consequence: proxied mode hides address changes from visitors; DNS-only mode shows them after
  the TTL (use 60 s).

### ddclient
- Supports Cloudflare, Porkbun, Namecheap and GoDaddy among many others; Perl 5.10.1+ and `curl`;
  IPv6 via `usev6`; documented sample runs updates from cron; the default daemon interval is
  not stated on the page (https://github.com/ddclient/ddclient). **UNCONFIRMED:** current per-provider
  IPv6 and token-based Cloudflare behaviour (the README did not detail them; the project's docs
  were not read).

### Registrar APIs
- **Porkbun:** API at `https://api.porkbun.com/api/json/v3`, headers `X-API-Key` and
  `X-Secret-API-Key`, full A/AAAA/CNAME/etc. record CRUD, `X-RateLimit-*` headers, `Idempotency-Key`
  on writes (https://porkbun.com/api/json/v3/documentation). API access must be switched on per
  domain (https://kb.porkbun.com/article/190-getting-started-with-the-porkbun-dns-api). Rate
  limit numbers: **UNCONFIRMED**. The key is account-wide, not zone-scoped: broader exposure than
  Cloudflare's token (**UNCONFIRMED** whether per-domain scoping exists).
- **Namecheap Dynamic DNS:** one GET, `https://dynamicdns.park-your-domain.com/update?host=&domain=&password=&ip=`,
  with a separate Dynamic DNS password (not the account password) found under Advanced DNS; the
  domain must use BasicDNS, PremiumDNS or FreeDNS; **A records only, IPv6 not supported**; POST
  does not work; host/domain case must match
  (https://www.namecheap.com/support/knowledgebase/article.aspx/29/11/how-do-i-use-a-browser-to-dynamically-update-the-hosts-ip/).
  Narrow credential (per domain), a plus; no AAAA is a minus.
- **GoDaddy:** Domains API v3, Bearer PAT or classic key, `429` with `Retry-After`; a PAT may not
  work for every API (https://developer.godaddy.com/getstarted). **UNCONFIRMED:** the record
  endpoint and rate limits (the doc pages did not list them). General knowledge, not confirmed in
  official text: GoDaddy restricted the Domains API for small accounts in 2024; verify before
  offering it.

### Recommendation
A small timer OpsCrew installs, not ddclient. Reasons: OpsCrew already writes systemd/Compose
files and audits changes by plan; ddclient adds Perl and a config file with a secret in a format
OpsCrew would have to manage anyway; the Cloudflare call is two HTTPS requests. Design: a systemd
timer (`OnCalendar` ~ every 2 minutes; with 1,200 requests per 5 min, one GET per run is
negligible) that detects the address (section 1), compares to the last written value kept in a
state file, and writes only on change (PATCH A and/or AAAA). TTL: 60 s for DNS-only; Auto (300 s)
for proxied. Expected propagation: DNS-only up to the 60 s TTL after the next timer run (about
1 to 3 minutes total); proxied a few seconds to minutes (see UNCONFIRMED above). Cloudflare first;
Porkbun and Namecheap as later options behind the same small interface (Namecheap A-only). Register
the timer in the host plan, and show its token's limits in the Cloudflare plan.

## 3. Reaching the server from outside

- **Port forwarding:** the user forwards TCP 80 and 443 to the server on the router (and gives the
  server a fixed LAN address or DHCP reservation). OpsCrew cannot do this; it says what to forward
  and checks.
- **UPnP IGD / NAT-PMP / PCP:** NAT-PMP (RFC 6886) lets an internal client ask the gateway for
  mappings on UDP port 5351 and is superseded by PCP (RFC 6887, IPv6 support, firewall control);
  RFC 6886 warns about spoofing, rogue local software opening mappings, and says gateways should let
  users disable it (https://datatracker.ietf.org/doc/html/rfc6886). UPnP IGD-PCP interworking exists
  in routers (RFC 6970), security guidance: access control, no third-party option unless trusted
  (https://datatracker.ietf.org/doc/html/rfc6970). **UNCONFIRMED:** how widely home routers
  support or enable each (no official survey found). Caveat from the RFCs' own security sections:
  any compromised device on the LAN can open ports too. Recommendation: off by default, offered
  only as an explicit opt-in that maps only 80/443, lease-limited, to the server; never the default
  because it widens the network's exposure beyond what the user approved.
- **Hairpin NAT:** many routers do not loop internal traffic to the public address back in, so a
  test from inside the LAN can fail or succeed misleadingly. **Outside vantage points OpsCrew
  already has:**
  1. A GitHub Actions runner: a one-shot workflow run (`workflow_dispatch`) doing `curl` to
     `https://app.example.com` and to the raw address on 80/443. Runners reach the internet from
     public addresses and the ranges change weekly (https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
     so this works as a probe, not an allowlist. The outcome is read back with the GitHub
     connector OpsCrew has. This reuses an existing adapter and needs no new service.
  2. Cloudflare itself in `proxy` mode: a proxied hostname returns a Cloudflare error page when the
     origin is unreachable (general knowledge: 521/522; **UNCONFIRMED here**, not fetched), which a
     check from the user's computer can read. It only proves Cloudflare reaches the origin, which
     is what proxy mode needs.
  Recommendation: the Actions probe as the main check (works for dns-only too), Cloudflare error
  codes as an extra signal in proxy mode, and never claim reachability from a LAN-side test.
- **ISP blocking of 80/443/25:** Let's Encrypt says port-80 blocking by residential ISPs is rare
  but happens, and recommends TLS-ALPN-01 (443 only) or DNS-01 as alternatives
  (https://letsencrypt.org/docs/challenge-types/). Blocking of inbound 80 or 443 specifically by
  named ISPs: **UNCONFIRMED** from official sources (no ISP published a list in what was read).
  Port 25 is irrelevant to web hosting; OpsCrew need not check it (mail is not in this feature).
  Cloudflare proxies origin ports 80/443 plus a list of alternates (HTTP 80, 8080, 8880, 2052,
  2082, 2086, 2095; HTTPS 443, 2053, 2083, 2087, 2096, 8443)
  (https://developers.cloudflare.com/fundamentals/reference/network-ports/). In `proxy` mode a
  blocked 443 could therefore use one of the alternate HTTPS ports (for example 8443) forwarded
  from the router; that is an option, not a default (the page does not state the origin-side
  rule explicitly; **UNCONFIRMED**). If neither works: offer the tunnel.

## 4. TLS for the direct path

- **Caddy's challenges:** HTTP-01 needs port 80 reachable, TLS-ALPN-01 needs port 443; both are on
  by default; DNS-01 is off by default, needs no open ports, needs DNS-provider credentials, and when
  enabled the other two are disabled; DNS provider support is a community effort
  (https://caddyserver.com/docs/automatic-https). Let's Encrypt: HTTP-01 port 80 only, no
  wildcard, redirects only to ports 80/443; DNS-01 supports wildcard; TLS-ALPN-01 port 443 only
  (https://letsencrypt.org/docs/challenge-types/).
- **DNS-01 with Cloudflare:** Caddy's Cloudflare DNS module is a plugin (`caddy-dns/cloudflare`,
  module `dns.providers.cloudflare`); token `Zone.Zone:Read` + `Zone.DNS:Edit`
  (https://github.com/caddy-dns/cloudflare). Because DNS provider support is community plugins
  (Caddy's docs above), a build with the module is needed: the stock Caddy image does not contain
  it (**UNCONFIRMED in the README**; xcaddy is the official way to add modules, from general
  knowledge). OpsCrew's edge today uses stock Caddy; DNS-01 would mean a custom image to build and
  keep updated, and a second token (DNS Edit) living on the server. That is the reason to prefer
  HTTP-01/TLS-ALPN-01 when ports are open.
- **With Cloudflare's proxy** (`proxy` mode, existing): the origin certificate (15 years, Origin
  CA) and Authenticated Origin Pulls are independent of the origin's IP: AOP is a client-certificate
  check on top of Full/Full (strict), not IP filtering, and it is incompatible with Cloudflare
  Tunnel (https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).
  So origin protection keeps working on a dynamic address. The Cloudflare-only IP filter also works
  unchanged (it filters sources, not the server's own address). Ranges are at
  https://www.cloudflare.com/ips (https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/).
  A proxied hostname needs no public ACME certificate: nothing to renew over a blocked port.
- **Recommendation:** proxy mode: reuse existing origin protection unchanged. dns-only mode: HTTP-01
  and TLS-ALPN-01 with stock Caddy; if the check finds both ports blocked (not just 80), say so and
  offer proxy mode or the tunnel instead of a custom Caddy build, unless the founder wants DNS-01
  (question 5 below).

## 5. IPv6

- Cloudflare IPv6 compatibility is about visitors reaching Cloudflare over IPv6; for a proxied
  record with both IPv6 and IPv4 origin addresses Cloudflare prefers IPv4 to reach the origin;
  IPv6 to the origin works "as long as your host provides IPv6 support"
  (https://developers.cloudflare.com/network/ipv6-compatibility/).
- **IPv4 visitors to an IPv6-only origin through the proxy: UNCONFIRMED.** The fetched pages say
  nothing against it, and the origin leg is a separate connection from the visitor's, so it should
  work (general knowledge, mark as to verify in a live test). With DNS-only an IPv4-only visitor
  cannot reach an IPv6-only server at all.
- **Prefixes:** whether the ISP gives a stable or changing prefix, and whether the home server's
  address changes with privacy extensions, is ISP-specific. **UNCONFIRMED** from official sources
  here. Design implication: the updater must write AAAA from the server's global, non-temporary
  address (prefer the stable "scope global, not deprecated, not temporary" address), re-detect each
  run (section 2 timer), and remove AAAA when none exists so a stale one does not break visitors.
  Also needed: the router's firewall must allow inbound IPv6 to the server (no NAT, but typically
  a default-deny pinhole): another thing to check from outside.
- Namecheap's dynamic DNS is A-only (see section 2), so AAAA needs another updater.
- **Recommendation:** treat IPv6 as a second address family in the same timer; if only IPv6 exists,
  offer proxy mode (verified in live test) or the tunnel; state plainly that dns-only IPv6-only
  hides the site from IPv4-only visitors.

## 6. Deploys to a home server

Options:
1. **Cloudflare Access SSH through a tunnel used only for SSH** while web traffic goes direct. It is
   what OpsCrew's tunnel mode already does for SSH (separate `ssh-<app>.example.com`
   hostname with a service token). Needs Zero Trust (free per the guide), the Tunnel token on the
   server, and outbound 7844. Pros: SSH never opened, GitHub never sees the home address, existing
   code path. Cons: needs Cloudflare account permissions the direct path otherwise avoids; the app
   itself would not be on that tunnel (a new "tunnel for SSH only, serve direct" combination). Note
   AOP is incompatible with a tunnel hostname, but SSH hostnames are not the proxied web hostnames,
   so no conflict (inference).
2. **Self-hosted runner on the server** (already in OpsCrew: "the server's runner", `runners.md`):
   the job runs on the server, outbound only. GitHub says self-hosted runners are the route to a
   static IP and that hosted-runner IP lists change weekly
   (https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Pros: no
   inbound path at all, no Cloudflare dependency, already built. Cons: a runner on a home server
   runs repository code (public repos with forks are risky; private repo recommended); the server
   must keep an outbound connection to GitHub; Arm (see section 9).
3. **Pull-based deploy** (a timer pulling the new image): no inbound, no runner, but new code and a
   trust path to the registry; OpsCrew hosting plans already use this for shared hosting agents
   (ADR 0030), but for Docker hosts it would be new.
4. **Open SSH to the internet with the address in a secret:** the existing own-server SSH path;
   not acceptable for a dynamic home address (secret goes stale) and widens exposure.

Recommendation: default to the existing server's runner; offer Access-SSH tunnel as the second
option for users who want GitHub-hosted runners; no pull-based mechanism in this feature.
The user's own computer must still reach the server for `provision` (same LAN or VPN), as today.

## 7. Safety of exposing a home network

- Router exposes only the forwarded ports 80 and 443 to the server; everything else stays closed by
  the router's default. Server: ufw denying everything except 80/443 (and SSH only from the LAN, not
  from the internet, which differs from the current host plan that allows SSH from anywhere:
  **a change for this mode**; if the runner or tunnel handles deploys, close SSH to the internet).
  Docker published ports bypass ufw, which OpsCrew already handles for the Cloudflare-only filter
  (own-server.md).
- Isolation advice (documentation, not something OpsCrew can enforce): put the server on a
  separate VLAN, a guest network, or a router DMZ-less segment so a compromised app cannot reach
  the home's other devices; the guest network of many routers isolates clients. **UNCONFIRMED:**
  router-specific behaviour (no official source covers all routers; cite the router's own manual).
- Cloudflare's proxy hides the home address from visitors; combined with the Cloudflare-only
  filter and Authenticated Origin Pulls (origin-protection.md) it limits who can talk to the
  server. In dns-only mode the address is public by design (also visible in DNS history).
- Existing hardening (fail2ban, unattended upgrades, SSH hardening) stays.

## 8. Terms and limits

- **Residential ISPs:** the two named pages were not retrievable: AT&T's policy URLs returned an
  error or truncated text, and Comcast/Xfinity's acceptable-use URLs returned 404. So
  **no ISP's published text is confirmed in this research.** From general knowledge (UNCONFIRMED):
  many residential agreements restrict running servers or commercial hosting and some forbid
  inbound servers explicitly; others (business plans) permit it. The plan should have the interview
  say "check your ISP's terms; residential plans often restrict hosting servers" and not claim a
  specific rule. A follow-up fetch of one or two ISPs' current pages can be done during the plan.
- **Cloudflare:** the Service-Specific Terms say the CDN may be used to cache and serve web pages
  and sites; serving video and other large files through the CDN requires certain paid services
  (Developer Platform, Images, Stream), and Cloudflare may limit or disable CDN access for a
  disproportionate share of images, audio or large files without them
  (https://www.cloudflare.com/service-specific-terms-application-services/). No terms about home
  or residential origins appear on that page. The Self-Serve Subscription Agreement section 2.2.1
  prohibits VPN-like proxy services and, in (b), sending traffic for a Cloudflare-proxied domain to
  an IP address "not assigned by Cloudflare" in a way the text does not make clear for a plain
  origin (https://www.cloudflare.com/terms/): **its meaning for a home origin is UNCONFIRMED; likely
  about the domain's visible addresses, not the origin, but ask Cloudflare or have the founder
  decide whether to say anything.** The practical rule to put in the docs: a normal website is
  fine; do not serve media libraries or large downloads through the proxy.

## 9. Raspberry Pi as a server

- 64-bit OS needed: OpsCrew's own-server needs arm64 (own-server.md); the Pi OS getting-started page
  was truncated on the OS part (https://www.raspberrypi.com/documentation/computers/getting-started.html),
  so the 64-bit recommendation per model is **UNCONFIRMED here** (general knowledge: Pi 3, 4, 5 and
  Zero 2 W run 64-bit). Image builds: Docker images must be arm64 or multi-arch; GitHub has hosted
  arm64 Linux runners for public and private repositories (`ubuntu-24.04-arm` and others,
  https://docs.github.com/en/actions/reference/runners/github-hosted-runners), so builds need no
  QEMU emulation.
- Storage: microSD is the standard boot media, minimum 8 GB for Lite; faster storage improves
  performance, and newer models boot from USB mass storage or NVMe (same Raspberry Pi page).
  Wear on SD cards from database and Docker writes: **UNCONFIRMED from official docs here**
  (general knowledge: SD cards wear and corrupt under constant writes). OpsCrew advice and check:
  warn when the root filesystem is on an SD card (`/sys/block/mmcblk*`) and the app has a
  database; recommend a USB or NVMe SSD; keep Docker's log rotation (already set).
- Power: Pi 4 needs a 5 V / 3 A supply, Pi 5 a 5 V / 5 A (27 W) supply; voltage is measured at the
  plug so cables matter (same page). A weak supply causes under-voltage resets; a `vcgencmd
  get_throttled` check in `secure` or `verify` is cheap (**UNCONFIRMED:** command not fetched).
- Memory: design already checks free memory (own-server.md); a 1 GB or 2 GB Pi will fail for
  several apps. OpsCrew's existing check handles that.
- MongoDB needs AVX on x86 only; the guide already covers that.

## Recommendations for the plan

1. **Address detection:** Cloudflare trace (`-4`/`-6`) with a fallback, behind an interface; flag
   `100.64.0.0/10` and RFC 1918 as no public IPv4; trust only the outside reachability check
   (via an Actions probe) as the final word.
2. **Updater:** an OpsCrew-installed systemd timer (about every 2 minutes, write on change only),
   Cloudflare first with a dedicated per-app token on the one zone (DNS edit; no narrower scope
   exists in what was documented). TTL 60 s DNS-only, Auto for proxied. Namecheap and Porkbun
   later through the same interface; no ddclient.
3. **Reachability:** user forwards 80/443 (OpsCrew says exactly what); outside check by a one-shot
   GitHub Actions workflow probing the domain and the address; Cloudflare's error pages as an extra
   signal in proxy mode; UPnP/NAT-PMP off by default and, if built, an explicit opt-in mapping only
   80/443; on a blocked port or CGNAT offer tunnel mode or the proxy with an alternate HTTPS port.
4. **TLS:** proxy mode reuses origin protection unchanged; dns-only uses stock Caddy with
   HTTP-01/TLS-ALPN-01. DNS-01 only if the founder wants it (custom Caddy build).
5. **IPv6:** same timer, AAAA from the stable global address, removed when absent; IPv6-only
   serving through the proxy verified by a live test before the docs promise it.
6. **Deploys:** default to the server's runner; the SSH-only Cloudflare tunnel as the second
   option; SSH not opened to the internet in this mode.
7. **Safety:** ufw allows only 80/443 from outside and SSH from the LAN; isolation advice in the
   docs; proxy mode recommended as the shield.
8. **Terms:** docs tell the user to read their ISP's terms (no specific claim until an official
   page is read), and say not to serve media or large downloads through Cloudflare's proxy.
9. **Raspberry Pi:** arm64 only; checks and advice for SD-vs-SSD and power; build on Actions'
   arm64 runners.

## Questions for the founder

1. **Default for the home path: proxied or DNS-only?**
   - Proxied (Cloudflare proxy, origin protection, address hidden, no public certificate on the
     home server, dynamic changes invisible to visitors, but the user is on Cloudflare and subject
     to its terms).
   - DNS-only (no Cloudflare needed, any registrar, the home address public).
   Recommendation: proxied when the domain is on Cloudflare, DNS-only otherwise, and the interview
   explains the difference.
2. **UPnP / NAT-PMP port mapping: build it or only tell the user what to forward?**
   - No: OpsCrew says what to forward and checks it (smaller).
   - Opt-in: a mapping of 80/443 requested from the server.
   Recommendation: no for this feature; revisit if users ask, because it widens exposure and its
   router support is unconfirmed.
3. **Which updater?**
   - OpsCrew's own timer (Cloudflare only first).
   - ddclient (many registrars, more moving parts).
   Recommendation: the own timer with Cloudflare first, Porkbun and Namecheap added later.
4. **Deploy path for the home server by default?**
   - The server's runner (no inbound, existing).
   - Cloudflare Access SSH tunnel for SSH only.
   Recommendation: the server's runner by default, Access SSH as an option.
5. **DNS-01 for dns-only mode (needs a custom Caddy build and a DNS token on the server)?**
   - No: HTTP-01/TLS-ALPN-01 only; if ports are blocked, offer proxy or tunnel.
   - Yes: supports ISPs that block 80 and 443 without Cloudflare's proxy.
   Recommendation: no.
