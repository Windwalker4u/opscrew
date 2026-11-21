# 035 research: more server providers, first wave (OVHcloud, Kamatera, IONOS Cloud, UpCloud)

The roadmap's order (founder, 2026-11-20): OVHcloud first, then Kamatera, IONOS Cloud and UpCloud.
Each provider ships complete, in a pull request of its own, before the next one starts. This file
starts with OVHcloud (R1 to R3). Each further provider adds its own sections when its work starts.

Sources are official only: the provider's API docs and schema, its Terraform provider's docs and
source, and its pricing pages or public catalogue. Anything no source confirmed is marked
"(unverified)" and listed in R3 for the live pass. No account was created, and no authenticated call
was made.

## R1. OVHcloud Public Cloud

Read 2026-11-21 from https://eu.api.ovh.com/v1/cloud.json, https://eu.api.ovh.com/v2/publicCloud.json,
https://eu.api.ovh.com/v1/auth.json, https://eu.api.ovh.com/v1/me.json, the unauthenticated catalogue
`https://eu.api.ovh.com/v1/order/catalog/public/cloud?ovhSubsidiary=IE` (also DE, FR, GB, CA and, on
`https://api.us.ovhcloud.com/1.0/...`, US), https://github.com/ovh/go-ovh (`ovh/ovh.go`, `ovh/error.go`),
https://github.com/ovh/terraform-provider-ovh (docs, CHANGELOG, issues),
https://registry.terraform.io/v1/providers/ovh/ovh, https://registry.opentofu.org/v1/providers/ovh/ovh/versions,
https://docs.ovhcloud.com/en/guides/manage-and-operate/api/manage-service-account,
https://docs.ovhcloud.com/en/guides/manage-and-operate/api/first-steps,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/analyze-billing,
https://docs.ovhcloud.com/en/guides/public-cloud/compute/suspend-or-pause-an-instance,
https://docs.ovhcloud.com/en/guides/public-cloud/compute/getting-started,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/increasing-public-cloud-quota,
https://docs.ovhcloud.com/en/guides/public-cloud/containers-orchestration/managed-kubernetes/datacenters-nodes-storage-flavors.md,
https://www.ovhcloud.com/en/about-us/global-infrastructure/regions/ and
https://www.ovhcloud.com/en/about-us/global-infrastructure/expansion-regions-az/. The pricing page
https://www.ovhcloud.com/en/public-cloud/prices/ came back without its tables, so prices below come from the
public catalogue API instead. The IAM policy guides and the OVH security-group guides were read only through
a search summary (https://docs.ovhcloud.com/en/guides/account-and-service-management/account-information/iam-policies-api,
https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/security-group-private-network).

### 1. API and sign-in

**Endpoints** (go-ovh `ovh/ovh.go`, provider `docs/index.md`):

| Provider `endpoint` | API base | OAuth2 token URL |
|---|---|---|
| `ovh-eu` | `https://api.eu.ovhcloud.com/1.0` | `https://auth.eu.ovhcloud.com/oauth2/token` |
| `ovh-ca` | `https://api.ca.ovhcloud.com/1.0` | `https://auth.ca.ovhcloud.com/oauth2/token` |
| `ovh-us` | `https://api.us.ovhcloud.com/1.0` | `https://auth.us.ovhcloud.com/oauth2/token` |

- `https://eu.api.ovh.com/v1` (the console's host) also answers. Accounts are separate per zone, and the
  catalogue's `ovhSubsidiary` must match the zone: the EU API refuses `US` (`invalid ovhSubsidiary`), and
  `api.us.ovhcloud.com` serves it.

**Three ways to sign in** (provider `docs/index.md`, go-ovh):
1. **Application key + application secret + consumer key.** Every call sends `X-Ovh-Application`,
   `X-Ovh-Consumer`, `X-Ovh-Timestamp` (server time from `GET /auth/time`) and
   `X-Ovh-Signature: $1$` + hex SHA-1 of `applicationSecret+consumerKey+METHOD+fullURL+body+timestamp`.
   Env vars: `OVH_ENDPOINT`, `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`.
2. **OAuth2 service account** (client credentials). Env vars: `OVH_ENDPOINT`, `OVH_CLIENT_ID`,
   `OVH_CLIENT_SECRET`. The provider docs list it first ("scoped service accounts, and compatible with
   OVHcloud IAM").
3. **A short-lived access token** in `OVH_ACCESS_TOKEN` (with `OVH_ENDPOINT`).
- The provider also reads `~/.ovh.conf` and named profiles (`OVH_PROFILE`).
- At start-up it sends a validation request (`/auth/details`) unless `OVH_IGNORE_INIT_ERROR` is set.

**Application key, secret and consumer key** (https://eu.api.ovh.com/v1/auth.json, `first-steps` guide):
- The application is declared on the token page (`https://auth.eu.ovhcloud.com/api/createToken`, formerly
  `https://api.ovh.com/createToken/`) with the account login and password, an application name, an optional
  validity and the rights. The page yields all three values at once.
- Programmatically, `POST /auth/credential` (no signature, only the `X-Ovh-Application` header) takes
  `{accessRules: [{method, path}], allowedIPs?, redirection?}` and returns `{consumerKey, state,
  validationUrl}`. The state starts as `pendingValidation`; the account holder opens `validationUrl`, logs in
  and picks a validity; it becomes `validated` (other states `refused`, `expired`).
- `GET /auth/currentCredential` shows the credential in use, with its `rules`, `expiration` and
  `allowedIPs`.
- **Scope.** An access rule is a method plus a path, with `*` as a wildcard, so a key limited to one project
  is possible, for example `GET /cloud/project/{id}/*` and `POST /cloud/project/{id}/instance*`. The
  `first-steps` guide gives no path-level detail beyond the wildcard.
- The provider's order guide (`docs/guides/order_consumer_key_access_rules.md`, issue #1448) warns that a
  restricted key must also allow the order and terminate routes to create or delete a project, or calls fail
  with `This call has not been granted`. That matters only for ordering a project, not for managing instances.

**OAuth2 service accounts** (service-account guide):
- Created in the control panel (Identity and Access Management, Identities, Service account) or with
  `POST /me/api/oauth2/client` (`flow: CLIENT_CREDENTIALS`, `name`, `description`, empty `callbackUrls`),
  which returns `clientId` and `clientSecret`. The secret cannot be read again.
- A service account has no rights until an IAM policy names it. Its identity URN is
  `urn:v1:<eu|ca>:identity:credential:<account-id>/oauth2-<clientId>`.
- **Scope to one project and to chosen actions: yes, through IAM.** A policy's `resources` can be the project
  URN `urn:v1:eu:resource:publicCloudProject:<project-id>` (`ca` for the rest of the world) and
  `permissions.allow` lists actions such as `publicCloudProject:apiovh:instance/create` (every operation's
  `iamActions` in the API schema names its action), or a managed group such as `globalReadWrite`. All
  actions are denied by default. Source: the IAM guides (search summary only). The `us` zone's URN form is
  unverified.
- The guide says the pair "has no time limit". The access token's lifetime is unverified.
- **Known gap:** provider issue #1592 (2026-11-11), `ovh_okms` rename fails with OAuth2 because `/services`
  returns 404 despite IAM. Whether every route OpsCrew needs works with a service account is unverified.
- Personal access tokens exist in the schema (`auth.PersonalAccessToken`, with `expiresAt`). I found no route
  for them. Unverified.

**Token format.** No source shows a prefix. Application key, consumer key, client id and client secret are
opaque strings (unverified: no real examples seen), so a secret scanner has no prefix to match.

### 2. Terraform provider `ovh/ovh`

- Latest **v2.25.0**, published 2026-11-13 (registry; the changelog heading says 2026-11-06). Earlier: v2.24.0
  2026-10-29, v2.23.0 2026-10-22, v2.22.0 2026-10-02. Registry tier `partner`. Licence **MPL-2.0** (GitHub
  API). On the **OpenTofu registry** (83 versions, 2.25.0 included).
- OVHcloud ships **two families** of Public Cloud resources
  (`docs/guides/public_cloud_resources_migration.md`): the legacy `ovh_cloud_project_*` (API v1, deprecated,
  a warning at every plan) and the new `ovh_cloud_*` (API v2, `/v2/publicCloud/...`, "Most arguments update
  in place"). `ovh_cloud_instance` first appears in the changelog in 2.19.0 (2026-08-07), `user_data` in
  2.20, snapshots in 2.20. The guide recommends moving to the new family. Both are in 2.25.0.

**New family:**

| Need | Resource | Notes |
|---|---|---|
| Server | `ovh_cloud_instance` | `service_name`, `region`, `name`, `flavor_id`, `image_id`, `ssh_key_name`, `user_data`, `networks`, `security_group_ids`, `power_state`, `availability_zone`, `group_id`, `volumes` |
| SSH key | `ovh_cloud_ssh_key` | `name`, `public_key`, both immutable; beta API |
| Firewall | `ovh_cloud_security_group` | per region; `rule` list (`direction`, `ethernet_type`, `protocol`, `port_range_min/max`, `remote_ip_prefix`, `remote_group_id`) |
| Private network | `ovh_cloud_network_private_vrack` + `ovh_cloud_network_private_vrack_subnet` (+ `ovh_cloud_gateway`) | one per region |
| Snapshot | `ovh_cloud_instance_snapshot` | every argument immutable |
| Volumes | `ovh_cloud_storage_block_volume` (+ `_snapshot`, `_backup`) | |
| Region | `ovh_cloud_project_region` | adds a region to the project |
| Project | `ovh_cloud_project` | orders a project; needs a default payment method |
| Lookups | data sources `ovh_cloud_instance_flavors`, `ovh_cloud_instance_images` | ids are per region |

- `ovh_cloud_instance` has **no billing period argument**, and neither has the v2 create body, so it
  creates hourly instances (the default is unverified on a live call). **Monthly billing needs the legacy
  `ovh_cloud_project_instance`** (`billing_period` = `hourly` or `monthly`, forces a new instance) or
  `POST /cloud/project/{id}/instance/{id}/activeMonthlyBilling`.
- `user_data` is base64 (`base64encode(...)`, 65535 bytes max), write-only and sensitive. A change to a
  different value **reinstalls the instance and wipes the root disk** (id and IP survive); `""` does the
  same; removing the argument does not. An imported instance has no user data in state, so the first apply
  with `user_data` set reinstalls it.
- Changing `image_id` rebuilds and wipes the disk. Changing `flavor_id` resizes in place.
- `ssh_key_name`, `region`, `service_name`, `group_id` and a set `availability_zone` force a new instance.
- Create, update and delete poll up to **60 minutes**, with no `timeouts` block. `resource_status = ERROR`
  ends the wait and the provider reports the failed task's summary.
- `security_group_ids` omitted: the project's `default` group is applied and written into state. `[]`: no
  group, so no inbound traffic at all. Each new group gets an automatic allow-all egress rule outside the
  managed `rule` set.
- Import ids: `service_name/instance_id`. Resources deleted outside Terraform drop out of state on refresh.
- Open issues: none against `ovh_cloud_instance` or `ovh_cloud_security_group` among the open issues listed
  on 2026-11-21 (first 60). Related: #1448 (consumer keys need undocumented routes to order a project) and
  #1592 (OAuth2 404). The disk-wipe cases above are documented behaviour, not bugs.
- Backups: `ovh_cloud_project_workflow_backup` (legacy family: `region_name`, `cron`, `instance_id`,
  `rotation`, `max_execution_count`). Deleting the workflow **does not delete the backups it made**. The
  legacy instance has `auto_backup { cron, rotation }`; the new resource lists no backup argument.

**OpenStack alternative.** `ovh_cloud_project_user` creates a Keystone user and OVH's regions expose normal
OpenStack endpoints, so the `terraform-provider-openstack` would work per region. The OVH docs I read show
OpenStack only for Horizon and the CLI, and the provider docs push `ovh_cloud_*`. Nothing I found says OVH
recommends the OpenStack provider. The OpenStack route gives plain Nova and Neutron semantics (server
metadata, one provider block per region) but needs an OpenStack user per project and does not do region
activation, monthly billing or the project. **Recommendation: `ovh/ovh` with the new `ovh_cloud_*`
resources**, and the legacy `ovh_cloud_project_instance` only for monthly instances.

### 3. Billing

Sources: `analyze-billing` guide, `suspend-or-pause-an-instance` guide, the catalogue.

- **Hourly instances** are metered **per second after a 1-minute minimum**, never rounded up to the hour. The
  meter starts when the instance reaches `ACTIVE`; time in `BUILD` is not billed. Billing stops only when the
  instance is **deleted**. Hourly usage is invoiced on the first day of the next month.
- **Monthly instances:** "roughly 50% cheaper" than hourly per the guide (the catalogue shows 25% for d2,
  see section 7). Paid in advance. **Each commenced month is billed in full, even if the instance is deleted
  early.** No pro-rata refund is stated.
- **Hourly to monthly** is allowed, not the reverse. Switching charges the rest of the current month at once
  (pro rata). API: `POST /cloud/project/{id}/instance/{id}/activeMonthlyBilling`.
- **Gen 3 flavors (b3, c3, r3) are hourly only.** The catalogue has no monthly line for them; their discount
  comes through Savings Plans (1 to 36 months). The older d2, s1, b2, c2, r2 families have monthly lines.
- **Setup fee:** none. The catalogue's `project*` plans cost 0 to install, and instance lines have only a
  `consumption` price.
- **Stopped (SHUTOFF), paused, suspended:** full rate continues, hourly or monthly. The public IP is kept.
- **Shelved:** for an hourly instance compute is released and **only the snapshot is billed** (rate in
  section 5); the IP is kept. A monthly instance pays its monthly price plus the snapshot. The `analyze-billing`
  page words this ambiguously ("will not stop the billing ... but will reduce your cost"), so confirm on a
  real invoice.
- **Public IPv4:** no separate line in the catalogue, and the guides charge nothing for an Ext-Net public IP.
  Instance bandwidth is "not billed" (catalogue `bandwidth_instance_out` is 0). A gateway is paid: s 2.00,
  m 8.00, l 35.00 EUR a month (catalogue); only private-only networks need one. Floating IP and additional IP
  prices are not in this read (unverified).
- **VAT:** catalogue prices are before VAT; `locale.taxRate` carries the subsidiary's rate (IE 23, DE 19,
  FR 20, GB 20; US and CA 0).
- **Deleting a monthly instance mid-month** is allowed; the whole commenced month stays billed.
- Deleting an instance does **not** delete its snapshots, backups or volumes; they keep billing.
- New-account credit: about 175 GBP (UK) or 200 USD (US), valid one month. The EU amount is unverified.

### 4. Firewall and private networking

- **Security groups (OpenStack).** v2 API `/v2/publicCloud/project/{id}/securityGroup` (GET, POST; GET, PUT,
  DELETE on one id); Terraform `ovh_cloud_security_group`, per region; the instance takes
  `security_group_ids`.
- **The default group is open.** OVH's OpenStack CLI guide says the `default` group allows every protocol in
  both directions, so a new instance on it accepts every connection. The Horizon guide contradicts itself
  ("only outgoing"). Treat the default as open (unverified on a live project) and always attach an OpsCrew
  group. OVH advises against editing the default group.
- `security_group_ids = []` gives an instance that accepts no inbound traffic.
- **OVHcloud Network Firewall** is a per-IP feature of the IP product (anti-DDoS family). It is separate from
  the security group. I did not read its docs or API; unverified, and not needed for OpsCrew.
- **Anti-DDoS** on OVHcloud public IPs is an OVH product claim not checked here (unverified).
- **vRack private networks:** `ovh_cloud_network_private_vrack` (one per region) with a subnet. The vRack
  product is free to order per the provider's order guide; a gateway is paid (above). Not needed for
  OpsCrew's single-server apps. Region coverage: wherever the project has the region.
- **IPv6:** security rules take `ethernet_type = IPV6`, and the legacy instance reports addresses with a
  version. Whether Ubuntu 24.04 instances get a public IPv6 by default is unverified.

### 5. Backups and snapshots

- **Instance snapshot** (an image): catalogue `snapshot.monthly.postpaid` **0.011 EUR per GB a month**
  (hourly line 0.000015 per GB-hour; LZ.EU 0.0000275; 3AZ 0.00001917). USD 0.0123, GBP 0.0079, CAD 0.0158 a
  month. The guide says instance snapshots are billed at a flat rate per GB per month.
- **Block volume snapshot** 0.042 EUR/GB/month; classic volume 0.042; high-speed 0.086.
- **Automated backup:** `POST /cloud/project/{id}/region/{region}/instance/{id}/autobackup`, the create
  field `autobackup {cron, rotation}`, and Terraform `ovh_cloud_project_workflow_backup`. These are scheduled
  snapshots, so the snapshot price applies; no separate backup fee is listed.
- **They outlive the instance.** The billing guide says deleting an instance leaves storage, snapshots and
  backups in place and billing, and the workflow resource says its backups survive its deletion. OpsCrew's
  removal has to list and delete them, or leave them on purpose.
- Restore: create an instance from the image (`image_id`) or reinstall (`POST .../reinstall`).
- Limits on snapshot count per project: not found (unverified).

### 6. Regions

Region ids are the ones the Kubernetes datacenter page uses; city and kind come from the infrastructure
pages. Coordinates are approximate and mine, not OVHcloud's.

| Public Cloud region | City, country | Kind | ~Lat, lon | OpsCrew key |
|---|---|---|---|---|
| `DE1` (site Limburg, `eu-west-lim`) | Frankfurt area, DE | 1-AZ | 50.4, 8.0 | eu-central |
| `WAW1` (`eu-central-waw`) | Warsaw, PL | 1-AZ | 52.2, 21.0 | eu-central |
| `GRA11` (also GRA5, 7, 9; `eu-west-gra`) | Gravelines, FR | 1-AZ | 51.0, 2.1 | eu-west |
| `SBG5` (`eu-west-sbg`) | Strasbourg, FR | 1-AZ | 48.6, 7.8 | eu-west |
| `EU-WEST-PAR` | Paris, FR | 3-AZ (a, b, c) | 48.9, 2.4 | eu-west |
| `UK1` (`eu-west-eri`) | London (Erith), UK | 1-AZ | 51.5, 0.2 | eu-west |
| `EU-WEST-RBX` | Roubaix, FR | 1-AZ | 50.7, 3.2 | eu-west (spare) |
| `EU-SOUTH-MIL` | Milan, IT | 3-AZ | 45.5, 9.2 | none |
| local zones `eu-north-lz-hel`, `-sto`, `-osl`, `-cph` | Helsinki, Stockholm, Oslo, Copenhagen | local zone | 60.2 / 59.3 / 59.9 / 55.7 N | eu-north |
| `BHS5` (`ca-east-bhs`) | Beauharnois (Montreal), CA | 1-AZ | 45.3, -73.9 | us-east (nearest) |
| `US-EAST-VA-1` (`us-east-vin`, Vint Hill) | Virginia, US | 1-AZ | 38.7, -77.7 | us-east |
| `US-WEST-OR-1` (`us-west-hil`, Hillsboro) | Oregon, US | 1-AZ | 45.5, -123.0 | us-west |
| `SGP1` (`ap-southeast-sgp`) | Singapore | 1-AZ | 1.35, 103.8 | ap-southeast |
| `SYD1` (`ap-southeast-syd`) | Sydney, AU | 1-AZ | -33.9, 151.2 | ap-southeast (alt) |
| `AP-SOUTH-MUM` | Mumbai, IN | 1-AZ | 19.1, 72.9 | none |

- OVH uses two naming schemes: older trigram ids (`GRA11`, `SBG5`, `DE1`, `UK1`, `WAW1`, `SGP1`, `SYD1`,
  `BHS5`) and newer slug ids (`EU-WEST-PAR`, `US-EAST-VA-1`). `GET /v2/publicCloud/project/{id}/reference/region`
  is the truth per project. The local-zone ids are inferred from the provider doc example
  `EU-WEST-LZ-LUX-A` and are unverified. The `eu-west-*` / `us-*-vin` slugs are infrastructure names, and the
  mapping to the trigram ids (DE1 = Limburg, UK1 = Erith) comes from search summaries, so treat it as unverified.
- **A region must be activated on the project first:** `POST /cloud/project/{id}/region` ("Request access to a
  region"), Terraform `ovh_cloud_project_region`. The v2 reference reports `regionActivated`.
- **Which account sees which regions:** the US site page lists BHS, TOR, HIL (Seattle) and VIN (Washington DC)
  plus the European regions; whether a US (`ovh-us`) or CA account may use EU regions, and the reverse, is
  **unverified**. The US catalogue has its own plan codes (`project`, not `project.2018`).
- Location suffixes in the catalogue (`.LZ.EU`, `.LZ.AF`, `.3AZ`) carry their own prices. For b3-8 in EUR they
  equal the standard price.

### 7. Prices

Public, **unauthenticated catalogue**:
`GET https://eu.api.ovh.com/v1/order/catalog/public/cloud?ovhSubsidiary=<IE|DE|FR|GB|CA|...>`
(US: `https://api.us.ovhcloud.com/1.0/order/catalog/public/cloud?ovhSubsidiary=US`). About 8 MB.
- Shape: `{catalogId, locale:{currencyCode, subsidiary, taxRate}, plans[], addons[], products[],
  planFamilies[]}`. A flavor is an `addons[]` row with `planCode` `<flavor>.consumption` (hourly) or
  `<flavor>.monthly.postpaid` (monthly), `product: "publiccloud-instance"`, `blobs.technical` (`cpu.cores`,
  `memory.size` in GB, `storage.disks[0].capacity` in GB, `bandwidth.level` in Mbit/s) and `blobs.tags`
  (`active`, `legacy`, `savings_plans`). Variants `.3AZ`, `.LZ.EU`, `.LZ.AF` hold location prices.
- **Prices are integers in 1e-8 of the currency:** `price: 1040000` is 0.0104 EUR, `571000000` is 5.71 EUR.
  `tax` is the VAT amount in the same unit, `formattedPrice` is rounded and loses precision. Prices are
  **before VAT**.
- Currency follows the subsidiary: EUR for IE, DE and FR (same prices), GBP for GB, USD for US, CAD for CA.
  **Use IE or FR for EUR.**
- `GET /cloud/project/{id}/flavor` gives per-project ids, not prices.

Read 2026-11-21 (IE catalogue, EUR before VAT):

| Flavor | Kind | vCPU | RAM | Disk (NVMe) | EUR an hour | EUR a month | Hourly x 730 |
|---|---|---|---|---|---|---|---|
| `d2-2` | discovery (shared) | 1 | 2 GB | 25 GB | 0.0104 | 5.71 | 7.59 |
| `d2-4` | discovery | 2 | 4 GB | 50 GB | 0.0206 | 11.44 | 15.04 |
| `d2-8` | discovery | 4 | 8 GB | 50 GB | 0.0372 | 20.60 | 27.16 |
| `c3-4` | cpu, Gen 3 | 2 | 4 GB | 50 GB | 0.0457 | none | 33.36 |
| `b3-8` | general purpose, Gen 3 | 2 | 8 GB | 50 GB | 0.0512 | none | 37.38 |
| `c3-8` | cpu, Gen 3 | 4 | 8 GB | 100 GB | 0.0913 | none | 66.65 |
| `b3-16` | general purpose, Gen 3 | 4 | 16 GB | 100 GB | 0.1023 | none | 74.68 |
| `r3-16` | ram, Gen 3 | 2 | 16 GB | 50 GB | 0.0663 | none | 48.40 |
| `b2-7` (older) | general purpose | 2 | 7 GB | 50 GB | 0.0709 | 25.17 | 51.76 |
| `s1-2`, `vps-ssd-1` (`legacy` tag) | | 1 | 2 GB | 10 GB | 0.0088 | 3.29 | 6.42 |

- `d2` is the cheapest `active` line ("Discovery": shared, no guaranteed resources). `b3-8` is the smallest
  Gen 3 flavor with guaranteed resources. The `s1` and `vps-ssd` flavors carry the `legacy` tag; do not
  offer them. The d2 monthly rate is 25% below hourly x 730, not 50%.
- Snapshot 0.011 EUR/GB/month; classic volume 0.042; outgoing bandwidth 0.
- `d2-2` hourly / monthly in other currencies: USD 0.0129 / 7.08, GBP 0.009 / 4.92, CAD 0.0167 / 9.14.
- Whether each flavor exists in each region is **unverified** (the catalogue is global). The v2
  `GET /v2/publicCloud/project/{id}/reference/productAvailability?type=INSTANCE` (login needed) returns per
  location `stockStatus` and `quotaStatus`.

### 8. Project and app mapping

- A **Public Cloud project** holds servers, keys and networks. Its `service_name` is the project id. The id's
  format (a 32-character hex string) is from memory and unverified.
- **Free to create:** the catalogue's `project`, `project.2018` and `project.discovery` plans cost 0 to
  install and 0 to renew. A project is created through the **order workflow** (`POST /order/cart`, assign,
  add the `cloud` product `project.2018`, `project` in the US, checkout) and needs a default payment method
  (provider doc of `ovh_cloud_project`). Terraform ends one through terminate plus an emailed confirmation
  token; deleting a US project is not supported in Terraform. v1 has no `POST /cloud/project`. The normal
  route is: the user creates the project in the control panel and gives OpsCrew its id.
- **One project can host many apps.** Quotas are per project and per region; the project count per account is
  also capped (support ticket).
- **Quota:** default numbers are **not published** ("limited by default for security reasons"); purchasable
  tiers exist (for example 20 VMs, 40 cores, 430 GB RAM). A warning shows at 80% use. Free-trial accounts
  have limited increases until the first paid invoice. Read it with
  `GET /cloud/project/{id}/region/{region}/quota` or `GET /v2/publicCloud/project/{id}/quota`.
- **Finding an app's servers:** an instance has a **name only**. The v1 `cloud.instance.Instance` and the v2
  `InstanceTargetSpec` have no tags, labels or metadata field, and `PUT` only renames. OpsCrew encodes the app
  in the instance name and lists by prefix, as it does for Contabo. Instance names are not unique.
- SSH key names are unique per project (provider doc of `ovh_cloud_ssh_key`).

### 9. Ubuntu 24.04 image, default user, cloud-init

- Images are listed per region: `GET /cloud/project/{id}/image?region=...` (v1) or
  `/v2/publicCloud/project/{id}/reference/instance/image?region=...`. Ids are UUIDs and differ per region.
  The name is the distribution and version; OVH's own examples write **"Ubuntu 24.04"**. The exact string is
  unverified; look it up by name per region.
- The v2 image has `defaultUser` (for example `ubuntu`, `almalinux`), and the getting-started guide says a
  sudo user named after the image is created (`ubuntu`, `debian`, `fedora`). Ubuntu 24.04 should give
  `ubuntu` (unverified on a live image).
- **A public SSH key is required** for every non-Windows instance (RSA, ECDSA or ED25519, kept in all regions).
- **cloud-init:** supported. v1 create takes `userData` ("Configuration information or scripts to use upon
  launch"), v2 a base64 `userData`, Terraform `user_data`, 65535 bytes max. That it runs `#cloud-config`
  exactly as on Hetzner is unverified.
- **Time to ACTIVE:** the guide says "Delivery may take a few minutes". Measured seconds are unverified.

### 10. Errors and limits

- **Error shape** (go-ovh `error.go`): JSON `{ "class": "Client::BadRequest", "message": "...", "details":
  {...} }` plus an `X-Ovh-QueryID` response header. Seen in this read: `Client::Unauthorized` "You must login
  first" and `Client::BadRequest` "invalid ovhSubsidiary". A missing right adds `details` keys
  `unauthorizedActionsByAuthentication` and `unauthorizedActionsByIAM`; for a consumer key the message is
  `This call has not been granted`.
- **Rate limits:** none stated in the pages I read. Unverified.
- **Out of stock or quota:** no error text was documented. The v2 API can answer **before** a create:
  `GET /v2/publicCloud/project/{id}/reference/productAvailability` returns per model and location
  `stockStatus` (`AVAILABLE`, `LOW`, `OUT_OF_STOCK`, per availability zone), `quotaStatus` (`SUFFICIENT`,
  `INSUFFICIENT`, `UNKNOWN`), `quotaLimitedBy` (`INSTANCES`, `CORES`, `RAM`, ...) and `regionActivated`.
  The real failure text of a create is **unverified**; a failed create shows as `resource_status = ERROR` with
  the failed task's summary, which the provider reports.
- **Idempotency:** no create key. v2 has a `checksum` (optimistic concurrency, HTTP 409 `ChecksumMismatch`
  on a stale update). Names are not unique, so list by name before retrying a create.
- **Delete protection:** v2 has `LOCK` and `UNLOCK` actions and a `locked` flag (OpenStack lock). Whether a
  locked instance refuses `DELETE` is unverified. There is no `deletionProtection` field on instances; it
  exists only on managed database clusters.
- **Resize:** v1 `POST /cloud/project/{id}/instance/{id}/resize {flavorId}`, and the Terraform in-place
  `flavor_id` change; v2 `GET .../instance/{id}/compatibleFlavor` lists the allowed targets. Statuses pass
  through `RESIZE` and `VERIFY_RESIZE`. Whether a downgrade is allowed and how long the server is offline is
  unverified.
- **Remove:** `DELETE /cloud/project/{id}/instance/{id}` (v1) ends hourly billing at once; the instance goes
  through `DELETING` and `DELETED`. Snapshots, backups, volumes and SSH keys stay.
- Statuses: v1 `BUILD`, `ACTIVE`, `SHUTOFF`, `SHELVED`, `SHELVED_OFFLOADED`, `ERROR`, `RESIZE`,
  `VERIFY_RESIZE`, `SNAPSHOTTING`, `DELETING`; v2 `resourceStatus` `CREATING`, `READY`, `UPDATING`,
  `DELETING`, `ERROR`, `OUT_OF_SYNC` and `powerState` `ACTIVE`, `SHUTOFF`, `SHELVED`, `PAUSED`, `SUSPENDED`,
  `RESCUE`.

### What this means for OpsCrew

- **Provider: `ovh/ovh`** (MPL-2.0, partner tier, on the OpenTofu registry) with the new `ovh_cloud_*`
  resources: `ovh_cloud_instance`, `ovh_cloud_ssh_key`, `ovh_cloud_security_group`,
  `ovh_cloud_instance_snapshot`. Pin the version (2.25.0 today): a new minor comes every one to three weeks
  and some of these are beta APIs.
- **Hourly only in the first plugin.** `ovh_cloud_instance` has no billing period. Hourly is per second after
  one minute, so a delete ends the cost at once, unlike Contabo. Offer monthly later through the legacy
  resource. Say in the plan that Gen 3 (b3, c3, r3) has no monthly price and that d2 monthly saves 25%.
- **Cost display:** hourly rate and the 730-hour figure, from a dated static table built from the catalogue
  (integers in 1e-8 units, before VAT, subsidiary IE or FR for EUR).
- **Credentials:** prefer an OAuth2 service account (`OVH_ENDPOINT`, `OVH_CLIENT_ID`, `OVH_CLIENT_SECRET`)
  with an IAM policy limited to the one project URN and the `publicCloudProject:apiovh:*` actions OpsCrew
  needs. The alternative is an application key whose access rules are limited to `/cloud/project/{id}/*` and
  `/v2/publicCloud/project/{id}/*`. Neither secret has a prefix a scanner can match, so redact the exact values
  OpsCrew holds. Check on a live account that a service account works for the `/v2/publicCloud` routes.
- **The user creates the project** (free, control panel, needs a payment method) and gives OpsCrew its id;
  OpsCrew never orders one. It does **activate the region** on the project and should call
  `reference/productAvailability` before a create to catch a missing region, no stock or no quota.
- **Firewall path:** always create an `ovh_cloud_security_group` (ingress 22, 80, 443 as chosen, IPv4 and IPv6
  rules) and pass `security_group_ids`. Never rely on the default group, which OVH's CLI guide shows as
  allow-all. The Network Firewall product is not used.
- **No tags:** the app lives in the instance name. Discovery and removal list by name prefix, and a retried
  create lists first (names are not unique, no idempotency key). Keep the `opscrew-` prefix on the SSH key and
  security group names too.
- **`user_data` changes destroy data:** a later cloud-init change reinstalls the server and wipes the disk, and
  an import loses it. Treat user data as fixed after create and warn on any image or user-data change.
- **Removal:** a delete is real and immediate, so the typed confirmation needs no billing-end date, but it must
  list what stays behind. **Snapshots, backups and volumes outlive the server and keep billing** (0.011
  EUR/GB/month for a snapshot), so removal deletes OpsCrew's own snapshots and backup images only on request.
  A stopped server keeps charging in full; a shelved hourly one charges only its snapshot.
- **Snapshots** are per GB-month and immutable in Terraform. Automated backups use the legacy workflow
  resource, and deleting the workflow keeps the images.
- **Regions:** eu-central to DE1 and WAW1, eu-west to GRA11, SBG5, EU-WEST-PAR and UK1, us-east to
  US-EAST-VA-1 (BHS5 nearby), us-west to US-WEST-OR-1, ap-southeast to SGP1 (SYD1 second). eu-north exists
  only as local zones (Helsinki, Stockholm, Oslo, Copenhagen) whose flavors and ids need a live check. US and
  CA accounts are separate zones with their own endpoint and currency, so the setup must ask which zone the
  account is in.
- **To test live:** per-region flavor and image ids, the real no-stock and quota error texts, a new project's
  default quota, `locked` as delete protection, the Ubuntu 24.04 image name, IPv6 on the image, and the service
  account on `/v2/publicCloud`. A live test create costs under one cent an hour (`d2-2`, 0.0104 EUR).

### Checked again by the lead (2026-11-21)

- The Terraform registry answers `ovh/ovh` 2.25.0, published 2026-11-13T15:54:48Z.
- `docs/resources/cloud_instance.md` on the provider's `master`: `service_name` is required and
  recreates the instance when changed. Unlike the legacy `ovh_cloud_project_instance`, it has no
  `OVH_CLOUD_PROJECT_SERVICE` fallback. There is no billing-period argument. `security_group_ids`
  omitted applies the project's `default` group, and `[]` applies none. `user_data` set to `""`
  reinstalls the instance, while removing the argument doesn't. Changing `image_id` wipes the root
  disk. Changing `flavor_id` resizes in place.
- The IE catalogue (`locale`: EUR, subsidiary IE, tax rate 23), read through Node, gives:
  - `d2-2`: 0.0104 an hour, 5.71 a month;
  - `d2-4`: 0.0206 an hour, 11.44 a month;
  - `d2-8`: 0.0372 an hour, 20.60 a month;
  - `b3-8`: 0.0512 an hour, with no monthly line.
- The provider's index page lists `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET` for service accounts,
  `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET` and `OVH_CONSUMER_KEY` for application keys, and
  `OVH_ACCESS_TOKEN`.

## R2. The lead's decisions for OVHcloud (2026-11-21)

These are technical choices the brief leaves to the lead. Each one gives its reason. A product
question goes to the founder in an issue instead.

1. **Terraform: `ovh/ovh` `~> 2.25.0`, the new `ovh_cloud_*` family.**
   - The module uses `ovh_cloud_instance`, `ovh_cloud_ssh_key` and `ovh_cloud_security_group`, plus
     the data sources `ovh_cloud_instance_flavors` and `ovh_cloud_instance_images`. These resolve the
     flavor name (`d2-2`) and the image name per region, since ids differ per region.
   - OVH's migration guide deprecates the legacy family, which warns on every plan. Its provider
     docs push the new one.
   - The OpenStack provider would need a Keystone user per project and one provider block per region.
2. **Hourly billing only**: `{ model: "hourly", counts: "second", setupFee: false }`.
   - The new instance resource has no billing period.
   - Hourly is metered per second after one minute and ends at the delete. A removal then costs
     nothing more, unlike Contabo's term.
   - Monthly billing (the legacy resource, or `activeMonthlyBilling`) is left for later, if users ask.
     The guide says d2's monthly rate saves 25%, and that Gen 3 has no monthly rate.
3. **Plans offered**: `d2-2`, `d2-4` and `d2-8` (Discovery: shared CPU, the cheapest active line), and
   `b3-8` and `b3-16` (General Purpose Gen 3: guaranteed resources).
   - `s1` and `vps-ssd` carry the catalogue's `legacy` tag and are never offered.
   - Prices come from a dated static table read from the IE catalogue. The connector reads the public
     catalogue live when OVHcloud's credentials are set, like the other providers' live prices: an
     offline run stays offline.
4. **Credentials: an OAuth2 service account, as a set** (`mode: "all"`):
   - `OVH_ENDPOINT`, which must be `ovh-eu`;
   - `OVH_CLIENT_ID` and `OVH_CLIENT_SECRET`;
   - `OVH_CLOUD_PROJECT_SERVICE`, the project id.

   Reasons:
   - It is the provider's first-listed method, and it works with OVHcloud's IAM. An IAM policy limits
     it to the one project's URN and the `publicCloudProject` actions OpsCrew needs (constitution IV:
     the narrowest scope that works).
   - Application keys add a third secret and a consumer-key validation step. They aren't offered in
     035.
   - None of the values has a recognisable format, so `tokenRules` is empty, as for Contabo, and the
     redactor masks the exact values.
   - The project id is not secret, but it is masked too, since it names the account's project.
   - The variable names are the provider's own, so the engine reads them with no copying.
5. **The project id reaches the module as a root variable passed only as `TF_VAR_*`.**
   - `ovh_cloud_instance`, `ovh_cloud_ssh_key` and `ovh_cloud_security_group` each need
     `service_name`, and the contract has no place for a value per app that isn't a server variable.
   - The smallest change: an optional `ProviderTerraform.rootVariables`. It lists variables the
     module calls read (`var.<name>` in `moduleArguments`), each with its description and the
     credential variable it comes from.
   - iac-templates declares them in the root. The agents pass them to the engine only as `TF_VAR_*`
     from that variable, never into `terraform.tfvars.json` or another committed file, as the
     own-server address already travels (`TF_VAR_server_ipv4`).
   - It touches shared files: `packages/contracts`, the registry's validation, `iac-templates` and
     the agents' engine environment. So it waits for an `[035]` issue to the core's lead.
6. **The account's zone: `ovh-eu` only in 035.**
   - `ovh-ca` and `ovh-us` are separate accounts with their own currencies (CAD, USD), plan codes and
     regions, and which regions each zone may use is unverified.
   - Another zone is refused with a plain message naming `ovh-eu`.
   - Supporting them later is a new price table and region check, not a new design.
7. **Regions.** Every OpsCrew region must map to a location (the registry's check).
   - eu-central → `DE1`, `SBG5`, `GRA11`, `WAW1`;
   - eu-north → `WAW1`, with a note: the Nordic local zones' flavors and ids are unverified, so
     Warsaw is the nearest standard region;
   - us-east → `BHS5`, with a note: Beauharnois, near Montreal. OVHcloud's US regions belong to
     OVHcloud US, a separate account;
   - us-west → `BHS5`, with the same note, saying it is far from the US west coast;
   - ap-southeast → `SGP1`, `SYD1`.

   Whether an `ovh-eu` project can use `BHS5`, `SGP1` and `SYD1` is checked live (R3).
8. **Regions are activated by the user, not by OpsCrew.**
   - With the credentials set, the connector's catalogue reads
     `GET /v2/publicCloud/project/{id}/reference/productAvailability`. It marks an offer unavailable
     where the region isn't activated, the stock is out, or the quota is insufficient, so design
     (which keeps only available offers) never proposes it there.
   - Its `verifyCredentials` lists the project's activated regions, with the control panel's path to
     add one, in the message `opscrew init` and provision already show.
   - An apply refused anyway goes through provision's existing path for an unavailable size
     (`offering.unavailable`). A check of every new server's offer before the plan was the other
     option. It would change provision for every provider, a shared change this feature doesn't
     need (changed by the lead on 2026-11-21, while writing the spec).
   - Activating a region through the plan (`ovh_cloud_project_region`) would fail on a region already
     active, and it changes the project, not the app. Saying so is clearer than owning it.
9. **Firewall: managed by Terraform** (`connectorFirewall: false`).
   - Each server has an `ovh_cloud_security_group` named `opscrew-<app>`, with the same inbound rules
     as Hetzner's (SSH from the allowed CIDRs, 80 and 443 for the web, IPv4 and IPv6).
   - `security_group_ids` is always set explicitly, never omitted: the `default` group is documented
     as open.
   - SecOps reads the group's `rule` list, and its attachment from the instance's
     `security_group_ids` or, before apply, from the plan's configuration references, as Contabo's
     does for its wanted firewall.
10. **No provider backups in 035** (`providerBackups: false`, `backupPercent: 0`).
    - OVH's automated backups are the legacy `ovh_cloud_project_workflow_backup`. Its images outlive
      both the workflow and the server and keep billing per GB.
    - OpsCrew's own data snapshots, with their encrypted copy off the server (024), cover the need.
      The runbook then points to them, as for any provider without backups (T2616).
11. **Snapshots** are priced `{ kind: "per-gb", perGbMonth: 0.011, perGbHour: 0.000015 }` in EUR.
    `serverSnapshotsOutliveServer: true`, so the destroy offers one, and its texts say it keeps billing
    until deleted in the control panel.
12. **Removal: `delete`. No delete protection, and no resize in 035.**
    - Whether `locked` refuses a delete is unverified.
    - Resize downgrades and how long the server is offline are unverified. A change of plan is
      refused with a move to a new server (023's retarget), as on Contabo.
    - The live pass may turn either on, with its facts recorded here.
13. **Finding an app's servers by name.** OVH instances have no tags or metadata.
    - The app's server is named `<app>`, an extra one `<app>-<name>`, the SSH key `<app>-deploy` and
      the security group `opscrew-<app>`.
    - `findAppServers` lists the project's instances and matches those names exactly. A create is
      never retried blindly, because names are not unique and there is no idempotency key: the same
      takeover check as Contabo's (026's generic takeover of a lost server).
14. **What reinstalls the server is ignored after create:** `lifecycle.ignore_changes` on `user_data`,
    `image_id` and `ssh_key_name`. A change of either of the first two wipes the disk, and the third
    recreates the server.
15. **The first-boot user:** OVH's Ubuntu images create the user `ubuntu` with the SSH key. The shared
    cloud-init makes `deploy` and closes root and password logins as on the other providers. Whether
    it also has to lock `ubuntu` is a plan question, settled by reading the shared cloud-init.

## R3. To check on the live pass (needs an OVHcloud account, so the founder's go-ahead)

- An `ovh-eu` service account with an IAM policy on one project works on every `/v2/publicCloud`
  route the module and the connector use (provider issue #1592 shows a 404 gap elsewhere).
- The access token's lifetime.
- The image name `Ubuntu 24.04` in each region, its default user `ubuntu`, a public IPv6 by default,
  and the shared cloud-init running unchanged.
- Each offered flavor in each mapped region, and whether `BHS5`, `SGP1` and `SYD1` are open to an
  `ovh-eu` project.
- The default quota of a new project, and the real error texts of a create with no stock and with
  no quota (for `offering.unavailable` and `offering.serverLimit`, which are patterns until then).
- The `default` security group really is open, and an explicit group really closes the rest.
- The time to `ACTIVE`.
- `locked` as delete protection.
- Resize up and down, and how long the server is offline.
- The rate limits.
- A shelved and a stopped instance on the invoice.
