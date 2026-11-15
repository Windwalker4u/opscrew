# Feature Specification: Hosting at home: your own IP address and dynamic DNS

**Feature Branch**: `029-home-hosting`

**Created**: 2026-11-15

**Status**: Draft

**Input**: User description: "029 Hosting at home: your own IP address and dynamic DNS. OpsCrew serves an app from a computer at the user's home (a Raspberry Pi or any Linux machine, Arm or x86, reached as "your own server") at the home's own public address, static or dynamic: OpsCrew keeps the domain's A/AAAA records pointed at the current address with an updater it installs on the server, says exactly which ports (80, 443) to forward on the router and checks from outside (a one-shot GitHub Actions probe) that they answer, detects when there is no public IPv4 address (CGNAT, double NAT) and offers tunnel mode or IPv6 instead, serves through Cloudflare's proxy with origin protection when the domain is on Cloudflare (else DNS-only with Caddy's own certificate), deploys through the server's own runner by default (no inbound SSH; Cloudflare Access SSH as an option), and keeps SSH closed to the internet."

Research and the founder's decisions: [research.md](research.md). OpsCrew's "your own server"
target, its three ways in (`tunnel`, `proxy`, `dns-only`), origin protection and the server's runner
exist already; this feature adds a server at home reached at the home's own address.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Serve an app from home at a static address (Priority: P1)

A user has a computer at home (a Raspberry Pi on a fiber line, say) and a home connection with a
fixed public address. They tell OpsCrew the app runs on their own server at home. OpsCrew finds the
home's public address from the server, tells them exactly which ports to forward on their router to
which machine, checks from outside the home that the site answers, sets up the app behind
Cloudflare's proxy with origin protection (or, without Cloudflare, with its own certificate), keeps
SSH closed to the internet, and deploys through a runner on the server itself.

**Why this priority**: It is the core of the feature: a site served from home at full line speed
without a tunnel in between. Every other story builds on it.

**Independent Test**: A home server with a fixed public address and ports 80 and 443 forwarded:
interview, design, provision and the first deploy; the site answers from outside over HTTPS; an
outside scan finds only 80 and 443 open; a second push deploys through the server's runner.

**Acceptance Scenarios**:

1. **Given** a server at home whose public IPv4 address is fixed and a domain on Cloudflare,
   **When** the user chooses "at home" for their own server, **Then** OpsCrew says it found a public
   address (never showing a proxied app's address), the router forwards to set up (TCP 80 and 443 to the server's LAN address, which should
   stay fixed), and serves the app behind Cloudflare's proxy with origin protection.
2. **Given** the forwards are not set up yet, **When** OpsCrew checks from outside once the app
   serves, **Then** it says plainly which port doesn't answer and what to forward.
3. **Given** the site is provisioned, **When** anyone scans the home address from outside, **Then**
   only ports 80 and 443 answer; SSH is reachable only from the home network.
4. **Given** a domain whose DNS is not on Cloudflare, **When** the user hosts at a fixed home
   address, **Then** the site is served DNS-only with a public certificate and OpsCrew says which
   record to add at their DNS provider, as it does for any own server today.

---

### User Story 2 - Keep the site reachable when the home address changes (Priority: P1)

Most home connections get a new public address from time to time. OpsCrew installs a small updater
on the server that notices the change and points the domain's records at the new address, so the
site keeps answering without the user doing anything.

**Why this priority**: Without it, a dynamic address (the common case at home) breaks the site at
the first change; it is half of the founder's request.

**Independent Test**: A provisioned home app whose DNS record is set by hand to a wrong address
(standing in for an address change): within a few minutes the updater writes the right address back,
the site answers again, and the change is visible in the server's log and in `opscrew status`.

**Acceptance Scenarios**:

1. **Given** the home address changes, **When** the updater runs next, **Then** it writes the new
   address to every record of every app the server serves, and only when the address changed.
2. **Given** a proxied record, **When** the address changes, **Then** visitors see no change (they
   reach Cloudflare's addresses); **given** a DNS-only record, **Then** the change reaches visitors
   within the record's short lifetime.
3. **Given** Cloudflare's API can't be reached or refuses for a while, **When** the updater runs,
   **Then** it keeps the last address, retries on its next run, and `opscrew status` says when it
   last succeeded.
4. **Given** the updater's credential, **When** the user looks at what it can do, **Then** it can
   change only the DNS of the app's zone (Cloudflare can't narrow it to one record) and is used for
   nothing else.

---

### User Story 3 - No public IPv4 address, or blocked ports (Priority: P2)

Some home connections share one public address among many customers (CGNAT), sit behind a second
router (double NAT), or have ports 80 and 443 blocked by the provider. OpsCrew notices before
anything changes and offers what works instead: tunnel mode (today's way through Cloudflare Tunnel),
or IPv6 served through Cloudflare's proxy where the home has it.

**Why this priority**: A user on such a connection would otherwise follow the forwarding steps and
fail; telling them early saves the attempt.

**Independent Test**: A server whose outside view shows no public IPv4 (or whose forwarded ports
never answer from outside): OpsCrew stops before any change, names the cause it found, and the
offered tunnel mode provisions and serves the app.

**Acceptance Scenarios**:

1. **Given** the address the server is seen at is in the shared CGNAT range or a private range,
   **When** the user chooses "at home", **Then** OpsCrew says the connection has no public IPv4
   address and offers tunnel mode, or IPv6 when the home has a global IPv6 address.
2. **Given** the forwards are set but the outside check never reaches the ports, **When** the user
   runs it again after checking the router, **Then** OpsCrew says the ports don't answer from
   outside (blocked or not forwarded; it can't tell which) and offers tunnel mode.

---

### User Story 4 - IPv6 at home (Priority: P2)

Many home connections have IPv6. The updater keeps an AAAA record pointed at the server's stable
global IPv6 address beside the A record, and removes it when the home has none, so a stale address
never breaks visitors.

**Why this priority**: It makes hosting possible where IPv4 isn't (with the proxy), and it is
cheap once the updater exists.

**Independent Test**: A home server with a global IPv6 address: the AAAA record appears and is kept
current; with IPv6 turned off, the record goes on the next run.

**Acceptance Scenarios**:

1. **Given** the server has a stable global IPv6 address, **When** the updater runs, **Then** the
   AAAA record points at it (never at a temporary privacy address).
2. **Given** an IPv6-only home and DNS-only serving, **When** the user chooses it, **Then** OpsCrew
   says plainly that visitors without IPv6 can't reach the site and recommends the proxy.

---

### User Story 5 - A Raspberry Pi as the server (Priority: P3)

A Raspberry Pi is the typical home server. OpsCrew warns when the app's database would live on the
SD card (cards wear out under constant writes) and recommends a USB or NVMe SSD, and says when the
Pi reports its power supply is too weak.

**Why this priority**: Advice that prevents the most common Pi failures; the server works without it.

**Independent Test**: A Pi booting from an SD card with an app that has a database: design names the
risk and the fix; with an SSD the warning is gone.

**Acceptance Scenarios**:

1. **Given** the root filesystem is on an SD card and the app has a database, **When** design runs,
   **Then** it warns and recommends an SSD, without refusing.
2. **Given** the Pi reports under-voltage, **When** `opscrew verify` or `secure` runs, **Then** it
   says the power supply is too weak and what it needs.

---

### User Story 6 - Deploys through Cloudflare Access SSH instead of the runner (Priority: P3; deferred)

**Deferred:** the lead recommends leaving this story out of 029 (the plan's review found it reaches
about ten files; the server's runner covers deploys); the founder's answer is pending, and the plan
keeps what it would need.

A user who prefers GitHub's hosted runners chooses deploys over SSH through Cloudflare Access: SSH
travels through a tunnel used only for SSH, while the site itself is served directly at the home's
address. SSH stays closed to the internet either way.

**Why this priority**: An option beside the default; the runner covers the common case.

**Independent Test**: A home app with this option: a push deploys from a GitHub-hosted runner
through the Access-protected SSH hostname while the site keeps answering directly at the home
address.

**Acceptance Scenarios**:

1. **Given** the option is chosen, **When** a push deploys, **Then** the deploy reaches the server
   only through the Access-protected SSH hostname and GitHub never holds the home address.

---

### Edge Cases

- **The server's LAN address changes** (the router's DHCP gives it another): the forwards point
  nowhere; OpsCrew tells the user to give the server a fixed LAN address (a DHCP reservation) and
  its outside check fails until they do.
- **Hairpin NAT:** a check from inside the home can't prove the site is reachable from outside;
  OpsCrew never claims it is from an inside test.
- **The address changes during a deploy:** the deploy (through the runner or Access) doesn't depend
  on the home address; the updater fixes the record on its next run.
- **Several apps on one home server:** one updater program, one instance per app (each app's token
  is limited to its own zone).
- **An IPv6 prefix change:** the AAAA record follows on the next run; a stale one is removed.
- **The updater's credential is revoked or expires:** the updater logs it, keeps the last address,
  and `opscrew status` and `verify` say what to do (`opscrew rotate`).
- **`opscrew destroy`:** removes the updater and its credential from the server and stops it
  writing; the records go with the app's DNS.
- **`opscrew retarget` to or from a home server:** refused in 029 (move the app by destroying and
  provisioning it again).
- **A move to another Cloudflare account (028):** the updater is given the new account's credential
  at the finish, with the rest of the app's Cloudflare secrets.
- **The ISP's terms:** many residential plans restrict running servers; OpsCrew says to check them
  and makes no claim about any provider.
- **Large media through Cloudflare's proxy:** Cloudflare's terms limit serving video and large
  files through its proxy without paid services; the guide says so.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-2901**: The interview MUST offer "your own server, at home" and, for it, find the home's
  public IPv4 and IPv6 addresses from the server itself; an IPv4 address in the shared CGNAT range
  (`100.64.0.0/10`) or a private range MUST be reported as "no public IPv4 address".
- **FR-2902**: For a home server, OpsCrew MUST say exactly which router forwards to set (TCP 80 and
  443 to the server's LAN address) and that the server's LAN address must stay fixed; it MUST NOT
  change the router itself (no UPnP or NAT-PMP mapping in this feature).
- **FR-2903**: OpsCrew MUST check from outside the home, through a one-shot run on GitHub's hosted
  runners, that the site's ports answer, once the app serves (`opscrew verify`, run after the first
  deploy); a check from inside the home MUST never count as proof. When they don't answer, it MUST
  say which and offer tunnel mode. Before provisioning, OpsCrew stops only on what the server itself
  can see for certain (no IPv4 route and no IPv6, or its own address unreadable); a carrier-NAT hop is
  a warning, and the outside check is the final word.
- **FR-2904**: With the domain on Cloudflare, a home server MUST be served behind Cloudflare's
  proxy with today's origin protection (origin certificate, authenticated origin pulls, Cloudflare-
  only traffic); otherwise DNS-only with a public certificate the server's edge obtains over ports
  80 and 443 (no DNS-based certificate in this feature).
- **FR-2905**: OpsCrew MUST install, through the host plan approved by its hash, an updater on the
  server that keeps the A record (and the AAAA record, FR-2906) of every app the server serves at the
  current address, writing only on change, every few minutes; DNS-only records MUST get a short
  lifetime (one minute).
- **FR-2906**: Where an app gets an AAAA record (DNS-only serving, or proxied without a public IPv4
  address), the updater MUST point it at the server's stable global IPv6 address (never a temporary
  one) and remove it when the server has none; a proxied app with a public IPv4 address gets no AAAA
  record.
- **FR-2907**: The updater's credential MUST be a dedicated Cloudflare token limited to the DNS of
  the app's zone, kept only on the server (readable by root alone), never OpsCrew's own token; it
  MUST be rotatable with `opscrew rotate`, and `opscrew destroy` removes the server's copy (deleting
  the token itself stays the user's).
- **FR-2908**: Dynamic DNS in this feature MUST work for domains on Cloudflare DNS; a fixed home
  address MUST work with any DNS provider (the user adds the record, as today); another provider's
  dynamic DNS is left for later.
- **FR-2909**: A home server MUST keep SSH closed to the internet: its firewall allows 80 and 443
  from outside and SSH only from the home network.
- **FR-2910**: Deploys to a home server MUST go through the server's own runner by default (no
  inbound connection); deploys through Cloudflare Access SSH over a tunnel used only for SSH are
  deferred with User Story 6. GitHub MUST never hold the home address.
- **FR-2911**: With no public IPv4 address, OpsCrew MUST offer tunnel mode, and IPv6 behind the
  proxy when the home has a global IPv6 address; DNS-only IPv6-only serving MUST be refused unless the
  user accepts that visitors without IPv6 can't reach the site.
- **FR-2912**: `opscrew status` and `opscrew verify` MUST show the updater's state: the address it
  last saw and wrote, when, and its last error (redacted).
- **FR-2913**: On a Raspberry Pi, design MUST warn when the app's database would live on an SD card,
  and `verify`/`secure` MUST report an under-voltage the Pi records.
- **FR-2914**: The interview and the guide MUST say to check the ISP's terms on hosting (no claim
  about any provider) and that large media shouldn't go through Cloudflare's proxy.
- **FR-2915**: No token, key or home address of a proxied app MAY appear in prompts, outputs, logs,
  audit entries, commits or reports; a proxied app's home address stays out of the repository.
- **FR-2916**: A user guide page MUST explain hosting at home: when to use it versus tunnel mode,
  the router forwards, the address checks, the updater, IPv6, the Raspberry Pi advice, the deploy
  paths and the terms.

### Key Entities

- **Home server**: the user's own server at home, with its LAN address, the public IPv4 and IPv6
  addresses seen from outside, and the result of the outside check.
- **Updater**: the program on the server keeping the records current; its credential, interval,
  last seen and written addresses and last error.
- **Outside check**: one probe from outside the home, its time, the ports reached and the answer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-2901**: A user with a home server and a domain on Cloudflare has the app answering over
  HTTPS from outside within 30 minutes of starting, router forwards included.
- **SC-2902**: After the home address changes, the site answers at the new address within 5
  minutes, with no action by the user.
- **SC-2903**: On a connection without a public IPv4 address, OpsCrew says so: as a warning before
  any change when the server sees a carrier-NAT sign, and in the outside check's result otherwise.
- **SC-2904**: An outside scan of a provisioned home server finds only ports 80 and 443 open.
- **SC-2905**: A user can read in `opscrew status` when the updater last wrote the address, without
  logging in to the server.
- **SC-2906**: No token, key or proxied home address appears in any output, log, commit or report
  of the feature's live pass.

## Assumptions

- The home server runs a supported OS (Ubuntu or Debian, amd64 or arm64), as "your own server"
  requires today, and the user's computer reaches it on the home network (or a VPN) for
  `opscrew provision`, as today.
- The user can set port forwards on their router; OpsCrew can't and doesn't try.
- Most users have the domain on Cloudflare (proxied by default); other DNS providers work with a
  fixed address only in this feature.
- The updater's interval is a few minutes; Cloudflare's API limits are far above what it uses.
- Whether Cloudflare's proxy serves IPv4 visitors from an IPv6-only home is confirmed in the live
  pass before the guide promises it.
- Tunnel mode, origin protection, the server's runner, credential rotation and destroy exist and are
  reused, not rebuilt.
