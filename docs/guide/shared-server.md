# A second app on a server OpsCrew created

A server OpsCrew created for one app at [Hetzner Cloud](hetzner.md),
[DigitalOcean](digitalocean.md) or [Contabo](contabo.md) can run more apps, from other
repositories or from the [same one](several-apps.md). The second app gets its own hostnames, its
own containers, data and deploy key, and its own deploys and approvals. It shares the server, its
setup and its proxy with the app OpsCrew created the server for. It adds no server to pay for.

On this page, `shop` is the first app: OpsCrew created its server, at `shop.example.com`. `blog`
is the second app, at `blog.example.com`, beside it.

## When to share a server, and when not to

Share a server when the apps are small, belong to the same people, and may go down together: a
shop and its blog, a site and its admin tool. Both are served by one proxy on one machine, so a
restart, a resize or an outage of the server takes both down.

Give an app a server of its own when:

- **other people may change it.** Both apps run as the same `deploy` user, which can become root
  through Docker (see [Who can reach what](#who-can-reach-what)). Whoever can change one app's deploy
  can reach the other's data and secrets.
- **it needs a lot of memory or CPU**, or must not slow the first app down.
- **it needs previews, a private network, a VPN, closed public SSH, Beszel or Portainer** on its
  server: none of these is offered on a shared server (see
  [What the first app can no longer do](#what-the-first-app-can-no-longer-do)).
- **it needs a server-wide kernel setting**, as [OpenSearch and Elasticsearch](search-and-analytics.md)
  do.

## Step by step

1. **Set up the first app as usual**, on a server OpsCrew creates, and provision it **on this
   computer**. The second app reads the first app's plan, its server's address and its deploy key
   from its repository folder and from this computer's OpsCrew home, so the first app's repository
   must be on this computer, where it was provisioned.

2. **In the second app's repository, run the interview** and choose **A server another of your
   OpsCrew apps runs on (one OpsCrew created)**:

   ```bash
   cd /home/you/code/blog
   npx opscrew interview
   ```

   OpsCrew asks for the first app's repository folder, for example `/home/you/code/shop`. When that
   repository has several apps, it asks which one runs on the server; when it has several
   environments, which one (prod by default). It asks nothing else about the server: its address,
   SSH login and way of serving come from the first app, and there is no budget or region to choose.
   A wrong folder stops the interview, saying why.

   In scripts, put the answers in a file and pass `--answers <file>`:

   ```yaml
   provider: own
   server.shares: /home/you/code/shop
   server.shares-app: admin    # only when that repository has several apps
   server.shares-env: prod     # only when it has several environments
   ```

   Running the interview again with another `server.shares` replaces the folder, for example on a
   second computer or after you moved the repository.

3. **`npx opscrew design`** connects to the server through the first app's deploy login, reads it
   (it changes nothing) and runs the checks below. It offers one option, beside `shop` on its
   server, with no price, and shows the [shared-access warning](#who-can-reach-what).

4. **`npx opscrew adapt`**, as for any app.

5. **`npx opscrew provision`** shows three plans and asks for each separately, each approved by its
   hash, as every plan:

   - the **Cloudflare plan**, when the domain is on Cloudflare: `blog`'s hostnames in the rules
     OpsCrew keeps in your zone (see [Your domain on Cloudflare](cloudflare.md));
   - the **infrastructure plan**: the DNS records of `blog.example.com`, pointing at the first
     app's server;
   - the **host plan**: `blog`'s folders, its record on the server and its own deploy key, added to
     the `deploy` user's keys. It changes nothing of the server's setup, and every other key line
     stays as it is. Its approval repeats the [shared-access warning](#who-can-reach-what).

   It then stores the deploy secrets in GitHub (the server's address, its host key and `blog`'s own
   deploy key) and opens a pull request with the deploy workflow. Merging it runs the first deploy.
   Provisioning again shows no changes.

From then on, `blog`'s commands log in with its own deploy key. `shop` keeps serving throughout:
the second app's provision, deploys and removal never restart the first app's containers. The edge
is shared, though, so a deploy that brings a newer version of it (after you update OpsCrew)
restarts the edge once, for both apps.

## What design checks

Before anything is written, design stops, saying what to change, when:

- **the name** of the second app is already taken on the server, by the first app or another app
  there, or is read there as another app's preview (`shop-pr-3`);
- **a hostname** of the second app is already served there;
- **the way of serving differs.** All apps on a server are served the same way: behind
  [Cloudflare's proxy](origin-protection.md), or DNS only. When `shop` is behind Cloudflare's proxy,
  its server's firewall lets web traffic in only from Cloudflare, so `blog` is served behind it too,
  and its domain must be on your Cloudflare account. When `shop` is DNS only, so is `blog`;
- **a domain is more than one level below its zone** beside a proxied first app:
  `blog.example.com` works, `www.blog.example.com` doesn't, because Cloudflare's free certificate
  covers only one level. Use a name one level deep, or give the app a server of its own;
- **the proxy differs.** The server runs one [reverse proxy](reverse-proxy.md) for every app on it.
  A second app with no proxy chosen yet takes the server's; one whose plan names another
  (`target.edge`) is refused, naming both;
- **the memory doesn't fit.** The server's memory, minus the memory limits of the first app and of
  every other app there, OpsCrew's edge and the system, must hold the second app's components.
  Design warns when less than 15% would stay free;
- **the app needs a server-wide kernel setting**, which only the first app's server setup may change.

Design also needs the second app's repository to have its GitHub remote, `origin`, and it reads
Cloudflare's published IP ranges, because it checks the host plan provision will make.

The first app must itself be a fit. Design refuses a first app that isn't on a server OpsCrew
created, has previews on its server or is itself a preview environment, has
[public SSH](public-ssh.md) closed, runs a [private network or a VPN](private-network.md), or is
itself a second app on another app's server.

## Who can reach what

Both apps run on the server as the same `deploy` user, and that user can become root through
Docker. So anyone who can change `blog`'s deploy workflow or its deploy key can reach `shop`'s data
and secrets too. Design, and the approval of the host plan, say so plainly. Share a server only
between apps the same people may change.

## What the first app can no longer do

While a second app runs on the server, the first app's commands that would break it or remove it
stop before any change, name the app and its repository, and say what to do: remove it with
`npx opscrew destroy` in its repository, or move it to a server of its own with
`npx opscrew retarget` there, then run the command again.

| The first app's command | Why |
|---|---|
| `opscrew destroy` | it deletes the server |
| `opscrew retarget` | the move ends by deleting the server |
| a `provision` that replaces the server (another location, for example) | the new server starts empty |
| `opscrew restore --server <id>` | the whole disk goes back to the snapshot |
| `opscrew secure --close-public-ssh` | the second app's deploys come over public SSH |
| switching between Cloudflare's proxy and DNS only | it changes which addresses reach the web ports, for every app |
| a [private network or a VPN](private-network.md) (`opscrew vpn add`) | a server on a private network takes no second app |
| [Beszel](beszel.md) and [Portainer](portainer.md) | they would run on the server, beside every app |

**A resize** (another server type) still works when the new type holds every app: the first app,
every app there, the edge and the system. Otherwise provision refuses. When it fits, the plan says
that the other apps restart with the server.

`npx opscrew status` in the first app's repository lists the other apps ("Also on this server:
blog"), `npx opscrew drift` doesn't count their key lines and files as drift, and
[`npx opscrew advise`](advise.md) counts their memory.

### `--skip-other-apps-check`

To look for other apps, the first app's commands log in to the server. When they can't (the server
is off, or this computer isn't the one that provisioned the app), they stop. With
`--skip-other-apps-check`, a command goes on:

- when OpsCrew can't look at the server for other apps, with a warning;
- when the only apps there have been removed with their data kept (an `opscrew destroy` without
  `--delete-data`): it warns that their data will be lost.

It never goes on past an app that runs there: OpsCrew still looks, and an app it finds still stops
the command. The flag is on `destroy`, `retarget`, `provision` (and `dns`), `restore`, `secure`,
`addon`, `portainer` and `vpn`.

## What the second app can't do

- **A whole-server snapshot** or restore: the server is the first app's. `blog`'s own data still has
  its [snapshots and restores](snapshots.md) (`npx opscrew snapshot`), and the server itself is
  backed up with `shop`.
- **Add-ons that run on the server:** Beszel and Portainer.
- **Closing public SSH.**
- **Previews** on that server.

Its `npx opscrew secure` checks its own site. The server's hardening (SSH, the firewall, the
deeper checks) is the first app's: run `npx opscrew secure` in its repository.

Deploys, `verify`, `status`, logs, `drift` of its own parts and
[`rotate deploy-key`](credential-rotation.md) work as for any app. A new
[environment](environments.md) of the second app (`npx opscrew env add staging`) is offered the
same server by default, and becomes one more app there, with its own name and hostname.

## Which commands need the first app's folder

`design`, `provision`, `drift` and `rotate deploy-key` of the second app read the first app's plan
from its repository folder on this computer. Keep that folder where the interview found it, or run
the interview again with its new place.

`destroy` doesn't need it: it logs in with the second app's own key.

## Removing the second app

In the second app's repository:

```bash
npx opscrew destroy
```

Its plan removes `blog`'s containers, its folders, its record, its deploy key line and its DNS
records. Every other key line, the first app, the proxy and the server's setup stay as they are.
Without `--delete-data`, its data is kept on the server, and the first app's commands above still
stop for it until you delete it with `npx opscrew destroy --delete-data`, or go on past it with
`--skip-other-apps-check`.

## Moving the second app off

To give the second app a server of its own, move it with
[`npx opscrew retarget`](retarget.md), for example `npx opscrew retarget --to hetzner`. The move
leaves the first app and the proxy running, and its finish removes the second app from the shared
server as `destroy` does. A move goes off a shared server only: to join another app's server, run
the interview as above.
