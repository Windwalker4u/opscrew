# Quickstart: Hosting at home

**Status**: DRAFT, revised after the lead's review. The user's guide page is
`docs/guide/home-hosting.md` (T2918). This file walks implementers and the lead through the
feature and its live pass.

## A user hosts an app at home

Before you start, you need:
- a Raspberry Pi (64-bit OS) or another Linux machine at home, reachable from this computer on the
  home network with an SSH key;
- a domain on Cloudflare;
- the app's GitHub repository.

1. **Make the updater's token**, once per zone. At https://dash.cloudflare.com/profile/api-tokens
   choose Create Token → Create Custom Token:
   - Permissions: Zone → DNS → Edit;
   - Zone Resources: Include → Specific zone → your zone.

   ```bash
   export OPSCREW_DNS_UPDATER_TOKEN=…     # it goes only to your server
   ```

   The updater changes only your app's address records, but the token can change any record in the
   zone. Anything with root on your server can use it, including the deploy runner, which runs your
   repository's code in the docker group.
2. **Interview:** choose "A server you already have", give the server's LAN address, and answer
   that it is at home. Choose how it's served: behind Cloudflare's proxy (recommended), DNS only,
   or through a tunnel.

   ```bash
   npx opscrew interview
   ```

3. **Design:** OpsCrew connects, confirms the host key, and reads the server and the home's
   network. It says:
   - that it found a public address (never showing it behind the proxy);
   - the forwards to set and the DHCP reservation;
   - the IPv6 firewall rule when an AAAA record is published;
   - the ISP's terms, and the large-media note;
   - on a Raspberry Pi with an SD card, the database warning.

   ```bash
   npx opscrew design
   ```

   When the path suggests carrier-grade NAT, design warns and offers the tunnel, or IPv6 behind the
   proxy: set `target.home.ipv4: false` in `opscrew/plan.yaml` and run `design` again.
4. **Set the forwards on the router:** TCP 80 and TCP 443 to the server's LAN address, plus a DHCP
   reservation. When an AAAA record is published, also allow inbound TCP 80 and 443 to the server
   in the router's IPv6 firewall.
5. **Adapt and provision.** The host plan shows:
   - the SSH firewall (SSH only from your network);
   - the address updater, with its records, its 2-minute timer and what its token can reach;
   - the deploy runner on the server.

   Each plan is approved by its hash. The pull request brings the deploy workflow and
   `opscrew-outside-check.yml`.

   ```bash
   npx opscrew adapt          # merge its pull request
   npx opscrew provision      # set the forwards, then merge the deploy-setup pull request
   ```

6. **Verify**, once the first deploy has run on the server's own runner:

   ```bash
   npx opscrew verify
   ```

   It starts the outside check on GitHub's machines and reads the result. When a port doesn't
   answer, it names it, says what to forward and offers the tunnel. Nothing changes.
7. **Day to day:** `npx opscrew status` (from your home network) shows the updater: its last run,
   whether the records match, its last write and its last error. Away from home it says SSH
   answers only at home, and shows the last outside check.

**In a script:** put the same answers in a file (contracts/cli.md), then run `design --host-key
SHA256:…`, `provision --plan-only --yes`, and `provision --approve <hash> … --yes`. Deleting the
updater's records also needs `--confirm <app>`.

**Changing your mind:** answer `server.serve tunnel` (or `dns-only`), then run `design` and
`provision`. Leaving home first removes the updater (a host plan), then its records (you type the
app's name).

**Rotating the token:** set `OPSCREW_DNS_UPDATER_TOKEN` to a new one, run
`npx opscrew rotate dns-updater`, then delete the old token.

## Running the fakes

```bash
pnpm turbo run typecheck test --filter=@opscrew/plan-schema
npx vitest run --root packages/connectors/ssh-host src/home-network src/dns-updater src/ssh-firewall src/web-filter
OPSCREW_DOCKER_TESTS=1 npx vitest run --root packages/connectors/ssh-host src/dns-updater-docker.test.ts src/web-filter-docker.test.ts
PATH="$PWD/.tools/bin:$PATH" npx vitest run --root packages/iac-templates src/infra src/workflow/outside-check.test.ts src/check src/runbook
npx vitest run --root packages/agents src/home src/design src/provision src/verify src/status src/secure src/drift src/destroy
npx vitest run --root packages/cli test/e2e/home.test.ts
```

## The lead's live pass

A Hetzner server plays the home server. Everything except the home line itself is real:
Cloudflare, GitHub's runners, the updater, the firewall and the deploys.

### The stand-ins

| Home thing | Stand-in in the pass |
|---|---|
| The home server (a Pi) | a Hetzner Arm server, the cheapest `cax` type (arm64), set up as the user's own |
| The router and its forwards | a Hetzner Cloud firewall on that server: inbound TCP 80 and 443 from anywhere, SSH only from this computer |
| The home network (SSH's sources) | `server.sshFrom` = this computer's public IPv4 address /32 |
| A new home address | the test sets the app's A record to `192.0.2.<n>` (TEST-NET-1) through the Cloudflare connector |
| An outside scanner | a second throwaway Hetzner server, which scans from inside the test (its output stays in the test process, redacted) |

### Variables (`.env.e2e`, never committed)

| Variable | What |
|---|---|
| `OPSCREW_E2E_HOME` | `1` runs the pass. |
| `OPSCREW_E2E_HCLOUD_TOKEN` | The home server, its firewall and the scanner. |
| `OPSCREW_E2E_CLOUDFLARE_TOKEN`, `OPSCREW_E2E_DOMAIN` | As for the other passes, with the tunnel and Access permissions (`own-server.md`) for H7's switch to the tunnel. |
| `OPSCREW_E2E_DNS_UPDATER_TOKEN` | A token with only Zone → DNS → Edit on the e2e zone. |
| `OPSCREW_E2E_DNS_UPDATER_TOKEN_B` | A second such token, for H7's rotation. |
| `OPSCREW_E2E_GITHUB_TOKEN`, `OPSCREW_E2E_GITHUB_REPO`, `OPSCREW_E2E_GHCR_READ_TOKEN` | As for the own-server pass. |
| `OPSCREW_E2E_OWN_SERVER_TYPE` | Optional: an Arm type other than the cheapest. |

The app is `examples/flask-sqlite`, which keeps a database on the server. Its hostname is
`e2e-<run>-home.<zone>`.

### The legs

Each runs on its own:

```bash
PATH="$PWD/.tools/bin:$PATH" OPSCREW_TEST_TMP=D:/opscrew-test-tmp \
  npx vitest run --root packages/cli test/live/home.test.ts -t "H0"
```

| Leg | What it does | Shows |
|---|---|---|
| **H0** preflight | Checks the tokens: the updater token's checks, including the inverse probes on a token with only DNS Edit. Checks the zone, and that no `e2e-*` record is left over | R6 |
| **H1** proxied over IPv4 | Creates the server and its firewall. Runs interview (`server.home yes`, `server.serve proxy`, `server.sshFrom`), design (the public IPv4 is on the interface, so "no forwards needed"), adapt, provision (the SSH firewall, the updater, the web filter), the merges, the first deploy on the server's runner, and `verify` | FR-2901, 2904, 2905, 2909, 2910; US1; SC-2901's minutes |
| **H2** address change, proxied | Sets the A record to `192.0.2.<n>`, then times the updater's write and the site answering through Cloudflare again. `status` shows the write with no address | SC-2902, SC-2905; O10 |
| **H3** a port not answering | Removes 443 from the firewall. `verify` names 443 and offers the tunnel, and the host plan's and states' hashes don't change. Puts 443 back, and `verify` passes | US1.2, US3.2, FR-2903 |
| **H4** DNS only | Switches from proxied with `server.serve dns-only`: records with a 60 s TTL, a Let's Encrypt certificate, the deploy's health check through `--resolve`, the outside check. Then the firewall also lets SSH in from anywhere, as a router forwarding it by mistake would. The scanner (IPv4 and IPv6) still finds only 80 and 443 open: 22 is closed by OpsCrew's own table, while this computer still logs in. Then the address change again | US1.4, SC-2904, FR-2909, SC-2902 |
| **H5** IPv6 records | The AAAA is present. Deletes the server's IPv6 address from its interface, and the AAAA goes on the next run. Adds the address back, and the AAAA returns | US4, FR-2906 |
| **H6** IPv6 behind the proxy | Sets `target.home.ipv4: false` in plan.yaml, then runs design and provision: AAAA only, IPv6 filter on. The site answers through Cloudflare to GitHub's runner and to this computer, over IPv4. The scanner over IPv6 sees 443 filtered | FR-2911; the spec's assumption, O9 |
| **H7** rotate, switch out, destroy, leaks | Runs `rotate dns-updater` with the second token. Switches home → tunnel: the dedicated host plan, the deletion of the records (the name typed), and the tunnel serving. Then `destroy`, `destroy --undo-host`, and the leak scan over outputs, commits, pull requests, audit entries, saved plans, state files, `server.json` and the check's run logs: no token, and no address of the proxied legs. Deletes the servers and the firewall, and lists leftovers | FR-2907, FR-2915, SC-2906; the switch order and the deletion plan (plan 14.) |

### The founder's optional manual check, on a real home line

Not part of the gate. It's done when the founder has a home line and a Pi at hand, and the results
go to `docs/e2e-coverage.md`.

- **A real router:** the forwards, a DHCP reservation, the IPv6 firewall rule.
- **Hairpin NAT:** `verify`'s own request from inside, and a DNS-only deploy's health check, against
  the outside check.
- **A carrier-grade or double-NAT line:** design's warning and its reason.
- **A real address change** (restart the router, or wait for the ISP's lease): the minutes until the
  site answers again.
- **IPv6 privacy addresses:** the AAAA is the stable address, never a temporary one. Then a prefix
  change.
- **A Raspberry Pi:** the SD-card warning with a database, gone after moving to an SSD; a weak power
  supply reported by `verify` and `secure`.
- **An ISP that blocks 80 or 443:** the outside check fails and offers the tunnel.
- **A renumbered home network:** SSH stops answering, and the guide's console recovery brings it
  back.

### Cost and time

- Two Hetzner servers for a few hours: a few cents. The Hetzner Cloud firewall, the zone on
  Cloudflare's free plan and the tokens cost nothing, plus a few GitHub Actions minutes.
- The longest waits: Let's Encrypt in H4 (about a minute) and each address change (up to 5
  minutes).

### What goes into `docs/e2e-coverage.md`

- the run's row (N of 8 legs);
- the minutes from interview to a working site (H1, without the human steps);
- the time from a changed record to a working site, proxied (H2) and DNS-only (H4);
- how soon Cloudflare's edge used the restored origin (O10);
- the scanner's open ports (H4, H6);
- whether IPv4 visitors reached the AAAA-only proxied origin (H6);
- the inverse probes' answers for a DNS-only token (H0);
- the leftovers check;
- the founder's manual check, when done.
