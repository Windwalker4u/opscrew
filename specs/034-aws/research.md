# Research: AWS Managed-Services Target (Feature 034)

**Date:** 2026-11-26 | **Issue:** `#42` | **Scope:** Research only (no code) preparing OpsCrew's AWS managed-services design (034).  
**Reference region for all prices:** US East (N. Virginia), `us-east-1` (On-Demand Linux, 730 hours/month unless stated otherwise).  
**Honesty rule:** Every figure below cites the official documentation, pricing page, or release artifact checked on **2026-11-26**. Any detail not directly confirmed in an official source is explicitly marked **unverified**.

---

## R1. Compute for a Web App

### Summary comparison (small app in `us-east-1`, 1 region)

| Option | Status (2026-11) | Small-app monthly estimate (`us-east-1`) | Cold starts | Key limits & fit for OpsCrew |
|---|---|---|---|---|
| **Amazon Lightsail Containers** | Active | **$7/mo** (Nano: 0.25 vCPU, 512 MB RAM, 500 GB transfer) or **$10/mo** (Micro: 0.25 vCPU, 1 GB RAM) — flat cap, includes a built-in load-balanced HTTPS endpoint & transfer (distinct from Lightsail's standalone $18/mo instance load balancer) | None (always on) | Best **lean** flat-rate option for a single container web app with predictable billing and zero ALB/NAT/IPv4 surprises. Limited VPC peering / no Fargate-style sidecars or fine-grained IAM task roles. |
| **EC2 + Compose** | Active | **~$3.80/mo** (`t4g.nano` 0.5 GB) or **~$6.13/mo** (`t4g.micro` 1 GB) + **~$1.60/mo** (20 GB gp3) + **$3.65/mo** (1 public IPv4) ≈ **$11.40/mo** | None (always on) | Plugs straight into OpsCrew's existing VPS/Compose seam and enables `retarget --to aws`. Single-server scaling ceiling. |
| **Amazon ECS on Fargate** (and **ECS Express Mode**) | Active (**Express Mode** is AWS's replacement for App Runner) | **0.25 vCPU / 0.5 GB Linux x86:** `$0.04048 × 0.25 + $0.004445 × 0.5` = `$0.01234/hr` ≈ **$9.01/mo** compute (Arm/Graviton ~20% cheaper) **+ ALB** (`$16.43/mo` base + LCU) **+ public IPv4** (`$3.65/mo`/task or ALB IPs) ≈ **$29–$35/mo** solo; shared ALB amortizes across services | ~20–60 s on scale-out; none while 1 task stays warm | Best **balanced / production-HA** choice for web + background workers + zero-downtime rolling deploys + private VPC networking + full IAM task roles. **ECS Express Mode** (`aws_ecs_express_gateway_service`) provisions ALB, target groups, security groups, and auto-scaling automatically (including shared ALB reuse). |
| **AWS Lambda Web Functions** (announced **October 2026**) | **Active (new)** — announcement lists **Node.js only, in 5 regions** | **$0.30 / 1M requests** + **active CPU** (`~$0.0000276944/vCPU-s` on Arm, 1 ms increments; **zero CPU charge while waiting on DB/IO**) + **memory lifetime** (**`$0.0000036667/GB-s`** while warm) — **$0 to a few dollars/mo** for low/spiky traffic | Multi-concurrency per warm execution environment (`128 concurrent requests per microVM` is **unverified**) | **Real option for stateless HTTP/SSR/AI-streaming web apps** (standard Node.js HTTP server listening on a port, zero event-handler rewrite; specific Next.js/Hono framework coverage, Firecracker microVM detail, CloudFront OAC origin integration, VPC attachment, and ECR container packaging are **unverified** on the cited pages). Not for long-running background workers or sticky WebSockets. |
| **AWS App Runner** | **Maintenance mode — closed to new customers on 2026-04-30** | Idle floor: `$0.007/GB-hr` (`$5.11/mo` for 1 GB warm); Active: `$0.064/vCPU-hr` + `$0.007/GB-hr`; + `$1/mo` auto-deploy pipeline | Sub-second from provisioned warm instance (never scales strictly to 0 by default) | **Do not recommend for new AWS accounts.** AWS closed App Runner to new customers on **2026-04-30** and officially recommends **Amazon ECS Express Mode** (or **Lambda Web Functions**) instead. Keep only as legacy/import awareness if a user already has an existing App Runner account. |

### Deep dive: AWS Lambda Web Functions (October 2026)

- **Official announcement:** `https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/` (verified HTTP 200 on 2026-11-26; traditional Lambda functions were renamed **Lambda Event Functions**). The announcement lists **Node.js** support in **5 regions**.
- **Why it matters for OpsCrew:** Previously, Lambda required rewriting an app into event handlers or adding an adapter layer (like Lambda Web Adapter). **Lambda Web Functions** run standard Node.js HTTP servers listening on a port and bill **active CPU only** (waiting on PostgreSQL, Valkey, or upstream APIs does not accrue CPU charges) plus memory lifetime at **`$0.0000036667/GB-s`** and **$0.30 / 1M requests**.
- **Unverified claims to confirm before 034's build:** The following details were not directly confirmed on the cited announcement/pricing pages and are marked **unverified**: `up to 128 concurrent requests per microVM`, Firecracker microVM internals, **CloudFront Origin Access Control (OAC)** origin integration, **VPC attachment**, ECR container image packaging, and specific framework listings (**Next.js**, **Hono**). Exact idle timeout duration before scale-to-zero and exact x86 vs Arm rate tables across every region are also **unverified** and should be read from the AWS docs and Pricing API during 034's build.
- **Architectural recommendation for OpsCrew 034:**
  - **Lean preset (single web app, no workers):** offer **Lambda Web Functions** (spiky/low-traffic Node.js HTTP apps in supported regions) or **Lightsail Containers** (`$7–$10/mo` flat cap) or **EC2 + Compose** (`~$11/mo`, supports `retarget`).
  - **Balanced / Production-HA preset (web + workers, steady load, private DB):** **Amazon ECS on Fargate** (preferring **ECS Express Mode** for simple stateless web services without hand-rolled ALB boilerplate, or standard ECS Service + shared ALB when pairing web + workers).
  - **Skip App Runner** as a default choice because new AWS accounts cannot create App Runner services as of 2026-04-30.

### Citations (R1)
- AWS Lambda Web Functions announcement (2026-10): https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/ (checked 2026-11-26)
- AWS Lambda pricing & quotas: https://aws.amazon.com/lambda/pricing/ and https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html (checked 2026-11-26)
- Amazon ECS Fargate pricing: https://aws.amazon.com/fargate/pricing/ (checked 2026-11-26)
- Amazon ECS Express Mode documentation: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html (checked 2026-11-26)
- Amazon Lightsail pricing & Container Services docs (built-in HTTPS endpoint & certificates): https://aws.amazon.com/lightsail/pricing/, https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html, and https://docs.aws.amazon.com/lightsail/latest/userguide/container-service-ssl-tls-certificates.html (checked 2026-11-26)
- AWS App Runner pricing & availability change (closed to new customers 2026-04-30): https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html and https://aws.amazon.com/apprunner/pricing/ (checked 2026-11-26)

---

## R2. Databases and Caches

### Smallest sizes & baseline pricing (`us-east-1`, On-Demand)

| Service | Engine | Smallest size | Compute / base price (`us-east-1`) | Storage / I/O | Estimated monthly floor |
|---|---|---|---|---|---|
| **Amazon RDS** (Single-AZ) | PostgreSQL, MySQL | `db.t4g.micro` (2 vCPU, 1 GiB RAM, Graviton2) | `~$0.016/hr` (**~$11.68/mo**) | `gp3`: `$0.115/GB-mo` (20 GB min = `$2.30/mo`, 3,000 IOPS included) | **~$14/mo** (Multi-AZ roughly **2×** ≈ `~$28/mo`) |
| **Amazon Aurora Serverless v2** | PostgreSQL, MySQL | **0 ACU** (auto-pause/scale-to-zero) or **0.5 ACU** floor (1 GiB RAM) | `$0.12/ACU-hr` → **$0/hr when paused at 0 ACU**; **`$0.06/hr` (~$43.80/mo)** continuous at 0.5 ACU | Standard storage `~$0.10/GB-mo` + I/O requests (or I/O-Optimized tier) | **$0.10/GB + active ACUs** (with 0 ACU pause, ~15 s resume) or **~$44+/mo** always-on at 0.5 ACU |
| **Amazon ElastiCache (Node-based)** | **Valkey** (preferred over Redis OSS: 20% cheaper) | `cache.t4g.micro` (2 vCPU, 0.5 GiB RAM) | `~$0.0128/hr` (**~$9.34/mo** for Valkey vs `$11.68/mo` for Redis OSS) | Included in node memory | **~$9.34/mo** (Single node) |
| **Amazon ElastiCache Serverless** | **Valkey** (33% cheaper than Redis OSS serverless) | Auto-scaled (100 MB minimum metered storage floor) | Storage: **`$0.084/GB-hr`** (`~$6.13/mo` at 100 MB floor) + Compute: **`$0.0023 / 1M ECPUs`** | Included in GB-hr | **~$6.13/mo** floor + ECPU usage (no node management, Multi-AZ automatic) |
| **Amazon MemoryDB** | Valkey / Redis OSS (durable multi-AZ transaction log) | `db.t4g.small` / `db.r6g.large` (`r7g`/`r6g` ~$0.21+/hr) | High node floor (~$150+/mo for `r6g.large`; smaller `t4g.small` pricing **unverified** on 2026-11-26) | `~$0.20/GB` written to transaction log | **High floor** — recommend only when durable in-memory primary storage is explicitly needed; use **ElastiCache Valkey** for caches & queues |

### Backups, snapshots, and restore drills (for OpsCrew 024 & 029)

- **RDS & Aurora automated backups:**
  - Automated daily backups with **Point-In-Time Recovery (PITR)** up to 35 days retention; backup storage up to **100% of provisioned database storage is free** on RDS (additional backup storage `~$0.095/GB-mo` in `us-east-1`).
  - Manual DB snapshots (`CreateDBSnapshot` / `CreateDBClusterSnapshot`) persist until explicitly deleted and map cleanly to `opscrew snapshot`.
  - **Restore drills (ADR 0034):** RDS/Aurora snapshot restores create a **new DB instance/cluster** (`RestoreDBInstanceFromDBSnapshot` / `RestoreDBClusterFromSnapshot`) in an isolated private subnet with no public IP (`PubliclyAccessible=false`) and a closed security group — ideal for OpsCrew's throwaway restore drill, which verifies connectivity/schema and then deletes the restored instance with `SkipFinalSnapshot=true`.
- **Aurora Serverless v2 scale-to-zero (`0 ACU`):**
  - Pauses automatically when no user connections, replication tasks, or attached RDS Proxies are active, eliminating compute charges for idle staging/preview/dev databases; resumes in ~15 seconds on first connection.
  - Caveat: an RDS Proxy or constant health-check query prevents auto-pause, so OpsCrew's health checks on staging/preview must not query the DB every few seconds if `0 ACU` is enabled.
- **ElastiCache for Valkey:**
  - Supports automated and manual snapshots (`CreateSnapshot` / `CreateServerlessCacheSnapshot`) exported to S3 or restored into a new cache/replication group.
  - For queues (BullMQ, Sidekiq, Celery), OpsCrew must set `maxmemory-policy: noeviction` (parameter group on node-based; verify policy options on ElastiCache Serverless before choosing serverless for queues — **unverified** whether ElastiCache Serverless allows `noeviction` vs default volatile eviction).

### IAM authentication options

- **RDS PostgreSQL / MySQL & Aurora Serverless v2:** Native **IAM database authentication** is supported (including on `db.t4g.micro` and Aurora Serverless v2). Clients authenticate using a short-lived (15-minute) SigV4-signed token generated via `rds:connect` instead of a static password. **Caveat for OpsCrew's "no app code rewrite" rule (roadmap 034):** standard `DATABASE_URL` drivers expect a static password unless the app or a connection helper refreshes the 15-minute token; therefore static credentials in Secrets Manager/SSM remain the zero-code-change default, with IAM auth offered when the app/driver supports token refresh (or via AWS IAM-aware wrappers).
- **ElastiCache for Valkey:** Native **IAM authentication** is supported for **Valkey** and Redis OSS 7.0+ via the `elasticache:Connect` IAM action and SigV4 tokens (natively handled by Valkey GLIDE / AWS SDK helpers). Same caveat: standard `REDIS_URL` clients require static AUTH tokens unless using an IAM-aware client.

### Citations (R2)
- Amazon RDS pricing (PostgreSQL & MySQL): https://aws.amazon.com/rds/postgresql/pricing/ and https://aws.amazon.com/rds/mysql/pricing/ (checked 2026-11-26)
- Amazon Aurora pricing & Serverless v2 scaling to 0 ACU: https://aws.amazon.com/rds/aurora/pricing/ and https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html (checked 2026-11-26)
- Amazon RDS IAM database authentication: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html (checked 2026-11-26)
- Amazon ElastiCache pricing (Valkey node-based & Serverless): https://aws.amazon.com/elasticache/pricing/ (checked 2026-11-26)
- Amazon ElastiCache IAM authentication: https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth-iam.html (checked 2026-11-26)
- Amazon MemoryDB pricing: https://aws.amazon.com/memorydb/pricing/ (checked 2026-11-26)

---

## R3. Storage, Secrets, DNS, TLS, and the Edge (Including Keeping DNS at Cloudflare)

### Service pricing & role (`us-east-1`)

| Service | Pricing (`us-east-1`) | Role & OpsCrew recommendation |
|---|---|---|
| **Amazon S3 (Standard)** | Storage: **$0.023/GB-mo** (first 50 TB); Requests: `$0.005/1k PUT/POST/LIST`, `$0.0004/1k GET`; Internet egress: `$0.09/GB` (free to CloudFront & same-region AWS services) | App uploads, static assets, and encrypted off-server backups (always private with Block Public Access enabled; served via CloudFront OAC or pre-signed URLs). |
| **AWS Secrets Manager** vs **SSM Parameter Store** | **Secrets Manager:** **$0.40/secret/month** + `$0.05/10k API calls` (each secret or replica billed). **SSM Parameter Store Standard:** **$0 (FREE)** up to 10,000 parameters/region, 4 KB max, encrypted with KMS (`SecureString` free with AWS-managed key `aws/ssm`; CMK is `$1/mo`). Advanced parameters: `$0.05/param/mo` + `$0.05/10k calls` (8 KB max). | **Cost trap prevention:** Storing 25 individual env vars in Secrets Manager costs `$10/mo`; packing an app's env JSON into **1 Secrets Manager secret** costs **$0.40/mo** (or **$0/mo** in **SSM Parameter Store Standard** `SecureString` when automatic RDS rotation isn't needed). Use Secrets Manager when AWS-managed rotation or >4 KB payloads are needed; default to SSM Parameter Store Standard (`SecureString`) for lean apps! |
| **Amazon Route 53** | **$0.50/hosted zone/month** (first 25 zones; `$0.10` thereafter) + `$0.40/million` standard DNS queries (Alias queries to CloudFront/ALB/S3 are free; private VPC queries free). | Only needed when the user moves DNS to AWS. Completely optional if DNS stays at Cloudflare. |
| **AWS Certificate Manager (ACM)** | **Free** for public TLS certificates attached to CloudFront, ALB, API Gateway, or App Runner. (Exportable public certs cost `$7/FQDN` or `$79/wildcard`; Private CA costs **$400/mo** — never create a Private CA by default!) | Zero-cost automated TLS issuance & renewal via DNS-01 CNAME validation. **Hard rule:** certificates for **CloudFront** MUST be created in **`us-east-1`** regardless of app region; certificates for **ALB** live in the ALB's region. |
| **Amazon CloudFront** | **Pay-as-you-go:** `$0.085/GB` US/EU transfer out (first 10 TB), `$0.0075–$0.0100/10k` requests, and the 1 TB/mo always-free tier are **unverified** on the cited pricing page (confirm via AWS Pricing API before wiring PAYG estimates). **Flat-rate plans (no overages):** **Free `$0/mo`** (100 GB, 1M req), **Pro `$15/mo`**, **Business `$200/mo`**, **Premium `$1,000/mo`**. | Mandatory in front of private S3 buckets (via **Origin Access Control — OAC** with `s3:GetObject` scoped to `AWS:SourceArn`); CloudFront OAC support for **Lambda Web Functions** is **unverified** on the cited pages. |

### How each works when the app's DNS stays at Cloudflare

Keeping DNS at Cloudflare works cleanly with every AWS service above — **Route 53 is not required**:

1. **ACM DNS validation in Cloudflare:** Request the ACM certificate (`us-east-1` for CloudFront, regional for ALB) with `validation_method = "DNS"`. OpsCrew's existing Cloudflare DNS adapter writes ACM's `_<hash>.<domain> CNAME <token>.acm-validations.aws.` record with **`proxied = false` (gray cloud / DNS-only)** — **critical:** an orange-cloud proxied CNAME breaks ACM issuance and automatic renewal.
2. **S3 + CloudFront (assets or full site) behind Cloudflare DNS:**
   - Attach the `us-east-1` ACM cert and custom domain (`Alternate Domain Name`) to CloudFront.
   - In Cloudflare, point `<domain>` (or `assets.<domain>`) via CNAME (Cloudflare flattens apex CNAMEs automatically) to `<id>.cloudfront.net`.
   - **Recommended proxy setting:** Set the Cloudflare record to **DNS-only (gray cloud)** when CloudFront is the CDN/edge (avoids double-CDN latency and double-TLS quirks); **or** orange-cloud (Full Strict) if the user wants Cloudflare WAF/DDoS in front of CloudFront (note CloudFront still charges egress to Cloudflare unless CloudFront is bypassed).
3. **ECS Fargate / ALB behind Cloudflare (proxied):**
   - Point Cloudflare CNAME (orange cloud, SSL/TLS mode **Full (Strict)**) to the ALB DNS name.
   - Attach either a free regional **ACM** cert or a **Cloudflare Origin CA** cert (imported into ACM) on the ALB HTTPS listener, and restrict the ALB security group ingress on port 443 to Cloudflare's IP ranges (or require a shared secret header checked by an ALB listener rule — matching Feature 036's origin-protection model!).
   - **Bonus:** Using Cloudflare orange-cloud in front of ALB/EC2 gives Cloudflare WAF + DDoS protection without paying for AWS WAF (`$5/WebACL + $1/rule/mo`).

### Citations (R3)
- Amazon S3 pricing: https://aws.amazon.com/s3/pricing/ (checked 2026-11-26)
- AWS Secrets Manager pricing: https://aws.amazon.com/secrets-manager/pricing/ (checked 2026-11-26)
- AWS Systems Manager Parameter Store pricing: https://aws.amazon.com/systems-manager/pricing/ (checked 2026-11-26)
- Amazon Route 53 pricing: https://aws.amazon.com/route53/pricing/ (checked 2026-11-26)
- AWS Certificate Manager pricing & CloudFront `us-east-1` requirement: https://aws.amazon.com/certificate-manager/pricing/ and https://docs.aws.amazon.com/acm/latest/userguide/acm-regions.html (checked 2026-11-26)
- Amazon CloudFront pricing & Origin Access Control (OAC): https://aws.amazon.com/cloudfront/pricing/ and https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html (checked 2026-11-26)

---

## R4. Identity for Deploys: GitHub Actions OIDC to an IAM Role

No long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` is stored in GitHub Secrets. Instead, one account-level OIDC Identity Provider (`arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`) trusts GitHub Actions, and each app environment gets a dedicated least-privilege IAM role.

### Critical 2026 GitHub OIDC detail (Immutable Subject Claims)

- **Environment-scoped `sub` claim replaces branch:** When a workflow job declares `environment: production`, GitHub emits `sub` scoped to the **environment** (NOT `ref:refs/heads/main`). Branch restriction is enforced by GitHub's environment deployment branch policy.
- **Repositories created on or after 2026-07-15 (or opted in to immutable OIDC subjects):** GitHub embeds immutable numeric org/repo IDs in `sub`:
  - Legacy format: `repo:<OWNER>/<REPO>:environment:<ENV>`
  - Immutable format (2026-07-15+): `repo:<OWNER>@<OWNER_ID>/<REPO>@<REPO_ID>:environment:<ENV>`
- OpsCrew should inspect the repository's immutable IDs (from GitHub's repo API `owner.id` & `id`) or match the exact `sub` format of the repository, avoiding broad wildcards like `repo:owner/*`.
- **Thumbprints note:** AWS IAM trusts GitHub's root CA natively for `token.actions.githubusercontent.com` (per AWS IAM OIDC documentation), though `aws_iam_openid_connect_provider` still accepts `thumbprint_list` (which Terraform `hashicorp/aws` v5.x/v6.x makes optional for AWS-trusted CAs).

### Exact IAM Trust Policy (scoped to one repository and one environment)

For a standard repository (`<OWNER>/<REPO>`, environment `production`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsDeployOidc",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:environment:production"
        }
      }
    }
  ]
}
```

For a repository created on or after **2026-07-15** (immutable subject claims), replace the `sub` string with the exact immutable subject (still using `StringEquals` — zero wildcards!):

```json
"token.actions.githubusercontent.com:sub": "repo:<OWNER>@<OWNER_ID>/<REPO>@<REPO_ID>:environment:production"
```

When a repository runs on GitHub Free (private repo without GitHub Environments), scope strictly to the deploy branch instead:

```json
"token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/main"
```

### Workflow job permissions

```yaml
permissions:
  id-token: write
  contents: read
```

Combined with `aws-actions/configure-aws-credentials` (commit-pinned in `pins.ts`) passing `role-to-assume: arn:aws:iam::<AWS_ACCOUNT_ID>:role/opscrew-<app>-<env>-deploy` and `aws-region: <region>`.

### Citations (R4)
- GitHub Docs — Configuring OpenID Connect in Amazon Web Services: https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services (checked 2026-11-26)
- GitHub Docs — About security hardening with OpenID Connect (`sub` claims & immutable IDs): https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect (checked 2026-11-26)
- AWS IAM Docs — Creating OpenID Connect (OIDC) identity providers: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html (checked 2026-11-26)

---

## R5. Terraform / OpenTofu Provider (`hashicorp/aws`) Coverage

**Current version (verified live from Terraform Registry on 2026-11-26):**
- **`hashicorp/aws` `6.74.0`** (published `2026-11-23T23:04:55Z`, 1,765 resource docs in `v6.74.0`).
- **Note on v6.x:** `hashicorp/aws` v6 adds an optional per-resource `region` argument on regional resources (enabling multi-region resources such as an `us-east-1` CloudFront ACM cert in the same root module without a second `provider "aws"` alias, though an explicit `us-east-1` alias remains widely compatible).

### Resource coverage verified directly against `hashicorp/terraform-provider-aws` tag `v6.74.0`

| AWS service | Verified Terraform resources in `hashicorp/aws` `v6.74.0` | Gaps / caveats |
|---|---|---|
| **Lambda Web Functions (2026-10)** | `aws_lambdaweb_function`, `aws_lambdaweb_function_revision`, `aws_lambdaweb_function_endpoint` | **Present in `v6.74.0`!** Uses AWS Cloud Control API under the hood, so the IAM deploy role needs `cloudformation:CreateResource`/`GetResource`/`UpdateResource`/`DeleteResource`. Creating `aws_lambdaweb_function` alone serves no traffic until revision + endpoint resources are created. Local emulation of `aws_lambdaweb_*` in `floci` is **unverified**. |
| **ECS on Fargate & ECS Express Mode** | `aws_ecs_cluster`, `aws_ecs_cluster_capacity_providers`, `aws_ecs_service`, `aws_ecs_task_definition`, **`aws_ecs_express_gateway_service`** | Full coverage. `aws_ecs_express_gateway_service` requires `depends_on` on its IAM role policy attachments to prevent destroy getting stuck in `DRAINING`. |
| **Lightsail Containers** | `aws_lightsail_container_service`, `aws_lightsail_container_service_deployment_version`, `aws_lightsail_certificate` | Covered. Note Lightsail cannot attach to a standard VPC security group directly (uses Lightsail VPC peering). |
| **App Runner (legacy)** | `aws_apprunner_service` (+ 8 supporting resources) | Covered in Terraform, but **service closed to new AWS accounts on 2026-04-30**. |
| **RDS & Aurora Serverless v2** | `aws_db_instance`, `aws_rds_cluster`, `aws_rds_cluster_instance`, `aws_rds_cluster_parameter_group`, `aws_db_subnet_group` | Full coverage, including `serverlessv2_scaling_configuration { min_capacity = 0.0 }` for scale-to-zero. |
| **ElastiCache (Valkey) & MemoryDB** | `aws_elasticache_serverless_cache`, `aws_elasticache_replication_group`, `aws_elasticache_user`, `aws_elasticache_user_group`, `aws_memorydb_cluster`, `aws_memorydb_acl` | Full coverage for both node-based and Serverless Valkey (`engine = "valkey"`). |
| **S3** | `aws_s3_bucket`, `aws_s3_bucket_public_access_block`, `aws_s3_bucket_policy`, `aws_s3_bucket_server_side_encryption_configuration`, `aws_s3_bucket_versioning`, `aws_s3_bucket_lifecycle_configuration` | Full coverage (split resources since v4+). |
| **Secrets Manager & SSM** | `aws_secretsmanager_secret`, `aws_secretsmanager_secret_version`, `aws_secretsmanager_secret_rotation`, `aws_ssm_parameter` | Full coverage. **Safety rule:** never write real secret values through Terraform `aws_secretsmanager_secret_version` / `aws_ssm_parameter.value` (persists plaintext in state!). Create only the secret shell in Terraform and populate values via AWS SDK/CLI at apply time (matching OpsCrew's existing secret-out-of-state invariant). |
| **Route 53, ACM, CloudFront** | `aws_route53_zone`, `aws_route53_record`, `aws_acm_certificate`, `aws_acm_certificate_validation`, `aws_cloudfront_distribution`, `aws_cloudfront_origin_access_control` | Full coverage. |
| **IAM OIDC & EventBridge Scheduler** | `aws_iam_openid_connect_provider`, `aws_iam_role`, `aws_iam_role_policy`, `aws_scheduler_schedule`, `aws_scheduler_schedule_group` | Full coverage. |
| **What Terraform does NOT do cleanly** | **One-off restore drills & secret population:** triggering ad-hoc `RestoreDBInstanceFromDBSnapshot` -> verifying -> deleting, and writing secret values without storing them in `.tfstate` belong in OpsCrew's typed AWS SDK connector (`@aws-sdk/*`), NOT in Terraform state. | Also **Infracost** pricing coverage for brand-new resources (`aws_lambdaweb_function`, `aws_ecs_express_gateway_service`) is **unverified** as of 2026-11-26 and should be checked when wiring pricing. |

### Citations (R5)
- Terraform Registry `hashicorp/aws`: https://registry.terraform.io/providers/hashicorp/aws/6.74.0 (queried via `https://registry.terraform.io/v1/providers/hashicorp/aws` on 2026-11-26)
- `hashicorp/terraform-provider-aws` `v6.74.0` resource docs tree: https://github.com/hashicorp/terraform-provider-aws/tree/v6.74.0/website/docs/r (verified on 2026-11-26)

---

## R6. Testing Without Real AWS: LocalStack vs. floci

### Verified 2026 status

| Criterion | **floci** (`floci-io/floci`) | **LocalStack** (`localstack.cloud`) |
|---|---|---|
| **License & Commercial Use** | **MIT** — completely free for open-source, contributors, and commercial CI; zero account, zero auth token, zero feature gates. | **Legacy standalone Community image ended on 2026-03-23** (`v2026.3.0`). Unified image now **requires a LocalStack account + `LOCALSTACK_AUTH_TOKEN`**. Free **Hobby** tier is **non-commercial only**; commercial teams require paid **Base (`$39/seat/mo` annual)** or **Ultimate (`$89/seat/mo` annual)**. Open-source maintainers can apply for a free OSS grant, but contributors cannot run tests without signing up for an account/token. |
| **Distribution** | Single Docker image (`floci/floci`, port `4566`) **plus** standalone native binary `floci-aws` (Linux, macOS, Windows); 32k+ GitHub stars, actively maintained (updated 2026-11-26). | Single Docker image (`localstack/localstack`), port `4566`, requires `LOCALSTACK_AUTH_TOKEN`. |
| **Service coverage for OpsCrew 034** | **Core 034 services included free:** EC2, ECS, ECR, ELB v2, Lightsail, classic Lambda, RDS, ElastiCache, MemoryDB, S3, CloudFront, ACM, Route 53, Secrets Manager, SSM Parameter Store, IAM/STS, KMS, EventBridge Scheduler, SQS, SNS, SES, CloudWatch Logs/Metrics, Pricing, Cloud Control API. (Container-backed workloads like RDS/ECS/Lambda use Docker socket.) Support for **Lambda Web Functions (`aws_lambdaweb_*`)** in `floci` is **unverified**. | Free Hobby tier covers core services (S3, SQS, SNS, DynamoDB, basic Lambda, IAM, STS, SSM, Secrets Manager, CloudWatch Logs, EventBridge), while **ECS, ECR, RDS, ElastiCache, MemoryDB, CloudFront, Route 53, ACM, ELB v2, and ECS Express/Lambda Web Functions** are mostly gated behind paid Base/Ultimate tiers (exact Hobby-tier service exclusion matrix beyond IAM is **unverified** for `2026.11`, but ECS/RDS/ElastiCache/CloudFront have historically been Pro-only). |
| **IAM Policy Enforcement** | **Not enforced** (accepts any credentials; validates IAM/STS API CRUD and trust-policy structure, not runtime authorization decisions). | **NOT included on Free/Hobby tier** — `ENFORCE_IAM=1` requires paid **Base (`$39/mo`)** or higher. |
| **Terraform / OpenTofu compatibility** | Drop-in endpoint `http://localhost:4566` with standard `hashicorp/aws` provider (skipping credentials validation & metadata checks). | Standard `http://localhost:4566` (or `tflocal`), requires `LOCALSTACK_AUTH_TOKEN`. |
| **What NEITHER free emulator proves** | Real IAM least-privilege enforcement, real GitHub OIDC JWT verification against AWS STS, real ACM DNS validation / CloudFront edge TLS, real VPC/ALB/NAT routing, live AWS Pricing API accuracy. | Same on Free/Hobby tier (paid LocalStack adds `ENFORCE_IAM=1`, still does not test real GitHub OIDC against AWS or real ACM/CloudFront edge behavior). |

### Recommendation for OpsCrew 034

**Choose `floci` (`floci/floci`) as OpsCrew's primary automated AWS test emulator.**

1. LocalStack's **March 23, 2026** discontinuation of the token-free Community image and non-commercial restriction on the Hobby tier make LocalStack unsuitable for an open-source repo where any contributor or CI runner must run `pnpm test` without registering an account or paying per seat.
2. `floci` is **MIT-licensed**, requires **no auth token**, emulates the core 034 surface **including ECS, RDS, ElastiCache, CloudFront, ACM, Route 53, Lightsail, and Cloud Control API** (`aws_lambdaweb_*` / Lambda Web Functions emulation is **unverified** and must be tested before relying on `floci` for that preset), and ships both a Docker image and a native binary.
3. Because `floci` does not enforce IAM policies, OpsCrew should pair `floci` integration tests with **deterministic SecOps IAM policy unit checks** (static least-privilege and trust-policy assertions in `@opscrew/secops`, e.g., verifying no `*` resource/action on deploy roles and strict `token.actions.githubusercontent.com:sub` scoping) plus one **optional throwaway-account live pass** for real OIDC + ACM + CloudFront + ALB verification.

### Citations (R6)
- floci repository & supported services (MIT): https://github.com/floci-io/floci and https://floci.io/floci/services/ (fetched 2026-11-26)
- LocalStack pricing & auth-token docs (unified image / non-commercial Hobby tier): https://www.localstack.cloud/pricing and https://docs.localstack.cloud/getting-started/auth-token/ (checked 2026-11-26)
- LocalStack IAM policy enforcement docs: https://docs.localstack.cloud/user-guide/aws/iam/ (checked 2026-11-26)

---

## R7. Costs a User Can Be Surprised By (and How to Avoid Each for a Small App)

| Surprise cost | Exact rate (`us-east-1`) | Why it surprises small apps | How OpsCrew avoids it for small apps |
|---|---|---|---|
| **NAT Gateway** | **`$0.045/hr`** (`$32.85/mo` per AZ — `$65.70/mo` for 2 AZs!) **+ `$0.045/GB`** data processed **in `us-east-1` (US East, N. Virginia; higher in many other regions)** **+ `$3.65/mo`** EIP (`$0.005/hr` globally) | Putting ECS Fargate or Lambda in a private subnet with a NAT Gateway adds **~$36.50/mo per AZ** in `us-east-1` before serving a single user — often 3× the app's compute cost! Same-region S3/ECR/DynamoDB pulls through NAT also pay `$0.045/GB` (`us-east-1`). | **Lean default: NO NAT Gateway.** Run Fargate tasks in public subnets with `assign_public_ip = true` + a **strict inbound security group** (allowing traffic only from the ALB/Cloudflare, zero public DB access; RDS/ElastiCache stay in private subnets with no internet route needed), **OR** use IPv6-only egress via a free **Egress-Only Internet Gateway** (when upstream APIs support IPv6). Always add free **VPC Gateway Endpoints** for **S3** and **DynamoDB** whenever a NAT Gateway IS chosen. |
| **Idle Load Balancers (ALB / NLB)** | **ALB:** **`$0.0225/hr`** (**`$16.43/mo`** idle) + `$0.008/LCU-hr` (+ public IPv4 charges per AZ!). **NLB:** same `$0.0225/hr` base (`$16.43/mo`). | Creating one dedicated ALB per small app or per staging/preview environment silently burns `$16–$24/mo` per environment even at zero traffic. | For **lean** apps: use **Lightsail Containers** (built-in HTTPS endpoint, `$0` extra), **Lambda Web Functions** (no ALB), or **EC2 + Caddy** (no ALB). On **ECS**, share one ALB across environments/services via host-based routing (or use ECS Express Mode's shared ALB). |
| **Public IPv4 Addresses** | **`$0.005/IP/hr`** (**`$3.65/mo`** per IPv4, **in-use or idle**, globally across all commercial regions) | Every public EC2 instance, public Fargate task, NAT Gateway EIP, and public ALB subnet node silently incurs `$3.65/mo` per IPv4 address (e.g. a 2-AZ ALB + 2 public Fargate tasks = 4 IPs = **`$14.60/mo`** in IPv4 charges alone). | Prefer **CloudFront / Lightsail / Lambda Web Functions** (no billable VPC public IPv4s); on VPC workloads use **dual-stack / IPv6** where supported, avoid assigning public IPs to RDS/ElastiCache, and show the exact IPv4 line item in `plan.yaml` cost estimates. |
| **Internet Data Transfer Out (Egress)** | **`$0.09/GB`** from EC2/ALB/S3/NAT to the internet in `us-east-1` (AWS Free Tier includes **100 GB/month** of internet data transfer out per AWS account, aggregated across all eligible AWS services and commercial regions—excluding GovCloud and China—resetting monthly without rollover; cross-AZ traffic inside AWS costs **`$0.01/GB` each way = `$0.02/GB`**!) | High asset/media traffic directly from S3 or ALB, or chatty cross-AZ app-to-DB/cache calls in Multi-AZ setups, can dominate the monthly bill once past the shared 100 GB/month account allowance. | Put **CloudFront** in front of S3 (S3 → CloudFront transfer is `$0`; CloudFront Free flat-rate plan includes 100 GB/mo with no overages, and Lightsail includes 500 GB–2 TB/mo). Keep single-AZ lean apps and their DB/cache in the **same AZ** to avoid `$0.02/GB` cross-AZ charges. |
| **Secrets Manager per-key & Private CA** | Secrets Manager: `$0.40/secret/mo`; ACM Private CA: **`$400/mo`** | Creating 25 separate Secrets Manager entries costs `$10/mo`; accidentally provisioning an ACM Private CA costs `$400/mo`. | Use **SSM Parameter Store Standard (`SecureString`, `$0`)** or **1 bundled JSON secret** (`$0.40/mo`); **never** provision ACM Private CA in OpsCrew templates. |
| **CloudWatch Logs / Container Insights** | Log ingestion `$0.50/GB`, storage `$0.03/GB-mo`, Insights queries `$0.005/GB` scanned; default retention is **Never Expire** | Unbounded log retention and noisy Container Insights enhanced metrics quietly accumulate on small apps. | Always set explicit `retention_in_days` (e.g. `14` or `30` days) on every `aws_cloudwatch_log_group`, and keep Container Insights opt-in with its cost shown in `plan.yaml`. |

### Citations (R7)
- AWS Public IPv4 Address pricing (`$0.005/hr`): https://aws.amazon.com/vpc/pricing/ (checked 2026-11-26)
- Amazon VPC NAT Gateway & VPC Endpoints pricing: https://aws.amazon.com/vpc/pricing/ (checked 2026-11-26)
- Elastic Load Balancing (ALB/NLB) pricing: https://aws.amazon.com/elasticloadbalancing/pricing/ (checked 2026-11-26)
- EC2 Data Transfer pricing: https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer (checked 2026-11-26)
- Amazon CloudWatch pricing: https://aws.amazon.com/cloudwatch/pricing/ (checked 2026-11-26)
