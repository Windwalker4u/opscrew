# ADR 0033: Hosting at home: an own server at the home's address, kept current by an updater

**Status**: Accepted (2026-11-18, feature 029). The founder chose the feature on 2026-11-15 and took
the research's five recommendations: proxied through Cloudflare when the domain is on Cloudflare,
else DNS only; no UPnP or NAT-PMP; OpsCrew's own updater, Cloudflare first; the server's runner as
the default deploy path; no DNS-01. On the same day he agreed the constitution amendment 1.12.0 and
cut deploys through Cloudflare Access SSH from the feature. Details: `specs/029-home-hosting/`
(research R1–R14, plan).

## Context

A server the user already owns (ADR 0011) could sit at home only behind the tunnel. Serving it at
the home's own address means: the address can change; the router must forward ports OpsCrew can't
change or see; the line may have no public IPv4 address at all (carrier-grade NAT); a request from
inside the home can't prove the site answers from outside (hairpin NAT); and SSH must not be open
to the internet, so GitHub's runners can't deploy over it.

OpsCrew's records today are in the infrastructure root, written from TF variables. A dynamic
address in a variable goes stale between runs, and the next plan would revert whatever kept it
current.

## Decision

- **D1. An own server, marked `target.home`.** `target.provider: own`, `access: public`, plus
  `target.home: { ipv4: boolean }`. Refused with the tunnel, in a preview's plan, with
  `runner: github`, with several servers, and without a domain.
- **D2. The home's network is read from the server,** read-only, before any change and on every
  run: the LAN address and network, the public IPv4 address from two sources that must agree, the
  stable IPv6 address, the first hops. A carrier-NAT or private hop only warns; the outside check
  decides. Public addresses are never persisted.
- **D3. An address updater on the server owns the app's A and AAAA records** when the DNS is on
  Cloudflare: a readable POSIX script and two systemd template units (`DynamicUser`,
  `LoadCredential`), every two minutes, writing only what differs, touching only records with its
  comment, with a 60 s TTL for DNS-only records. The infrastructure root keeps `www` and CAA and no
  longer holds the address (`cloudflare-dns` gains `ipv4_record`; `a` becomes `a[0]` for every app,
  one moves-only plan at the next provision). With DNS elsewhere, only a fixed address works.
- **D4. The updater's token is the user's,** limited to the zone's DNS and checked with inverse
  probes (wider tokens are refused), kept only on the server (0600 root), handed to curl on
  standard input. The host plan holds its SHA-256 only. `opscrew rotate dns-updater` replaces it.
- **D5. The updater's writes are a standing approval** (constitution 1.12.0, Principle I): the host
  plan that installs it names every bound (the records, the families, the server's own address, the
  interval) and is approved by its hash; each write is recorded on the server and shown by
  `opscrew status`. Anything with root on the server can use the token beyond those bounds,
  including the deploy runner (the docker group is as good as root), and OpsCrew says so plainly in
  the plan, design's summary and the guide.
- **D6. The outside check runs on GitHub's hosted runners:** a one-shot `workflow_dispatch`
  workflow, committed through the deploy-setup pull request, requests the health path on 443 and
  the hostname on 80. It never gets the home's address. A request from the user's computer never
  counts as the check.
- **D7. SSH only from the home network:** the existing `ssh-firewall` step (`inet opscrew`, the
  revert timer, the address guard) in a home server's setup plan. Deploys use the server's runner
  (or a runner machine on the LAN); GitHub never holds a home address. A DNS-only app's deploy
  health check uses `--resolve` to the server itself, so hairpin NAT can't fail it.
- **D8. IPv6 behind the proxy** gets its own web filter, `inet opscrew-web`, letting only
  Cloudflare's IPv6 ranges reach 80/443 on both of Docker's IPv6 paths.
- **D9. Deleting the updater's records** (destroy, leaving home, the 028 move's abort) goes through
  a canonical plan of ids, types and names, hashed and approved with `allowDestroy` and the app's
  name typed, the records read again after the approval. Retarget to or from home is refused.
- **D10. OpsCrew never touches the router.** It says exactly what to forward (TCP 80 and 443 to the
  LAN address, a DHCP reservation, the IPv6 firewall rule when an AAAA is published).

## Consequences

- Every app with DNS on Cloudflare gets one moves-only plan to approve at its next provision
  (`a` → `a[0]`); the release's changelog says so.
- A home server deploys without inbound SSH from the internet; `status` and `verify` away from home
  show what they can without SSH, and the outside check still runs.
- The updater keeps working if OpsCrew is deleted: it is a script and two units, documented.
- The live pass runs on Hetzner stand-ins (a cloud firewall as the router); a real home line is the
  founder's optional check.

## Alternatives considered

- **The root owns the records:** a stale variable reverts the updater, and the AAAA collides.
- **ddclient or a registrar's dynamic DNS:** another dependency with its own config and token
  handling; Cloudflare first, others later.
- **UPnP or NAT-PMP port mapping:** changes the router without a plan the user approved, and is off
  on many routers.
- **DNS-01 certificates:** the token would need to write TXT records too; HTTP-01 through the
  forwarded port 80 is enough.
- **An approval per address change:** a dynamic address changes while the user is away.
- **Deploys through Cloudflare Access SSH:** cut from 029 by the founder (research R9 lists what it
  would need).
