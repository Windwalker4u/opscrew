# Research: Microsoft Azure Managed-Services Target (Feature 038)

**Date:** 2026-11-26 | **Issue:** `#45` | **Scope:** Research only (no code) preparing OpsCrew's Azure managed-services design (038).  
**Reference region for all prices:** East US (`eastus`, Pay-As-You-Go Linux, 730 hours/month unless stated otherwise).  
**Honesty rule:** Every figure cites official Microsoft Azure documentation, pricing pages, or verified provider releases checked on **2026-11-26**. Any detail not directly confirmed in an official source is explicitly marked **unverified**.

---

## R1. Compute for a Web App

### Summary comparison (small app in `eastus`, 1 region)

| Option | Small-app monthly estimate (`eastus`) | Cold starts | Key limits & fit for OpsCrew |
|---|---|---|---|
| **Azure Container Apps (Consumption plan)** | Per-second rates (**unchecked** on the cited page): Active `$0.000024/vCPU-s` (`~$0.0864/vCPU-hr`) + `$0.000003/GiB-s`; Idle warm replica `$0.000003/vCPU-s` + `$0.000003/GiB-s`; Requests `$0.40/1M`; monthly free grant per subscription `180,000 vCPU-s + 360,000 GiB-s + 2M requests` (**unchecked**). Resulting estimate for a single 0.25 vCPU / 0.5 GiB warm replica: **~$2–$15/mo** (or **$0** if scaled to 0 when idle) — **unchecked**. | Scales to 0 (seconds to cold-start on HTTP) or keep `minReplicas = 1` for zero cold starts | **Best default for containerized web apps + workers + cron jobs (Container Apps Jobs).** Built-in HTTPS ingress, free managed TLS certs, revision traffic splitting, KEDA auto-scaling, VNet integration, and no extra load balancer fee. |
| **Azure App Service (Linux Basic `B1`)** | **`~$0.018/hr` (`~$13.14–$13.50/mo`)** for 1 vCore, 1.75 GiB RAM (flat hourly cap; built-in HTTPS & free App Service Managed Certificates). Production slots/auto-scale require Standard `S1` or Premium `P0v3` (**unverified** exact 2026-11 `P0v3` rate). | None (always on with Always On enabled) | Clean flat-rate option for steady single-container web apps, Laravel/PHP, or Node/Python when predictable billing beats scale-to-zero. Not ideal for arbitrary background worker fleets. |
| **Azure Virtual Machine + Compose** | Burstable `Standard_B1s` / `B2ts_v2` (**unverified** exact 2026-11 East US meter) + managed OS disk + Standard Public IPv4 (`~$3.65/mo`). | None (always on) | Fits OpsCrew's existing VPS/Compose seam for `retarget --to azure` or cost-sensitive single-server apps. |
| **Azure Kubernetes Service (AKS)** | Out of scope for v1 (per roadmap). | — | Only for users bringing their own cluster later. |

### Architectural recommendation for OpsCrew 038
- **Lean preset:** **Azure Container Apps (Consumption)** (`minReplicas = 0` for staging/previews, `minReplicas = 1` for prod) — zero ALB cost, built-in managed certificates, native background workers & scheduled Jobs, generous free grant. Offer **App Service B1** (`~$13/mo` flat) as a predictable always-on alternative.
- **Balanced / Production-HA preset:** **Azure Container Apps** (Dedicated workload profile or zone-redundant VNet-integrated Consumption environment with `minReplicas >= 2`).

### Citations (R1)
- Azure Container Apps pricing: https://azure.microsoft.com/en-us/pricing/details/container-apps/ (checked 2026-11-26)
- Azure App Service pricing (Linux): https://azure.microsoft.com/en-us/pricing/details/app-service/linux/ (checked 2026-11-26)

---

## R2. Managed Databases and Caches

### Smallest sizes & baseline pricing (`eastus`, Pay-As-You-Go)

| Service | Engine | Smallest size | Compute price (`eastus`) | Storage / backups | Estimated monthly floor |
|---|---|---|---|---|---|
| **Azure Database for PostgreSQL – Flexible Server** | PostgreSQL | Burstable `Standard_B1ms` (1 vCore, 2 GiB RAM) | `~$0.017/hr` (**~$12.41/mo**, **unchecked**) | `$0.115/GiB-mo` (**unchecked**; 32 GiB min = `~$3.68/mo`); backup storage up to **100% of provisioned server storage is free** | **~$16/mo** (**unchecked**; Zone-redundant HA roughly **2×** compute + storage) |
| **Azure Database for MySQL – Flexible Server** | MySQL | Burstable `Standard_B1ms` (1 vCore, 2 GiB RAM) | `~$0.017/hr` (**~$12.41/mo**, **unchecked**) | `$0.115/GiB-mo` (**unchecked**) + free backup storage up to 100% of provisioned storage | **~$16/mo** (**unchecked**; HA roughly **2×**) |
| **Azure Managed Redis** *(replaces retiring Azure Cache for Redis)* | Redis Enterprise (Valkey not offered as a separate managed Azure SKU as of 2026-11 — **unverified** if Valkey is planned) | Balanced **`B0`** (smallest tier; no geo-replication) | `~$0.016/hr` single-node (**~$13.14–$13.87/mo**); **HA (2 nodes): `~$26.28/mo`**; Balanced `B1`: `~$25.55/mo` single / `~$51.10/mo` HA (all `B0`/`B1` prices **unchecked**) | Included in tier memory | **~$13–$14/mo** single-node dev/test; **~$26/mo** HA prod (**unchecked**) |

### Critical 2026 Azure Cache for Redis retirement notice
- Microsoft is retiring legacy **Azure Cache for Redis** in favor of **Azure Managed Redis** (`azurerm_managed_redis`):
  - **Enterprise & Enterprise Flash tiers:** new creation blocked `2026-04-01` (**unverified** date), retirement **2027-03-31**.
  - **Basic, Standard, & Premium tiers:** new creation blocked/restricted starting `2026-04-01` (**unverified** date), retirement **2028-09-30**.
- **OpsCrew 038 must provision Azure Managed Redis (`azurerm_managed_redis`), never legacy `azurerm_redis_cache`.**

### Backups, restores, and Entra ID auth
- **PostgreSQL / MySQL Flexible Server backups & restore drills:**
  - Automated daily backups with **Point-In-Time Restore (PITR)** (7–35 days retention, geo-redundant optional) and on-demand backups (`azurerm_postgresql_flexible_server_backup`).
  - Restores always create a **new Flexible Server** in a private VNet/subnet, making OpsCrew's throwaway restore drill (ADR 0034) straightforward: restore to a temporary server, run health/schema check, delete temporary server.
- **Microsoft Entra ID authentication:** Supported on PostgreSQL Flexible Server, MySQL Flexible Server, and Azure Managed Redis (`managed_redis_access_policy_assignment`). As on AWS, standard `DATABASE_URL`/`REDIS_URL` drivers expect static passwords unless using an Entra token-refresh helper, so static credentials stored in Key Vault remain the zero-code-rewrite default.

### Citations (R2)
- Azure Database for PostgreSQL Flexible Server pricing: https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/ (checked 2026-11-26)
- Azure Database for MySQL Flexible Server pricing: https://azure.microsoft.com/en-us/pricing/details/mysql/flexible-server/ (checked 2026-11-26)
- Azure Managed Redis pricing & SKUs (`B0`, `B1`): https://azure.microsoft.com/en-us/pricing/details/managed-redis/ and https://learn.microsoft.com/en-us/azure/redis/overview (checked 2026-11-26)
- Azure Cache for Redis retirement schedule: https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/cache-retirement (checked 2026-11-26)

---

## R3. Storage, Secrets, DNS, TLS, and the Edge (Beside Cloudflare)

| Service | Pricing (`eastus`) | Role & OpsCrew recommendation |
|---|---|---|
| **Azure Blob Storage (LRS)** | Hot: **`~$0.018–$0.0208/GB-mo`** (first 50 TB); Cool: `~$0.010–$0.0152/GB-mo` (30-day min); Cold: `~$0.0036–$0.0045/GB-mo` (90-day min); Archive: `$0.00099/GB-mo` (180-day min) + transactions & egress. | App uploads, static assets, and encrypted off-server snapshots (private containers accessed via Managed Identity or SAS tokens). |
| **Azure Key Vault (Standard)** | **$0/mo base fee**; **`$0.03 per 10,000 operations`** for secrets, software keys, and certs (`$3.00` per managed cert renewal; Premium/Managed HSM `$2,300+/mo`) — all Key Vault rates **unchecked** on the cited pricing page. | Huge cost advantage over AWS Secrets Manager (`$0.40/secret/mo`) — OpsCrew can store individual secrets in Standard Key Vault at low per-operation cost and bind them directly to Container Apps via Managed Identity. |
| **Azure DNS** | **$0.50/zone/month** (first 25 zones; `$0.10` thereafter) + `$0.40/million` queries (first 1B). | Optional — not required when DNS stays at Cloudflare. |
| **TLS Certificates** | **Azure Container Apps Managed Certificates** & **Azure Front Door Managed Certificates** are **free** (auto-renewed). | Prefer built-in free managed certificates on Container Apps / Front Door over Key Vault paid renewals. |
| **Azure Front Door (Standard)** | **$35.00/mo base fee per profile** + `$0.009/10k` requests + `$0.0825/GB` edge-to-client (Zone 1) + `$0.02/GB` edge-to-origin (all Front Door Standard & Premium `$330/mo` prices **unchecked** on the cited pricing page). | Joins OpsCrew's 036 edge contract for enterprise/multi-region Azure apps, **NOT** the lean default (because of the base profile fee). |

### Keeping DNS at Cloudflare
- **Container Apps custom domains + Cloudflare:**
  1. Azure requires a TXT record `asuid.<subdomain>` (or `asuid` for apex) containing the Container App Environment's custom domain verification ID, plus a CNAME pointing `<subdomain>` to `<app>.<region>.azurecontainerapps.io` (or A record to the environment static IP for apex).
  2. **Critical Cloudflare rule:** During initial validation and managed certificate issuance, set the Cloudflare record to **DNS-only (gray cloud)** — orange-cloud proxying intercepts Azure's HTTP/TXT validation and leaves the managed certificate stuck in `Pending`.
  3. Once issued, either stay DNS-only (direct to Container Apps HTTPS) or front with Cloudflare proxied (Full Strict) — note Azure Container Apps IP restrictions can limit ingress to Cloudflare's published IP ranges.
- **Azure Front Door + Cloudflare DNS:** Add Front Door's `_dnsauth.<domain>` TXT validation record (DNS-only) and point the traffic CNAME to `<endpoint>.z01.azurefd.net` (keep gray-cloud DNS-only when Front Door is the chosen edge to avoid double-CDN latency).

### Citations (R3)
- Azure Blob Storage pricing: https://azure.microsoft.com/en-us/pricing/details/storage/blobs/ (checked 2026-11-26)
- Azure Key Vault pricing: https://azure.microsoft.com/en-us/pricing/details/key-vault/ (checked 2026-11-26)
- Azure DNS pricing: https://azure.microsoft.com/en-us/pricing/details/dns/ (checked 2026-11-26)
- Azure Front Door pricing: https://azure.microsoft.com/en-us/pricing/details/frontdoor/ (checked 2026-11-26)
- Azure Container Apps custom domains & `asuid` TXT verification: https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates (checked 2026-11-26)

---

## R4. Keyless Deploys from GitHub Actions (Workload Identity Federation)

No client secret (`AZURE_CREDENTIALS` JSON password) is ever stored in GitHub Secrets. OpsCrew provisions a **User-Assigned Managed Identity** (preferred over App Registration) scoped via Azure RBAC to the app's Resource Group, and attaches an **`azurerm_federated_identity_credential`** trusting `https://token.actions.githubusercontent.com`:

```hcl
resource "azurerm_federated_identity_credential" "github_deploy" {
  name                = "opscrew-${var.app}-${var.environment}"
  resource_group_name = azurerm_resource_group.app.name
  parent_id           = azurerm_user_assigned_identity.deploy.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_owner}/${var.github_repo}:environment:${var.github_environment}"
}
```

### Critical constraints
1. **Case-sensitive subject matching (**unverified**):** Microsoft Entra ID is expected to match `subject` case-sensitively (`Production` ≠ `production`, `AADSTS700213`) — marked **unverified** on the cited doc; OpsCrew should still emit exact-case environment names from GitHub.
2. **GitHub 2026-07-15 immutable subject claims:** Repos created on/after `2026-07-15` emit `repo:<OWNER>@<OWNER_ID>/<REPO>@<REPO_ID>:environment:<ENV>`; OpsCrew must format `subject` to match the repository's actual OIDC subject format.
3. **Hard limit:** Standard federated credentials are capped at **20 per Managed Identity / App Registration** (sufficient when each app environment owns its own Managed Identity; Microsoft Entra Flexible Federated Identity Credentials with `claimsMatchingExpression` lift this cap if needed).
4. **GitHub Free private repos (no environments):** Scope `subject` to `repo:<OWNER>/<REPO>:ref:refs/heads/<branch>`.
5. **Workflow step:** `permissions: { id-token: write, contents: read }` with commit-pinned `azure/login` passing `client-id`, `tenant-id`, and `subscription-id` (all non-secret IDs).

### Citations (R4)
- Microsoft Learn — Configure a federated identity credential on a user-assigned managed identity for GitHub Actions: https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity (checked 2026-11-26)
- Microsoft Learn — Flexible federated identity credentials: https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-flexible-federated-identity-credentials (checked 2026-11-26)

---

## R5. OpenTofu / Terraform Provider (`hashicorp/azurerm`) Coverage

**Current version (verified live from Terraform Registry on 2026-11-26):**
- **`hashicorp/azurerm` `5.15.0`** (published `2026-11-24T00:29:59Z`, 1,114 resource docs in `v5.15.0`).
- **Companion provider:** `azure/azapi` is available for preview Azure ARM features before `azurerm` wraps them (exact latest `azapi` version **unverified**).
- **Verified Modules:** Roadmap notes **Azure Verified Modules (AVM)** (`Azure/avm-res-*`) for vendored readable modules.

### Verified resource coverage in `hashicorp/azurerm` `v5.15.0`
- **Compute:** `azurerm_container_app`, `azurerm_container_app_environment`, `azurerm_container_app_custom_domain`, `azurerm_container_app_environment_managed_certificate`, `azurerm_container_app_job` (check exact slug when implementing — **unverified** whether job resource name changed in v5), `azurerm_linux_web_app`, `azurerm_linux_web_app_slot`.
- **Databases & Caches:** `azurerm_postgresql_flexible_server`, `azurerm_postgresql_flexible_server_database`, `azurerm_postgresql_flexible_server_backup`, `azurerm_postgresql_flexible_server_active_directory_administrator`, `azurerm_mysql_flexible_server`, **`azurerm_managed_redis`**, `azurerm_managed_redis_access_policy_assignment`.
- **Storage, Secrets, DNS, Edge:** `azurerm_storage_account`, `azurerm_key_vault`, `azurerm_key_vault_secret` (**never** write real secret values through Terraform state — populate via Azure SDK/CLI at apply time!), `azurerm_dns_zone`, `azurerm_cdn_frontdoor_profile`/`endpoint`/`origin_group`/`origin`/`custom_domain`/`firewall_policy`.
- **Identity & Networking:** `azurerm_user_assigned_identity`, `azurerm_federated_identity_credential`, `azurerm_nat_gateway`, `azurerm_public_ip`.

### Citations (R5)
- Terraform Registry `hashicorp/azurerm` `5.15.0`: https://registry.terraform.io/providers/hashicorp/azurerm/5.15.0 (queried 2026-11-26)
- `hashicorp/terraform-provider-azurerm` `v5.15.0` docs tree: https://github.com/hashicorp/terraform-provider-azurerm/tree/v5.15.0/website/docs/r (verified 2026-11-26)

---

## R6. Emulators for Automated Tests (and What Is Missing)

| Emulator | License | What it emulates | Limitations / what is missing for OpsCrew 038 |
|---|---|---|---|
| **Azurite** (official Microsoft) | MIT | Azure **Blob Storage**, **Queue Storage**, and **Table Storage** data plane | Data-plane only — no ARM control plane (`azurerm_storage_account` Terraform apply does not run against Azurite), no Key Vault, no Container Apps, no Postgres/MySQL, no Front Door, no Entra ID. |
| **Azure Cosmos DB Emulator** (official Microsoft) | Microsoft EULA | Cosmos DB data plane (`https://localhost:8081`) | **Linux container does NOT natively support Apple Silicon / ARM64 hosts**; provisioned throughput only (no serverless); hardcoded well-known master key; OpsCrew's core relational apps use PostgreSQL/MySQL rather than Cosmos DB. |
| **`floci-az`** (`floci-io/floci-az`) | MIT (956 stars, updated 2026-11-26) | Blob Storage (incl. ADLS Gen2), Queue Storage, Table Storage, SignalR Service, Azure Functions | Same gap as Azurite for OpsCrew's infrastructure layer: **no ARM control-plane emulation** for Container Apps, PostgreSQL/MySQL Flexible Server, Azure Managed Redis, Key Vault, Azure DNS, Front Door, or Entra ID / RBAC. |

### Testing strategy conclusion for Azure 038
Unlike AWS (where `floci` emulates the full Terraform control plane), **no open-source local emulator currently executes `hashicorp/azurerm` ARM control-plane plans/applies** for Container Apps, Flexible Server, Managed Redis, Key Vault, or Front Door. OpsCrew 038's automated test suite should therefore combine:
1. **OpenTofu `init` + `validate` + mocked provider / unit tests** (`tofu test` mock providers + deterministic SecOps plan policy checks) for every Terraform module;
2. **Azurite** (or `floci-az`) + real Postgres/MySQL/Redis Docker containers for data-plane & backup/restore tests;
3. **Fake HTTP Azure ARM connector tests** for OpsCrew's TypeScript connector (`@opscrew/provider-azure`);
4. An **optional gated live pass** on a throwaway Azure subscription for real OIDC + Container Apps + Flexible Server verification.

### Citations (R6)
- Azurite documentation: https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite (checked 2026-11-26)
- Azure Cosmos DB Emulator limitations: https://learn.microsoft.com/en-us/azure/cosmos-db/emulator (checked 2026-11-26)
- `floci-az` repository & supported services (MIT): https://github.com/floci-io/floci-az (fetched 2026-11-26)

---

## R7. Surprising Costs (and How to Avoid Each for a Small App)

| Surprise cost | Rate (`eastus`) | Why it surprises small apps | How OpsCrew avoids it |
|---|---|---|---|
| **Azure Front Door Standard base fee** | **`$35.00/mo`** per profile (**unchecked**; before traffic/WAF) | Adding Front Door to a small app significantly increases the fixed monthly bill. | Do not enable Front Door on `lean` plans; use Container Apps' free built-in HTTPS ingress (or Cloudflare if DNS is already there). |
| **Azure NAT Gateway** | **`$0.045/hr`** (`~$33/mo`) **+ `$0.045/GB`** processed + Public IP (`~$3.65/mo`) | Attaching a NAT Gateway to a Container Apps VNet adds `~$37/mo` idle. | Omit NAT Gateway on `lean` plans; use Container Apps' default managed outbound networking unless the user explicitly requires a static outbound IP. |
| **Azure Managed Redis HA & large SKUs** | Balanced `B0` HA is `~$26/mo`; Balanced `B10` HA jumps to **`~$460/mo`** (all Managed Redis prices **unchecked**) | Picking a mid-tier Managed Redis SKU or default HA for a tiny cache silently explodes spend. | Default small non-critical caches to single-node `B0` (`~$13/mo`, **unchecked**) or document when a Valkey container on a small VM is cheaper; show HA doubling explicitly in `plan.yaml`. |
| **Container Apps Dedicated Workload Profiles / `minReplicas` CPU** | Dedicated profiles bill full underlying VM hours 24/7 (even when idle) | Switching from Consumption to Dedicated or leaving high `minReplicas` on staging creates unexpected 24/7 compute bills. | Default to **Consumption** workload profile (`minReplicas = 0` on non-prod, `1` on prod) and cap `maxReplicas` explicitly. |
| **Log Analytics / Application Insights ingestion** | Per-GB ingestion (`~$2.30+/GB` — **unverified** exact 2026-11 East US meter; 5 GB/mo free tier historically) | Verbose Container Apps stdout logs ingested into Log Analytics can exceed compute cost. | Configure explicit retention (30 days free with Log Analytics basic retention) and warn on high-volume log sampling in `plan.yaml`. |
| **Standard Public IPv4 & Private Endpoints** | Public IPv4 `~$0.004–$0.005/hr` (`~$3–$3.65/mo`); Private Endpoints `~$0.01/hr` (`~$7.30/mo` each — **unverified** exact 2026-11 rate) + data processing | Stacking Private Endpoints across DB, Redis, Storage, and Key Vault adds `$30+/mo` in link fees alone. | Prefer VNet-delegated subnets (free for Postgres/MySQL Flexible Server) and Service Endpoints where private link is not mandated by compliance. |

### Citations (R7)
- Azure Front Door pricing: https://azure.microsoft.com/en-us/pricing/details/frontdoor/ (checked 2026-11-26)
- Azure NAT Gateway pricing: https://azure.microsoft.com/en-us/pricing/details/azure-nat-gateway/ (checked 2026-11-26)
- Azure IP Addresses pricing: https://azure.microsoft.com/en-us/pricing/details/ip-addresses/ (checked 2026-11-26)
