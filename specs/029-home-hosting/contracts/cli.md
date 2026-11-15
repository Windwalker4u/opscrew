# Contract: what the user types and reads for a server at home

Owners:
- `packages/agents/src/interview/own-server.ts` (T2911): the answers;
- `packages/agents/src/rotate/` and `init/` (T2915a): the token's name and recipe;
- `packages/agents/src/{design,provision,verify,status,secure}/` (T2912 to T2914b): the lines;
- `packages/cli` and `packages/mcp-server` (T2917): rendering.

**No new command and no new flag.** A home server is set up with today's commands.

## Interview answers (`server.<field>`, in a terminal or an answers file)

| Answer | Values | Default | Asked in a terminal |
|---|---|---|---|
| `server.home` | yes / no | yes when `server.host` is a private or local address (`suggestReachable` returns false), else the previous answer, else no | yes, right after `server.host` |
| `server.sshFrom` | space-separated IPv4/IPv6 addresses or networks, up to 32 | the LAN network design finds, plus `fe80::/10` | no (answers file; design's summary shows the sources) |

- **`server.sshFrom`:**
  - it must include the address OpsCrew connects from, or the SSH firewall step refuses and names
    that address. Over a VPN, add the VPN's network;
  - it's required when the server holds its public IPv4 itself (no NAT): design stops and asks for
    it.
- **`server.reachable`:** with `server.home yes`, it isn't asked, and an answers file's value is
  refused: "a server at home is reached through your router's forwards; remove `server.reachable`".
- **`server.serve`:** keeps its values (`tunnel`, `proxy`, `dns-only`), with home labels. `proxy`
  is the default with a Cloudflare domain, `dns-only` without one.
- **IPv6 only:** to serve over IPv6, set `target.home.ipv4: false` in `opscrew/plan.yaml`; design
  keeps it. With DNS only, that's the acceptance that visitors without IPv6 can't reach the site.

```yaml
provider: own
server.host: 192.168.1.30
server.user: ana
server.key: agent
server.home: yes
server.serve: proxy
# server.sshFrom: 192.168.1.0/24 10.8.0.0/24
```

## Variables

| Variable | When it's needed |
|---|---|
| `OPSCREW_DNS_UPDATER_TOKEN` | `provision` of a home app with DNS on Cloudflare, the first time and after the token changes; `rotate dns-updater` |
| `OPSCREW_NEW_DNS_UPDATER_TOKEN` | the finish of a 028 move of a home app; without it, a terminal asks for it once, hidden (in a script it's required) |

Without `OPSCREW_DNS_UPDATER_TOKEN`, a first provision stops before any change:

```text
Your server's address updater needs a Cloudflare token of its own, limited to example.com's DNS.
Nothing was changed.
Make it at https://dash.cloudflare.com/profile/api-tokens → Create Token → Create Custom Token:
  Permissions: Zone → DNS → Edit
  Zone Resources: Include → Specific zone → example.com
Then set OPSCREW_DNS_UPDATER_TOKEN to it and run `npx opscrew provision` again.
It stays only on your server, readable by root alone; OpsCrew keeps no copy.
The updater changes only this app's A/AAAA records, but the token can change any record in example.com.
Anything with root on your server can use it, the deploy runner included: it runs your repository's code
in the docker group, which is as good as root.
```

A token that can do more than the zone's DNS is refused: "this token can also read the zone's SSL
settings (or another permission it names): make one with only Zone → DNS → Edit".

## `opscrew rotate`

- `dns-updater` is listed with the user's own tokens for a home environment with DNS on Cloudflare.
  It's read from `OPSCREW_DNS_UPDATER_TOKEN`, and its expiry comes from Cloudflare's verify answer.
- `npx opscrew rotate dns-updater [--env <name>] [--approve <hash>]` runs the checks, then the host
  plan (by its hash), then a successful run. It ends with "Delete the old token at
  https://dash.cloudflare.com/profile/api-tokens".

## Deleting the updater's records (destroy, leaving home, a 028 abort)

```text
Delete the DNS records your server's address updater keeps (approve 3f9c…):
  A shop.example.com
  AAAA shop.example.com
Type the app's name (shop) to delete them:
```

In a script: `--approve <hash> --confirm shop`. The list never shows a record's content.

## Output lines (gist; the exact words are the tasks')

**design** (home):

```text
Your server is at home: 192.168.1.30 on your network 192.168.1.0/24.
Your home has a public IPv4 address (hidden: Cloudflare's proxy serves the site; OpsCrew never shows or stores it).
On your router, forward TCP 80 and TCP 443 to 192.168.1.30. Reserve 192.168.1.30 for this server in the router's DHCP settings so it stays fixed.
Don't forward SSH: only your network 192.168.1.0/24 reaches it.
Check your internet provider's terms: many home plans restrict running servers.
Don't serve videos or large downloads through Cloudflare's proxy: its terms limit that without paid services.
```

With a carrier-NAT hop (a warning; design goes on):

```text
! Your connection looks like it has no public IPv4 address: the router after yours is at 100.64.12.1, a carrier-grade NAT address.
  The forwards may then never answer from outside. `npx opscrew verify` checks that once the app runs.
  Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel), or, since your server has IPv6,
  serve over IPv6 behind Cloudflare's proxy (set target.home.ipv4: false in opscrew/plan.yaml).
```

Whenever an AAAA record is published:

```text
Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.
```

**verify** (home), when the outside check fails:

```text
✗ From outside your home, port 443 didn't answer (checked from GitHub's machines: https://github.com/…/runs/…).
  Forward TCP 443 on your router to 192.168.1.30, and make sure that address stays this server's.
  It may also be blocked by your provider, or your connection may have no public IPv4 address; OpsCrew can't tell which from outside.
  A Cloudflare Tunnel works without forwards: run `npx opscrew interview`, answer server.serve tunnel, then `design` and `provision`.
Nothing was changed.
```

When the run was cancelled or timed out: "The outside check didn't finish
(https://github.com/…). Run `npx opscrew verify` again."

Away from home: "Your server answers SSH only on your home network, so the updater's state and
the Pi's power weren't checked (skipped). The outside check ran from GitHub's machines."

**status** (home, proxied):

```text
SSH          only from your home network (192.168.1.0/24)
Updater      every 2 minutes · last run 10:04 UTC, ok
  sees       IPv4 (hidden: behind Cloudflare's proxy), no IPv6
  records    match
  last write 09:12 UTC (A changed)
  last error 19 Nov 22:00 UTC: Cloudflare limited the requests for a while (retried)
Outside      checked 20 Nov 10:30 UTC: 443 ok; 80: Cloudflare answered
```

Away from home: "Your server answers SSH only on your home network, so its updater can't be read
from here. Last outside check: 20 Nov 10:30 UTC, 443 ok."

**secure** (home): this computer's port probes read "(from inside your network: not proof; see the
outside check of 20 Nov 10:30 UTC)".

## MCP server

- `opscrew_status` and `opscrew_verify` return the same fields, through the redactor. A proxied
  app's addresses are registered as names, so a reply says "your home's address".
- `opscrew_interview_questions` describes the two follow-ups beside the other `server.*` ones
  (`tools/interview.ts`), and `opscrew_save_requirements` takes them.
- Only `opscrew_verify` starts the outside check.
