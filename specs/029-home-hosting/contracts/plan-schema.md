# Contract: `target.home` in `opscrew/plan.yaml`

Owner: `packages/plan-schema` (T2902): `OwnTargetSchema` in `src/plan.ts`, and the refusals in a
new `src/home.ts` that `DeployPlanObjectSchema`'s `superRefine` calls, beside `checkHostingTarget`.
The JSON schema (`json-schema.ts`) is regenerated.

Readers:
- `packages/iac-templates`: the home root, `homeMode`/`homeIpv6Proxied`, the edge,
  `healthScript`, `checkDiskVia`, the runbook;
- `packages/agents`: design, provision, the check's setup, verify, status, secure, drift, destroy,
  retarget (to refuse), cloudflare-move, rotate, init;
- the MCP server, through status.

`opscrew/architecture.json` and `opscrew/requirements.yaml` don't change: the answers about the
server stay local (contracts/cli.md).

## Shape

```ts
export const OwnTargetSchema = z.strictObject({
  provider: z.literal("own"),
  mode: z.literal("vps-compose"),
  arch: z.enum(["amd64", "arm64"]),
  access: z.enum(["public", "tunnel"]),
  /**
   * The server is at the user's home and serves at the home's own address (behind Cloudflare's
   * proxy when `dns.proxied`, DNS only otherwise). `ipv4: false`: served over IPv6 only; with DNS
   * only, the user's acceptance that visitors without IPv6 can't reach the site. Absent: not at
   * home, or served through the tunnel. No address or LAN fact is ever here.
   */
  home: z.strictObject({ ipv4: z.boolean() }).optional(),
  edge: EdgeSchema,
});
```

A plan without `home` keeps its bytes: the key is optional and has no default.

## Refusals (`checkHome(plan, ctx)`)

Each is a zod issue at the given path, in plain English that says what to change.

| When | Path | Message (gist) |
|---|---|---|
| `home` with `access: tunnel` | `target.home` | through the tunnel, a server at home needs no `home`: remove it, or set `access: public` to serve at the home's address |
| `home` in a preview environment's plan | `target.home` | previews can't run on a server at home: their wildcard record would point at an address that changes |
| `home` and `environment.runner: github` | `environment.runner` | at home, deploys run on the server's runner (`server`) or on a runner machine in your home (`host`): GitHub's machines can't reach a server whose SSH is closed to the internet |
| `home` with `servers` | `servers` | extra servers can't go with a server at home: keep the app's services on it |
| `home` with `network` | `network` | the private network can't go with a server at home yet |
| `home` without `dns.domain` | `dns.domain` | a server at home needs a domain: the updater keeps its record, or you add it at your DNS provider |

Rules that already exist and stay as they are:
- `runner: local` only with the localhost target (`plan.ts`);
- a proxied own server needs `security.httpAllowedFrom: cloudflare` (`plan.ts`);
- the interview's deep-domain check behind the proxy (`deepDomainProblem`, agents `shared`), which
  isn't plan-schema's.

`home.ipv4: false` is accepted both proxied and DNS-only. A plan that says it is the user's choice:
design writes it on its own only behind the proxy, when the server has no IPv4 route (plan 3.).

## Kept by a later design

- A user's `home.ipv4: false` is kept, even when the detection sees IPv4.
- Behind the proxy, design writes `false` itself when the server has no IPv4 route and has IPv6.
- `home` goes when the answers say the server isn't at home, or say `tunnel`.

## Predicates (iac-templates, exported)

```ts
/** A server at home serving at the home's own address (`target.home` with access public). */
export function homeMode(plan: DeployPlan): boolean;
/** homeMode, behind Cloudflare's proxy, over IPv6 (`home.ipv4: false`, proxied). */
export function homeIpv6Proxied(plan: DeployPlan): boolean;
```

`sshHostname` and `usesTunnel` don't change (US6 is cut).

## Tests

- each refusal, with its path;
- a plan without `home` parses to the same bytes;
- `home.ipv4: false` parses both proxied and DNS-only;
- the JSON schema includes `home`;
- `src/__fixtures__/` gains a home plan.
