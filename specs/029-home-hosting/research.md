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

**The founder's answer (2026-11-15):** all five as recommended: proxied when the domain is on Cloudflare, else DNS-only; no UPnP or NAT-PMP mapping in this feature; OpsCrew's own updater, Cloudflare first; the server's runner as the default deploy path, Cloudflare Access SSH as an option; no DNS-01.


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

## Plan decisions (R1…)

Written 2026-11-15 with the plan ([plan.md](plan.md)) and revised the same day after the lead's
review. Each decision settles a design question the plan needed. Code is cited by its path as it
is today. **UNCONFIRMED** marks what neither the code nor the research above settles; the plan's
OPEN list carries those.

### R1 How "at home" is written down, and what the interview asks

- **Decision**: one optional key on the own-server target in `opscrew/plan.yaml`,
  `target.home: { ipv4: boolean }`, allowed only with `target.access: public`. Its presence means
  the server is at home and serves at the home's own address: behind Cloudflare's proxy when
  `dns.proxied`, DNS only otherwise. `ipv4: false` means the site is served over IPv6 only. A home
  server served through the tunnel is today's tunnel mode (`access: tunnel`) and gets no `home`.
  The interview's "A server you already have" gains two follow-ups, kept with the others in
  `.opscrew/server.json` → `own` (never committed):
  - `server.home` (yes/no): the default is yes when the address is private or local
    (`suggestReachable` in `interview/own-server.ts` returns false).
  - `server.sshFrom`: answers file only, space-separated networks. The default is the LAN network
    design finds (R8). It is required when the server holds its public IPv4 address itself, since
    there is then no LAN to default to.
  With `server.home yes`, the interview doesn't ask `server.reachable`, since the router's forwards
  make the server reachable. `server.serve` then offers:
  - `proxy`, the default with a Cloudflare domain (the founder's decision 1);
  - `dns-only`, the only choice without one;
  - `tunnel`, which "works on any connection, no forwards".
  The help of `server.home` says to check the ISP's terms on running servers, with no claim about
  any provider, and not to serve large media or downloads through Cloudflare's proxy (FR-2914).
  Design writes `home.ipv4` (R3):
  - `true` when the server sees a public IPv4 address from outside;
  - `false` behind the proxy when the server has no IPv4 route at all but has IPv6;
  - a user's own `home.ipv4: false` in plan.yaml is kept by later designs, and in DNS-only mode it
    is the acceptance FR-2911 asks for (serving IPv6 visitors only).
- **Rationale**:
  - Every `access === "public"` path keeps working as it is: DNS-only records, the web filter,
    origin protection, ufw's web rules. Only the home pieces read `target.home`.
  - OpsCrew can't know whether an address is static, and the updater costs nothing when it never
    writes, so there's no static/dynamic choice.
  - The LAN facts and SSH's sources stay local, like the server's address today (ADR 0010). Only
    the one fact the renderers need is committed: whether the site is served over IPv4.
  - Editing the plan is already an explicit, reviewable choice, so no extra answer is needed to
    accept IPv6-only serving.
- **Alternatives considered**:
  - a third `access` value: dozens of `access === "public"` call sites would need review;
  - `server.address: dynamic`: it asks what the user can't know;
  - a committed block with the LAN facts: nobody reads it;
  - a `server.ipv4` answer to override detection: dropped, because the hop check only warns (R3)
    and the plan's `home.ipv4: false` already says it.

### R2 Who writes a home app's A and AAAA records

- **Decision**: when the server is at home and the domain's DNS is on Cloudflare, the updater (R4)
  owns the app's address records: the A and AAAA records at `dns.domain`, each with the comment
  `Managed by OpsCrew (address updater)`. The root module keeps the rest: the `www` CNAME and the
  CAA records in DNS-only mode.
  - The vendored `cloudflare-dns` module gains a boolean `ipv4_record` (default `true`) beside
    `ipv6_record`, with the A record at `count = var.ipv4_record ? 1 : 0`, and `ipv4` defaulting to
    `null`. The count is known when planning, even for a server created in the same plan (that is
    why `ipv6_record` exists).
  - No `moved` block: both engines move `cloudflare_dns_record.a` to `a[0]` by themselves when
    `count` is added. So every app with DNS on Cloudflare gets one moves-only plan to approve at its
    next provision, and the CHANGELOG says so.
  - `adoptingImports` (`infra/index.ts`) and the tests that name the address change `a` to `a[0]`.
  - The home root (`infra/own.ts`) passes `ipv4_record = false` and `ipv6_record = false` and
    declares no address variables. It outputs `address_updater = true` only when it has an updater
    (DNS on Cloudflare).
  With DNS elsewhere (`dns.provider: none`) there's no updater: the user adds the records as today,
  which works for a fixed address only (FR-2908).
- **Rationale**: one writer per record.
  - If the root kept the records, every engine run would need the current address, and
    `ownEngineEnv` passes the recorded one, so it would revert the updater.
  - An AAAA the updater re-adds would collide with the root's own.
  - No home address reaches a TF variable, a state file or a saved plan (FR-2915).
  - `drift` sees nothing when the address changes.
- **Alternatives considered**:
  - the root owns the records and the updater patches only `content`: stale variables revert it;
  - `ignore_changes`: static, so it would need a second resource for each record;
  - `count` on `var.ipv4 == null`: unknown at plan time for a server created in the same plan;
  - an explicit `moved` block: unnecessary.

### R3 Reading the home's network from the server

- **Decision**: a read-only probe, `detectHomeNetwork(remote)` (ssh-host `home-network.ts`),
  becomes part of the host adapter that agents inject (`HostAdapterApi` in
  `shared/host-plan.ts` gains `detectHomeNetwork`, defaulting to ssh-host's). It runs one fixed
  script over the session OpsCrew already has and returns a zod-checked `HomeNetwork` (data model
  3):
  - **the LAN:** the address, the interface and the gateway from `ip -o -4 route get 1.1.1.1`, and
    the network from that interface's prefix;
  - **IPv4 as the internet sees it:** both sources are asked every time, Cloudflare's trace
    (`curl -4 -fsS --max-time 10 https://one.one.one.one/cdn-cgi/trace`, its `ip=` line) and
    `https://checkip.amazonaws.com`. When both answer and disagree, the address is unknown. Both
    endpoints come from general knowledge: **UNCONFIRMED** (research §1, O5);
  - **IPv6:** the stable global address of the interface that carries the IPv6 default route.
    Excluded: `temporary`, `deprecated`, `tentative`, `dadfailed`, and anything in `fc00::/7`. Of
    several, the longest preferred lifetime wins, then the lowest. No outside source is asked: the
    server's own global address is its public one;
  - **the path:** up to three hops from `tracepath -n -m 3 1.1.1.1`, else
    `traceroute -n -q 1 -m 3 1.1.1.1`, else none.
  The classification (agents `home/network.ts`, pure):
  - **IPv4 seen:** a source, or both agreeing, gives a public address. A hop after the home router
    in `100.64.0.0/10` or a private range, or a carrier-NAT address on the server's own interface,
    adds a **warning**: "your connection looks like it has no public IPv4 address". The warning
    offers the tunnel (`server.serve tunnel`) and, with IPv6, IPv6 behind the proxy (set
    `target.home.ipv4: false`). The outside check (R7) has the final word;
  - **no IPv4:** the server has no IPv4 default route;
  - **unknown:** IPv4 routes, but no source answered.
  - **no NAT:** the public IPv4 is on the server's own interface, so no forwards are needed.
  Design, provision and verify run it each time. A home server's public addresses are never
  persisted: they're re-detected on every run. For a proxied app that's what FR-2915 needs, and
  DNS-only keeps the same rule, so there's one rule (M7). Proxied apps register them with the
  redactor as names.
- **Rationale**: the server can't see its router's WAN address, so the path is its only signal
  before a change. A false positive (an ISP with private-addressed routers and public customer
  addresses) only warns. Two operators guard against one wrong answer, which in DNS-only mode would
  point the domain, and so Let's Encrypt, at someone else's address.
- **Alternatives considered**:
  - a UPnP query: the founder chose no UPnP;
  - the router's status page: brand-specific;
  - one source: no defence against a wrong answer;
  - stopping on a hop: it needs an override answer for false positives.

### R4 The updater

- **Decision**: a POSIX shell script, `/usr/local/sbin/opscrew-dns-updater` (curl and jq), run per
  app by two systemd template units:
  - `opscrew-dns-updater@.service`: oneshot, `DynamicUser=yes`, and `LoadCredential=` of `config`
    and `token` from `/etc/opscrew/dns-updater/<app>.json` and `<app>.token`, both 0600 root in a
    0700 root folder. It also sets `StateDirectory=opscrew-dns-updater/%i` and systemd's sandboxing.
  - `opscrew-dns-updater@.timer`: one minute after boot, then every 2 minutes, with a 20 s random
    delay.
  Each run:
  1. Detects the addresses with R3's rules.
  2. Reads the name's records with one `GET …/dns_records?name=<name>`.
  3. Writes only what differs:
     - PATCH a record of its own whose content, TTL or proxied flag differs;
     - POST a missing one;
     - DELETE its AAAA only when the server positively has no stable IPv6 address, never after a
       failed detection, and never an A.
  Record rules:
  - TTL 60 s for DNS-only records, automatic (1) for proxied ones.
  - A record without its comment is never touched. A foreign A/AAAA, or a CNAME at the name, is an
    error.
  - An error keeps the record as it is, and the next run retries.
  - The token goes to curl on standard input (`curl -K -`), and no address goes to the journal.
  Only the host plan's `dns-updater` step installs, updates and removes it, approved by its hash.
  The step's verify waits for one successful run. Apps on one server share the script and the
  template units, with one instance per app and each instance's own token.
- **Rationale**:
  - Two HTTPS calls and a JSON parse need no daemon. systemd gives the schedule, a root-only
    credential handed to an unprivileged process, and the sandbox.
  - Reading the record on every run repairs a hand-changed record, which is the live pass's
    stand-in for a new address.
  - 2 minutes plus a 60 s TTL is inside SC-2902's 5 minutes, and the request count is far below
    Cloudflare's limit (research §2).
- **Alternatives considered**:
  - ddclient (the founder's decision 3);
  - one root service for every app: it parses network answers as root, holding every token;
  - a container: it needs Docker, plus an image to pin;
  - a 1-minute interval: no gain under a 60 s TTL.

### R5 Which address families each app is served on

- **Decision**:
  - **DNS only:** an A record from the outside IPv4 view (unless `home.ipv4: false`), and an AAAA
    from the stable IPv6 address, removed when there is none. The edge publishes both families, as
    today.
  - **Behind the proxy, with IPv4:** an A record only, as today's web-filter mode (`edgePorts`).
  - **Behind the proxy, without IPv4:** an AAAA record only, with the edge on both families. The
    `web-filter` step gains Cloudflare's IPv6 ranges (`ownWebSources` returns them too; today it
    keeps only IPv4), enforced in an nftables table of OpsCrew's own, `inet opscrew-web`, with two
    base chains:
    - **input:** IPv6 host ports reach a container without IPv6 through docker-proxy
      (`web-filter.ts`);
    - **forward:** DNAT'd connections (`ct status dnat`, `ct original proto-dst` 80/443) cover a
      Docker that gives the edge's network IPv6, which `DOCKER-USER` (IPv4) never sees.
    The script and the unit that Docker requires load it, so it fails closed. The edge's trusted
    Cloudflare ranges already include IPv6 (`siteContext`, `provision/render.ts`), so nothing
    changes there.
  - **The router's IPv6 firewall:** whenever an AAAA is published (DNS-only with IPv6, or proxied
    without IPv4), design and provision say to allow inbound TCP 80 and 443 to the server there.
- **Rationale**: Cloudflare reaches a dual-stack origin over IPv4 (research §5), so a proxied AAAA
  beside the A would open an IPv6 port for nothing. FR-2911 asks for IPv6 behind the proxy without
  IPv4.
- **Alternatives considered**:
  - an AAAA beside the A behind the proxy: more exposure, no visitor gain;
  - the tunnel only for homes without IPv4: smaller, but against FR-2911 (O3);
  - refusing an edge network with IPv6 instead of the forward chain: needs a new inspection fact,
    and the chain is three rules;
  - ip6tables rules in INPUT: ufw rewrites INPUT's jumps.

### R6 The updater's token

- **Decision**: the user makes it: a custom token with Zone → DNS → Edit on the app's zone only,
  given in `OPSCREW_DNS_UPDATER_TOKEN` (`opscrew init`, design's summary and the guide give the
  recipe). Provision checks it before any change:
  - it's set;
  - it isn't `CLOUDFLARE_API_TOKEN`'s value or the same token (the verify answer's `id`, which the
    connector reads from now on);
  - it's active;
  - it reads the zone's records (`zonePermissions(zoneId, ["dns"])`);
  - **inverse probes:** it may do nothing else that OpsCrew can probe read-only. Every other zone
    need (the SSL, settings and rule-phase probes) must come back missing, and so must every account
    need of `accountPermissions` (tunnel, Access, Workers). A wider token is refused with the
    recipe. Other zones can't be checked without Zone Read; the recipe's "Specific zone" covers
    that.
  The write is proven by the step's first run. The token reaches the server only on the host
  adapter's standard input and is written 0600 root. OpsCrew keeps no copy (FR-2907):
  - the host plan holds its SHA-256, so a later plan can tell whether the server's file is the
    variable's token;
  - without the variable, the file on the server stays;
  - a missing file blocks the step, naming the recipe;
  - the undo record in `/etc/opscrew/host.json` keeps neither the token nor its hash.
  Its lifecycle:
  - **rotate:** `opscrew rotate dns-updater` treats it as one of the user's own tokens
    (`rotate/tokens.ts`). It writes the new one through the host plan, waits for a successful run,
    and names the page for deleting the old one.
  - **destroy:** it removes the server's copy and names that page.
  - **028 move:** the finish asks for B's updater token: from `OPSCREW_NEW_DNS_UPDATER_TOKEN`, else
    once in a terminal, hidden, sent on to the server and never kept (R12).
  **What the token can reach, said plainly** (design's summary and the guide): the updater keeps to
  the app's own A/AAAA records, but the token can change any record in the zone. Anything with root
  on the server can use it, the server's deploy runner included: it runs your repository's code in
  the docker group, which is as good as root (O1, R14).
- **Rationale**: OpsCrew could mint the token only with User → API Tokens → Edit, the broadest
  permission there is, against least privilege (IV). The user-token pattern already exists.
  Inverse probes reuse the connector's read-only probes and need no listing that a DNS-only token
  may be refused.
- **Alternatives considered**:
  - OpsCrew mints it;
  - one token per server;
  - OpsCrew's own token on the server (FR-2907 forbids it);
  - a `GET /zones` listing: what a DNS-only token gets from it is unknown.

### R7 The outside check

- **Decision**: a one-shot `workflow_dispatch` of `.github/workflows/opscrew-outside-check.yml`
  (contracts/outside-check-workflow.md). There's one file per repository, rendered by
  iac-templates and added by a home app's deploy-setup pull request.
  - **Inputs:** `host` (the app's domain), `path` (`app.healthPath`) and `mode`
    (`proxied`|`direct`).
  - **Jobs:** `http` and `https` on `ubuntu-24.04`, with no token permissions.
    - `https` requests `https://<host><path>?opscrew-outside-check=<run id>`. The query
      cache-busts, so Cloudflare's cache can't answer for the origin.
    - `http` requests `http://<host>/`.
    Each tries up to six times over two minutes. Each passes on an HTTP answer that is neither 000,
    a Cloudflare origin error (520 to 527, 530), nor an answer carrying a `cf-mitigated` header (a
    Cloudflare challenge stopped it before the origin).
  - **In the log:** each try's status code and curl's exit code. curl runs with `-s` and without
    `-S`, so its error text, which can name an address, isn't printed. GitHub's log also shows the
    step's `env` (host, path and mode) and its own lines.
  - **Running it:** OpsCrew dispatches the run with the GitHub connector (`dispatchWorkflow`,
    `waitForWorkflowRun`) and reads the two jobs' conclusions (`runAttemptJobs`).
    - A cancelled or timed-out job reads "the check didn't finish: run `opscrew verify` again", not
      a port failure.
    - The result is recorded locally, and the dispatch is audited as a provider call.
  - **When:** `opscrew verify` runs it on a home app once the first deploy put the record and the
    edge in place, also away from home.
  - **On failure:** it names the port, the forwards and the fixed LAN address, offers the tunnel,
    and changes nothing.
  - **No approval:** the run changes nothing on the server, in DNS or in the repository.
  **What it proves:** from GitHub's hosted network:
  - **direct:** the forwards reach an edge holding a valid certificate for the hostname, which
    answers the health path on 443, and port 80 answers;
  - **proxied:** Cloudflare reaches the origin's health path on 443. The `http` job then shows only
    that Cloudflare answers on 80: it proves the forward on 80 only when the zone sends plain-HTTP
    requests to the origin, which OpsCrew can't tell, so it's reported as "Cloudflare answered".
  **What it doesn't prove:**
  - IPv6 in `direct` mode (GitHub's hosted runners have no IPv6, **UNCONFIRMED**, O8);
  - reachability from every network;
  - that SSH is closed (`secure` checks the server's firewall);
  - that the address will stay;
  - that a request from inside the home works (hairpin NAT).
- **Rationale**: GitHub never gets the home address (FR-2910, FR-2915). Requests from this
  computer never count as proof. Job conclusions need no artifact or log parsing.
- **Alternatives considered**:
  - the address as an input;
  - a temporary responder before the deploy (a change to the server, and the web filter drops
    GitHub's runner anyway);
  - Cloudflare's 52x seen from this computer;
  - a vantage service of OpsCrew's.

### R8 SSH only from the home network

- **Decision**: a home server's setup host plan includes the existing `ssh-firewall` step
  (`ssh-firewall.ts`, the runner machines' `--harden firewall`). OpsCrew's own nftables table,
  `inet opscrew`, accepts SSH's ports from the sources and drops the rest, over IPv4 and IPv6. It
  runs under the automatic undo, refused when OpsCrew's own address is outside the sources
  (`sshFirewallStep`).
  - **Sources:** `server.sshFrom`, else the LAN network plus `fe80::/10`. With the public IPv4 on
    the server's own interface, `server.sshFrom` is required.
  - **No `nft`:** a home server's step installs `nftables` first.
  - **Several apps:** the step is shared; a table that's in place stays while other home apps are
    there. `planUndo` already removes the table (`plan.ts`).
  - **Mixing on one server:** home and non-home apps, or home apps with different `home.ipv4`, are
    refused on one server (the app record gains `home: { ipv4 }`), as mixing access modes is.
  - **Recovery:** the guide's recovery section covers a home network renumbered, for example by a
    new router, after which SSH no longer answers. On the server's console, run
    `nft delete table inet opscrew`, then run `opscrew provision` with the new `server.sshFrom`.
- **Rationale**: the step is built and tested, changes none of ufw's or the user's rules, and has
  a guard and a revert timer. The sources stay local.
- **Alternatives considered**: source-limited ufw rules; the `public-ssh` step (it needs the
  private network); `security.sshAllowedCidrs` (committed, and it drives cloud firewalls).

### R9 Deploys and the scheduled check

- **Decision**: a home server deploys with `environment.runner: server`, design's default, or
  `host`, a runner machine on the LAN that reaches the server's LAN address over SSH. `github` is
  refused at home in 029: US6 (Cloudflare Access SSH) is cut (founder, 2026-11-15).
  - **`ownDeployTarget`** (`provision/own.ts`) gets a home branch. `server` gives no deploy target,
    since `deploysInPlace` writes no address. `host` gives the server's LAN address
    (`connection.host`) with its pinned key. GitHub never holds a home address.
  - **The scheduled check:** `checkReachesOverSsh` (`check/provision.ts`) is false at home, and
    `checkDiskVia` (iac-templates `check/index.ts`) returns `undefined` at home after the in-place
    case, as it does in tunnel mode. So the server's runner reads the disk, or nothing does.
  - **The deploy's health check:** for a DNS-only home app it uses curl's `--resolve` to reach the
    edge directly, as the local runner does (`healthScript`, `workflow/index.ts`):
    - on the server's runner, `<domain>:443:127.0.0.1` and `:80`;
    - on a runner machine, the LAN address in the existing `HOST` deploy secret.
    Hairpin NAT can't fail it then. Behind the proxy it's unchanged: the request goes out to
    Cloudflare, which comes back in from outside.
- **Rationale**: the founder's decision 4, without the Access option. Each path reuses a tested
  piece.
- **If the founder keeps US6**, it needs three things the review found:
  - **H2:** the table must accept SSH on loopback. The tunnel's route is `ssh://localhost:<port>`
    (`infra/tunnel.ts`), and `ruleLines` (`ssh-firewall.ts`) accepts only the sources before its
    drop, so cloudflared's connection would be dropped while `verifyLogin` from the LAN still
    passes. It needs `iifname "lo" accept`, tested in `ssh-firewall-docker.test.ts`.
  - **M3:** one `accessSshDeploy(plan)` predicate, audited at every site that keys Access-SSH
    deploys on `tunnelMode` today. They are `provision/credentials.ts`, `rotate/infra.ts`,
    `rotate/inventory.ts`, `cloudflare-move/checks.ts`, `cloudflare-move/deploy-secrets.ts`,
    `cloudflare-move/summary.ts`, `provision/own.ts` and `check/provision.ts`. Also
    `edgeServesTls(plan, sshHostname(plan))` (`workflow/index.ts`), which turns off the health
    check's TLS hint.
  - **H7-github:** `ownDeployTarget` would need a `github` branch giving the SSH hostname and the
    service tokens, and the scheduled check would reach the server over Access, as in tunnel mode.
- **Alternatives considered**: pull-based deploys (research §6); SSH open to the internet
  (FR-2909).

### R10 The Raspberry Pi checks

- **Decision**: inspection (`inspectHost`) reads three more facts, read-only:
  - **`board`:** `/proc/device-tree/model`;
  - **`storage`:** the devices of `/srv` (or `/`) and of Docker's data root (`findmnt -n -o SOURCE
    -T`), with `/sys/block/<disk>/device/type` for `mmcblk` devices;
  - **`power`:** `vcgencmd get_throttled` (bit 0: under-voltage now; bit 16: since boot), else the
    boot's kernel log (`journalctl -k -b`, "Undervoltage detected").
  Design warns when the board is a Raspberry Pi, a device is an SD card (or an unknown `mmcblk`),
  and the app keeps a database or files on the server. It recommends a USB or NVMe SSD and doesn't
  refuse. `verify` and `secure` report under-voltage, naming the supply: a Pi 4 needs 5 V / 3 A,
  a Pi 5 needs 5 V / 5 A (research §9). The command, paths and log text come from general
  knowledge: **UNCONFIRMED**. Fixtures test them, and the founder's optional check confirms them.
- **Rationale**: inspection already runs for design and status, and the reads are fixed commands.
- **Alternatives considered**: hwmon's `rpi_volt` as a third source (dropped: two are enough);
  refusing an SD card (the spec says warn).

### R11 What status, verify and secure show

- **Decision**: inspection reads the updater's state over SSH (`dnsUpdaters`). `status` shows:
  - the last run and its result;
  - whether the records hold what the server sees;
  - the last write;
  - the last error, by code, with what to do next.
  A proxied app's addresses are never printed: "hidden: behind Cloudflare's proxy" plus the
  times. A hash of an IPv4 address is reversible, so it gets no fingerprint either. DNS-only
  addresses are public in DNS and are printed. SC-2905 is met over SSH: the user never logs in
  themselves.
  **Away from home** (SSH doesn't answer):
  - `status` says the server answers SSH only on the home network, and shows the last outside
    check from the local record;
  - `verify` still runs the outside check, and the updater and power checks are `skip` with that
    reason.
  **verify** also adds:
  - the outside check;
  - the updater's freshness (a failure when the last success is older than 10 minutes);
  - the records against what the server sees;
  - the Pi's power.
  **secure:**
  - its own port probes from this computer are labelled "from inside your network: not proof";
  - it adds server-side checks: the SSH table, the web filter's families, the token file's owner
    and mode, and the timer.
- **Rationale**: the updater's health without logging in, and no hidden address shown.
- **Alternatives considered**: reading the record's `modified_on` from Cloudflare away from home
  (dropped: SC-2905 is met over SSH, and it was a second code path); a TXT record of the state.

### R12 Deleting the updater's records, mode switches, retarget and the 028 move

- **Decision**:
  - **Deleting the updater's records** happens in destroy, when leaving home mode, and in a 028
    abort. It follows 028's `zoneDeletion` pattern (`cloudflare-move/abort.ts`) in a helper,
    `home/records.ts`:
    1. A canonical plan of the zone id and the records' ids, types and names, never their
       content, hashed with SHA-256.
    2. A `cloudflare-apply` approval with `allowDestroy` and the app's name typed. In a script:
       `--approve <hash> --confirm <app>`.
    3. After the approval, the records are read again. Nothing is deleted when the hash changed.
  - **destroy:** the teardown host plan removes the app's instance, config, token and state, plus
    the shared files with the last instance. Then the records are deleted as above. With the
    repository's last home app, the check workflow leaves with destroy's pull request.
    `--undo-host` also removes the IPv6 web filter; the SSH table already goes (`planUndo`).
  - **Switches between modes on one server** (after `design`):

    | From → to | Steps |
    |---|---|
    | public → home | No removal: the normal infrastructure plan deletes `a[0]`/`aaaa[0]`, then the host plan's updater writes its own records. |
    | tunnel → home | Today's removal (`removeOldAccessMode`), then as above. |
    | home → public | First a dedicated host plan, approved by its hash, removes the app's updater (and the SSH table when it's the server's last home app). Then the records are deleted as above, and the normal plans set up the new mode. |
    | home → tunnel | The same, plus `removeOldAccessMode`'s removal of the home root's `www` CNAME before the tunnel's records. |

    `removeOldAccessMode` reads home as its own mode, from the `address_updater` output.
  - **retarget:** from a home server and to one are both refused in 029, before any change.
  - **The 028 move:**
    - the updater's comment counts as OpsCrew's in `opscrewNamesInZone` (`cloudflare-move/checks.ts`),
      so `otherAppHostnames` and the switch's coverage see a home app's names;
    - the zone plan still copies those records (no shadow root makes them), showing their content
      masked, and the switch refreshes them from A;
    - the finish asks for B's updater token (R6) and gives the updater B's zone id and token through
      a host plan approved by its hash;
    - an abort deletes them from B as above, when B's zone stays.
- **Rationale**: one approved, hashed plan for every deletion of records the root doesn't hold. A
  plan that never holds the address keeps FR-2915. Retarget at home is smaller to leave out than to
  make safe now.
- **Alternatives considered**: deleting the records inside destroy's existing approval (no plan of
  their own to bind); importing them into the state for a retarget from home (dropped with that
  retarget).

### R13 The live pass

- **Decision**: a Hetzner Arm server (the cheapest `cax` type: arm64, like a Pi) plays the home
  server. A Hetzner Cloud firewall in front of it plays the router: TCP 80 and 443 from anywhere,
  SSH only from this computer. A new home address is stood in for by setting the A record by hand
  to `192.0.2.<n>`. A second throwaway server scans from outside. The legs, the variables and the
  founder's optional check on a real home line are in [quickstart.md](quickstart.md).
- **Rationale**: everything except the home line itself is real.
- **Alternatives considered**: a VM behind a NAT of the lead's own; waiting for a real address
  change.

### R14 Constitution I and the updater's unattended writes (O1)

- **Decision**: a MINOR amendment, 1.12.0, agreed by the founder on 2026-11-15. It adds
  to Principle I's standing-approval clause, in substance:

  > A program OpsCrew installs on a server through a host plan approved by its hash MAY repeat one
  > bounded kind of change without asking again. For example, the address updater keeps the app's
  > own A/AAAA records at the server's own address. The plan names every bound, the program keeps
  > to them, and each change it makes is recorded on the server and shown by `opscrew status`.
  > Its credential is on the server, so anything with root there can exceed those bounds,
  > including the server's own deploy runner, which runs the repository's code in the docker
  > group. The plan, design's summary and the guide say so plainly.

  ADR 0033 records it with the rest of the feature.
- **Rationale**: the clause today names CI only. The updater is the same kind of standing change.
  Its bound is real for OpsCrew's own code but not against root on the server, and the principle
  should say so rather than imply more.
- **Alternatives considered**: reading the current clause as covering it (it names CI); a PATCH
  (the clause gains a case, a material expansion).

