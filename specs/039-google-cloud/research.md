# Research: Google Cloud Managed-Services Target (Feature 039)

**Date:** 2026-11-26 | **Issue:** `#45` | **Scope:** Research only (no code) preparing OpsCrew's Google Cloud managed-services design (039).  
**Reference region for all prices:** Iowa (`us-central1`, On-Demand, 730 hours/month unless stated otherwise).  
**Honesty rule:** Every figure cites official Google Cloud documentation, pricing pages, or verified provider releases checked on **2026-11-26**. Any detail not directly confirmed in an official source is explicitly marked **unverified**.

---

## R1. Compute for a Web App

### Summary comparison (small app in `us-central1`, 1 region)

| Option | Small-app monthly estimate (`us-central1`) | Cold starts | Key limits & fit for OpsCrew |
|---|---|---|---|
| **Google Cloud Run (Services, Jobs, and Worker Pools)** | Request-based billing: **`$0.0000240/vCPU-s`** (`~$0.086/vCPU-hr`) + **`$0.0000025/GiB-s`** + **`$0.40/1M requests`** (100 ms rounding). **Always-free monthly grant:** 2M requests + 180,000 vCPU-s + 360,000 GiB-s. Scales to **$0 at idle** (`min_instance_count = 0`); 1 always-warm 1 vCPU / 512 MiB instance costs ~$15–$65/mo depending on CPU-always-allocated vs request-only billing (exact idle-instance discounted rate **unverified**). | ~0.5–3 s when scaling from 0; zero with `min_instance_count = 1` | **Best default for almost every containerized web app on GCP.** Native HTTPS endpoint, built-in zero-downtime traffic splitting, concurrency up to 1,000 req/container, WebSockets, HTTP/2 streaming, **Cloud Run Jobs** (cron/migrations), and **Cloud Run Worker Pools** (`google_cloud_run_v2_worker_pool`, dedicated background workers!). No load balancer required for simple apps. |
| **Compute Engine (`e2-micro` / `e2-small`) + Compose** | `e2-micro` (2 shared vCPU, 1 GB RAM) eligible for 1 free instance/account in `us-central1`/`us-west1`/`us-east1` (30 GB standard PD included); paid `e2-small` (~$12–$15/mo, **unverified** exact 2026-11 meter) + external IPv4 (`$0.005/hr` = `$3.65/mo`). | None (always on) | Plugs directly into OpsCrew's VPS/Compose seam for `retarget --to gcp` or tiny always-on stateful stacks. |
| **GKE (Autopilot / Standard)** | Out of scope for v1 (per roadmap; cluster management fee `$0.10/hr` = `$73/mo` beyond first free zonal/Autopilot cluster). | — | Only for users bringing their own cluster later. |

### Architectural recommendation for OpsCrew 039
- **Lean & Balanced presets:** **Cloud Run v2** (`google_cloud_run_v2_service` for web, `google_cloud_run_v2_worker_pool` for background workers, `google_cloud_run_v2_job` + Cloud Scheduler for migrations & cron). Use **Direct VPC Egress** (no billable VPC connector VMs!) to reach private Cloud SQL and Memorystore.
- **Production-HA preset:** **Cloud Run** with `min_instance_count >= 2` behind a **Global External Application Load Balancer + Cloud Armor + Cloud CDN** (or multi-region Cloud Run).

### Citations (R1)
- Google Cloud Run pricing: https://cloud.google.com/run/pricing (checked 2026-11-26)
- Google Cloud Run Worker Pools & Jobs docs: https://cloud.google.com/run/docs/overview/what-is-cloud-run (checked 2026-11-26)
- Compute Engine pricing & Free Tier: https://cloud.google.com/compute/all-pricing and https://cloud.google.com/free/docs/free-cloud-features (checked 2026-11-26)

---

## R2. Managed Databases and Caches

### Smallest sizes & baseline pricing (`us-central1`, On-Demand)

| Service | Engine | Smallest size | Compute price (`us-central1`) | Storage / backups | Estimated monthly floor |
|---|---|---|---|---|---|
| **Cloud SQL (Enterprise Edition — shared core)** | PostgreSQL, MySQL | **`db-f1-micro`** (shared vCPU, 0.6 GB RAM — **dev/test only, no uptime SLA**) | **`~$7–$10/mo`** (24/7 compute) | SSD: **`$0.17/GiB-mo`** (10 GB = `$1.70/mo`); Backups: **`$0.08/GiB-mo`** | **~$9–$12/mo** (no SLA; great for staging/lean dev) |
| **Cloud SQL (Enterprise Edition — dedicated core)** | PostgreSQL, MySQL | `db-custom-1-3840` (1 vCPU, 3.75 GiB RAM) | vCPU: **`~$0.0413/vCPU-hr`** (`~$30.15/mo`) + RAM: **`~$0.0070/GiB-hr`** (`~$19.16/mo`) | SSD `$0.17/GiB-mo`, Backups `$0.08/GiB-mo` | **~$51/mo** Single-Zone (Regional HA roughly **2×** ≈ `~$102/mo`) |
| **Memorystore for Valkey** (`google_memorystore_instance`) | **Valkey** (preferred over legacy Memorystore for Redis) | **`shared-core-nano`** (1.4 GB RAM — **dev/test only, no SLA**); smallest SLA production node: **`custom-pico`** (1.25 GB) / **`standard-small`** | `shared-core-nano`: `~$0.02–$0.03+/hr` (**~$15–$22/mo**); exact `custom-pico` / `standard-small` `us-central1` hourly rates **unverified** on 2026-11-26 (1-yr CUD -20%, 3-yr CUD -40%) | Included in node memory; AOF persistence optional | **~$15–$22/mo** dev/test (`shared-core-nano`); higher with replicas/HA |

### Backups, restores, and IAM authentication
- **Cloud SQL backups & restore drills:**
  - Automated daily backups + **Point-In-Time Recovery (PITR)** via transaction logs (up to 7 days on Enterprise, 35 days on Enterprise Plus). Unlike AWS RDS / Azure Flexible Server, Cloud SQL bills **all** backup storage at `$0.08/GiB-mo` (no free 100%-of-DB allowance).
  - **Restore drills (ADR 0034):** `gcloud sql instances clone` or restoring a backup into a **new private-IP Cloud SQL instance** lets OpsCrew verify the backup in isolation and immediately delete the clone.
- **Cloud SQL Auth Proxy & IAM authentication:** Cloud Run has a **built-in Cloud SQL Unix socket connector** (`--add-cloudsql-instances`), providing encrypted mTLS connectivity without public IPs or VPC NAT. IAM database authentication is supported for PostgreSQL and MySQL, though (as on AWS/Azure) standard `DATABASE_URL` drivers expect static passwords unless using an IAM token wrapper — so static credentials in Secret Manager remain the zero-code-rewrite default.
- **Memorystore for Valkey:** Supports RDB/AOF persistence, backups, and IAM authentication (`AUTH` with short-lived IAM tokens); requires VPC private connectivity (Cloud Run Direct VPC Egress reaches it cleanly).

### Citations (R2)
- Cloud SQL pricing (PostgreSQL & MySQL): https://cloud.google.com/sql/pricing (checked 2026-11-26)
- Memorystore for Valkey pricing & node types (`shared-core-nano`, `custom-pico`): https://cloud.google.com/memorystore/docs/valkey/pricing and https://cloud.google.com/memorystore/docs/valkey/instance-and-node-specification (checked 2026-11-26)

---

## R3. Storage, Secrets, DNS, TLS, and the Edge (Beside Cloudflare)

| Service | Pricing (`us-central1`) | Role & OpsCrew recommendation |
|---|---|---|
| **Google Cloud Storage (GCS)** | Standard (`us-central1`): `~$0.020/GB-mo` (**unverified** exact 2026-11 penny rate; historically `$0.020/GB-mo` in `us-central1`); Nearline/Coldline/Archive cheaper with 30/90/365-day minimums + retrieval fees. | App uploads, static assets, and encrypted off-server backups (uniform bucket-level access, private by default). |
| **Secret Manager** | **`$0.06` per active secret version per location/month** + **`$0.03` per 10,000 access ops** (small free tier: 6 active secret versions + 10,000 accesses/mo — **unverified** whether free tier thresholds changed in 2026). | **Much cheaper than AWS Secrets Manager** (`$0.06` vs `$0.40`), and Cloud Run mounts Secret Manager versions directly as env vars or files via the service's IAM Service Account. |
| **Cloud DNS** | **`$0.20/managed zone/month`** (first 25 zones; `$0.10` thereafter) + **`$0.40/million`** queries (first 1B). | Optional — not required when DNS stays at Cloudflare. |
| **Certificate Manager** | **Free** for Google-managed public TLS certificates (Google Trust Services / Let's Encrypt) attached to Load Balancers / Cloud CDN. (Private CA via Certificate Authority Service is paid — never create by default.) | Automated DNS-01 (`google_certificate_manager_dns_authorization`) or load-balancer-managed TLS. |
| **Cloud CDN** | Requires an **External Application Load Balancer** (`~$18+/mo` base) + cache egress (`~$0.08/GB` North America) + LB data processing (`$0.008–$0.012/GB`) + cache fill. | Joins OpsCrew's 036 edge contract for GCP apps already using a Global External ALB; **not** for lean single-service apps because of the mandatory ALB floor. |

### Keeping DNS at Cloudflare
1. **Cloud Run direct custom domain mapping + Cloudflare:**
   - Cloud Run's built-in domain mapping issues a free Google-managed cert and gives `A`/`AAAA` (apex) or `CNAME` (`ghs.googlehosted.com`) records.
   - **Critical Cloudflare rule:** Records MUST be set to **DNS-only (gray cloud)** during initial verification and certificate issuance; orange-cloud proxying blocks Google's domain verification & cert handshake.
   - Note: Google's docs recommend **Global External ALB + Certificate Manager** for production custom domains over direct Cloud Run domain mapping (which has narrower regional availability), OR fronting Cloud Run behind **Cloudflare** using a Cloudflare Worker / origin override — however, Cloud Run validates the `Host` header against mapped domains, so keeping direct domain mapping with **DNS-only** (or ALB + Certificate Manager DNS-01 CNAME in Cloudflare with gray cloud) is the cleanest path.
2. **Certificate Manager DNS-01 authorization + Cloudflare:** `google_certificate_manager_dns_authorization` outputs a `_acme-challenge.<domain>` CNAME record; OpsCrew's Cloudflare DNS adapter writes it with **`proxied = false` (gray cloud)** so issuance and auto-renewal work reliably even if the traffic record itself is orange-cloud proxied to a GCP External ALB.

### Citations (R3)
- Google Cloud Storage pricing: https://cloud.google.com/storage/pricing (checked 2026-11-26)
- Secret Manager pricing: https://cloud.google.com/secret-manager/pricing (checked 2026-11-26)
- Cloud DNS pricing: https://cloud.google.com/dns/pricing (checked 2026-11-26)
- Certificate Manager pricing & DNS authorization: https://cloud.google.com/certificate-manager/pricing and https://cloud.google.com/certificate-manager/docs/dns-authorization (checked 2026-11-26)
- Cloud CDN & Load Balancing pricing: https://cloud.google.com/cdn/pricing and https://cloud.google.com/vpc/network-pricing (checked 2026-11-26)
- Cloud Run custom domains: https://cloud.google.com/run/docs/mapping-custom-domains (checked 2026-11-26)

---

## R4. Keyless Deploys from GitHub Actions (Workload Identity Federation)

No Service Account JSON key is ever created or stored in GitHub Secrets. OpsCrew creates a **Workload Identity Pool** + **OIDC Provider** (`https://token.actions.githubusercontent.com`) with a strict **CEL `attribute_condition`**, and grants `roles/iam.workloadIdentityUser` on a dedicated least-privilege deploy Service Account:

```hcl
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.actor"       = "assertion.actor"
    "attribute.repository"  = "assertion.repository"
    "attribute.environment" = "assertion.environment"
  }

  # Mandatory: without attribute_condition, ANY GitHub repo can exchange tokens against this pool.
  attribute_condition = "assertion.repository == '${var.github_owner}/${var.github_repo}' && assertion.environment == '${var.github_environment}'"
}

resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.github_repo}"
}
```

### Critical constraints
1. **`attribute_condition` is mandatory:** Omitting it allows any public GitHub repo to mint tokens into the pool.
2. **Environment claim vs branch fallback:** `assertion.environment` is populated **only** when the workflow job declares `environment: <name>`. On GitHub Free private repos (no environments), condition on `assertion.repository == '<owner>/<repo>' && assertion.ref == 'refs/heads/<branch>'` instead.
3. **Immutable repository IDs (defense in depth):** Also consider pinning `assertion.repository_id == '<numeric_id>'` (GitHub OIDC claim) so a repo rename/transfer cannot hijack the trust binding.
4. **Workflow step:** `permissions: { id-token: write, contents: read }` with commit-pinned `google-github-actions/auth` passing `workload_identity_provider` and `service_account`.

### Citations (R4)
- Google Cloud IAM — Workload Identity Federation with GitHub Actions: https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines (checked 2026-11-26)
- `google-github-actions/auth`: https://github.com/google-github-actions/auth (checked 2026-11-26)

---

## R5. OpenTofu / Terraform Provider (`hashicorp/google`) Coverage

**Current version (verified live from Terraform Registry on 2026-11-26):**
- **`hashicorp/google` `8.12.0`** (published `2026-11-17T19:43:29Z`, 1,205 resource docs in `v8.12.0`).
- **Verified Modules:** Roadmap notes **terraform-google-modules** (`GoogleCloudPlatform/terraform-google-*`) for vendored readable modules.

### Verified resource coverage in `hashicorp/google` `v8.12.0`
- **Compute:** `google_cloud_run_v2_service`, `google_cloud_run_v2_job`, **`google_cloud_run_v2_worker_pool`**, `google_cloud_run_v2_service_iam_*`, `google_compute_instance`.
- **Databases & Caches:** `google_sql_database_instance`, `google_sql_database`, `google_sql_user`, **`google_memorystore_instance`** (Valkey), `google_redis_instance` (legacy Redis).
- **Storage, Secrets, DNS, TLS, Edge:** `google_storage_bucket`, `google_secret_manager_secret`, `google_secret_manager_secret_version` (**never** write real secret values through Terraform state — populate via Google SDK/CLI at apply time!), `google_dns_managed_zone`, `google_certificate_manager_certificate`, `google_certificate_manager_dns_authorization`, `google_certificate_manager_certificate_map`, `google_compute_backend_service`, `google_compute_backend_bucket`.
- **Identity & Networking:** `google_iam_workload_identity_pool`, `google_iam_workload_identity_pool_provider`, `google_service_account`, `google_compute_router_nat`.
- **Gaps / caveats:** Cloud Run direct custom domain mapping (`google_cloud_run_domain_mapping`) is v1/legacy and not available in all regions; prefer Certificate Manager + External ALB for multi-region/production custom domains, and handle ad-hoc Cloud SQL restore drills + Secret Manager version population in OpsCrew's typed GCP connector (outside Terraform state).

### Citations (R5)
- Terraform Registry `hashicorp/google` `8.12.0`: https://registry.terraform.io/providers/hashicorp/google/8.12.0 (queried 2026-11-26)
- `hashicorp/terraform-provider-google` `v8.12.0` docs tree: https://github.com/hashicorp/terraform-provider-google/tree/v8.12.0/website/docs/r (verified 2026-11-26)

---

## R6. Emulators for Automated Tests (and What Is Missing)

| Emulator | License | What it emulates | Limitations / what is missing for OpsCrew 039 |
|---|---|---|---|
| **Official `gcloud emulators`** | Apache-2.0 / Google SDK | **Pub/Sub**, **Firestore / Datastore**, **Spanner**, **Bigtable** | **Missing almost every core OpsCrew 039 service:** NO official emulator for **Cloud Run**, **Cloud SQL** (Postgres/MySQL), **Memorystore** (Valkey/Redis), **Cloud Storage (GCS)**, **Secret Manager**, **IAM/WIF**, **Cloud DNS**, **Certificate Manager**, or **Cloud Load Balancing**. |
| **`floci-gcp`** (`floci-io/floci-gcp`) | MIT (563 stars, updated 2026-11-26) | **GCS**, **Secret Manager**, **Cloud KMS**, **IAM & STS**, **Cloud Run** (control plane), **Cloud SQL** (PostgreSQL & MySQL), **Compute Engine / VPC / Global External ALB** (control plane), **Cloud Tasks**, **Cloud Scheduler**, **Cloud Logging**, **Cloud Monitoring**, **Pub/Sub**, **Firestore**, **Resource Manager / Billing** | No guest VM / live HTTP traffic forwarding on Compute Engine/LB; **missing** **Memorystore for Valkey**, **Cloud DNS**, and **Certificate Manager**; IAM allow-policy enforcement is opt-in on GCS only (not full GCP IAM evaluation). |

### Testing strategy conclusion for Google Cloud 039
1. **`floci-gcp` (MIT)** covers a remarkably large slice of OpsCrew 039's REST/gRPC control plane (Cloud Run, Cloud SQL, GCS, Secret Manager, IAM/STS, Cloud Scheduler, Logging/Monitoring) without any GCP account or token — worth evaluating alongside OpenTofu `tofu test` mock providers!
2. Pair with real **PostgreSQL / MySQL / Valkey** Docker containers for data-plane & backup/restore tests, plus static SecOps IAM/WIF policy checks (ensuring every `google_iam_workload_identity_pool_provider` defines a strict `attribute_condition`).
3. Keep one **optional gated live pass** on a throwaway GCP project for real GitHub WIF token exchange, Cloud Run ingress, Cloud DNS/Certificate Manager, and Memorystore for Valkey.

### Citations (R6)
- Google Cloud SDK local emulators: https://cloud.google.com/sdk/gcloud/reference/beta/emulators (checked 2026-11-26)
- `floci-gcp` repository & supported services (MIT): https://github.com/floci-io/floci-gcp (fetched 2026-11-26)

---

## R7. Surprising Costs (and How to Avoid Each for a Small App)

| Surprise cost | Rate (`us-central1`) | Why it surprises small apps | How OpsCrew avoids it |
|---|---|---|---|
| **External Application Load Balancer (required for Cloud CDN / Cloud Armor)** | **`~$0.025/hr`** per forwarding rule/proxy minimum (**~$18.25/mo** idle) + `$0.008–$0.012/GB` data processing | Adding Cloud CDN or an External ALB to a small Cloud Run service adds `$18+/mo` baseline before serving traffic. | On `lean` plans, expose Cloud Run directly (free built-in HTTPS) or put Cloudflare in front; enable External ALB + Cloud CDN only when explicitly requested or on `production-HA`. |
| **Serverless VPC Access Connector** *(legacy)* | Minimum **2 × `e2-micro` VMs** running 24/7 (`~$14–$18/mo` idle — **unverified** exact 2026-11 connector rate) | Legacy Serverless VPC Access connectors silently spin up 2 always-on VMs just so Cloud Run can talk to Cloud SQL/Memorystore. | Always use **Cloud Run Direct VPC Egress** (no connector VMs; billed only for egress traffic) or Cloud Run's built-in **Cloud SQL Unix socket connector** (`$0` idle). |
| **Cloud NAT** | Per-VM hourly gateway fee (up to `~$0.044/hr` = `~$32/mo` at 32+ VMs; smaller for fewer VMs) **+ `$0.045/GiB` processed** + External IP (`$0.005/hr`) | Routing all Cloud Run Direct VPC Egress traffic through Cloud NAT adds `$0.045/GiB` + gateway/IP fees. | Route **only private-RFC1918 traffic** (`PRIVATE_RANGES_ONLY`) through Direct VPC Egress so internet-bound traffic leaves Cloud Run directly without Cloud NAT; enable Cloud NAT only when a static outbound IP is required. |
| **Cloud SQL Dedicated Core & HA jump** | `db-f1-micro` is `~$9/mo`, but the smallest SLA dedicated instance (`1 vCPU / 3.75 GiB`) jumps to **`~$51/mo`** (`~$102/mo` Regional HA) — **plus** `$0.08/GiB-mo` for all backups | Users moving from `db-f1-micro` to get an SLA hit a 5× price jump; backups are never free. | Surface the exact `db-f1-micro` (no SLA) vs dedicated Enterprise (`~$51/mo`) vs HA (`~$102/mo`) jump clearly in `plan.yaml` and cap backup retention days explicitly. |
| **External IPv4 Addresses** | **`$0.005/hr`** (`~$3.65/mo`) in-use; higher rate when reserved & unused | Every public VM, NAT IP, or public Cloud SQL IPv4 accrues `$3.65/mo` (and unused reserved static IPs cost even more). | Never assign a public IPv4 to Cloud SQL (use built-in Cloud SQL connector or private VPC IP); release static IPs cleanly on `destroy`. |
| **Network Egress & Cross-Region Transfer** | Standard internet egress `~$0.08–$0.12/GB` (Premium Tier higher than Standard Tier) | Large GCS downloads or cross-region traffic between Cloud Run and Cloud SQL/GCS incur steep egress charges. | Always co-locate Cloud Run, Cloud SQL, Memorystore, and GCS in the **same single region** (`us-central1`, `europe-west1`, etc.); warn before selecting multi-region GCS buckets. |

### Citations (R7)
- Google Cloud VPC & Load Balancing & Cloud NAT pricing: https://cloud.google.com/vpc/network-pricing (checked 2026-11-26)
- Google Cloud Run Direct VPC Egress docs: https://cloud.google.com/run/docs/configuring/vpc-direct-vpc (checked 2026-11-26)
- Cloud SQL pricing: https://cloud.google.com/sql/pricing (checked 2026-11-26)
