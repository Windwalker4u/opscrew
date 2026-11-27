/**
 * Vendored Terraform module `gcore-edge` for Gcore CDN origin group, CDN resource, free
 * `force_return` 403 probe-blocking rule, and optional Gcore DNS records (`G-Core/gcore` `~> 0.37.2`).
 *
 * Security invariant (ADR 0038 D6): this module NEVER sets `static_request_headers` or any
 * origin-verification secret. OpsCrew applies that header exclusively through the typed Gcore API
 * connector after apply so the secret never enters Terraform state.
 */

export const GCORE_EDGE_MODULE_NAME = "gcore-edge";

const VERSIONS_TF = `terraform {
  required_version = ">= 1.6.0"

  required_providers {
    gcore = {
      source  = "G-Core/gcore"
      version = "~> 0.37.2"
    }
  }
}
`;

const VARIABLES_TF = `variable "origin_group_name" {
  description = "Name of the Gcore CDN origin group for this app."
  type        = string
}

variable "domain" {
  description = "Primary hostname of the app, for example app.example.com."
  type        = string
}

variable "www" {
  description = "Also serve www.<domain>."
  type        = bool
  default     = false
}

variable "origin_host" {
  description = "Origin server IPv4 address or hostname reached by Gcore CDN over HTTPS."
  type        = string
}

variable "waf_custom_rules" {
  description = "Add Gcore's free force_return 403 CDN resource rule for common probes."
  type        = bool
  default     = true
}

variable "manage_dns" {
  description = "Manage DNS records in a Gcore DNS zone (true when dns.provider is gcore)."
  type        = bool
  default     = false
}

variable "dns_zone" {
  description = "Gcore DNS zone name (for example example.com) when manage_dns is true."
  type        = string
  default     = null
}

variable "proxied" {
  description = "Proxy traffic through Gcore CDN (false for Gcore DNS only)."
  type        = bool
  default     = true
}

variable "ipv4" {
  description = "Origin server public IPv4 address (for DNS-only A record when proxied is false)."
  type        = string
  default     = null
}

variable "ipv6" {
  description = "Origin server public IPv6 address (for DNS-only AAAA record when proxied is false)."
  type        = string
  default     = null
}
`;

const MAIN_TF = `# Gcore CDN origin group, automated Let's Encrypt certificate, and CDN resource: dynamic-app-safe
# defaults (edge caching disabled, query strings preserved, HTTPS to origin, HTTP -> HTTPS
# redirect, TLS 1.2+). The shared origin-verification header is applied outside Terraform via the
# Gcore API so its secret never enters Terraform state (ADR 0038 D6).
data "gcore_cdn_client" "this" {
  count = var.manage_dns && var.proxied ? 1 : 0
}

resource "gcore_cdn_origingroup" "this" {
  count    = var.proxied ? 1 : 0
  name     = var.origin_group_name
  use_next = true

  origin {
    source  = var.origin_host
    enabled = true
    backup  = false
  }
}

resource "gcore_cdn_sslcert" "this" {
  count     = var.proxied ? 1 : 0
  name      = "\${var.origin_group_name}-le"
  automated = true
}

resource "gcore_cdn_resource" "this" {
  count               = var.proxied ? 1 : 0
  cname               = var.domain
  secondary_hostnames = var.www ? ["www.\${var.domain}"] : []
  origin_group        = gcore_cdn_origingroup.this[0].id
  origin_protocol     = "HTTPS"
  active              = true
  ssl_enabled         = true
  ssl_data            = gcore_cdn_sslcert.this[0].id

  options {
    edge_cache_settings {
      enabled = false
    }

    ignore_query_string {
      enabled = true
      value   = false
    }

    redirect_http_to_https {
      enabled = true
      value   = true
    }

    tls_versions {
      enabled = true
      value   = ["TLSv1.2", "TLSv1.3"]
    }
  }

  lifecycle {
    # The origin-verification header is applied via Gcore's API outside Terraform (ADR 0038 D6)
    # so the secret never enters Terraform state; prevent later applies from wiping it.
    ignore_changes = [options[0].static_request_headers]
  }
}

# Included on Gcore CDN Free tier (1 TB/month): blocks common secret and admin-panel probes at the edge.
resource "gcore_cdn_rule" "block_probes" {
  count       = var.proxied && var.waf_custom_rules ? 1 : 0
  resource_id = gcore_cdn_resource.this[0].id
  name        = "OpsCrew block common probes"
  rule        = "^/(\\\\.env|\\\\.git/|wp-admin|wp-login\\\\.php|xmlrpc\\\\.php|phpmyadmin)"
  rule_type   = 0
  weight      = 0
  active      = true

  options {
    force_return {
      enabled = true
      code    = 403
      body    = "Forbidden"
    }
  }
}

# Gcore Managed DNS records (only when dns.provider is "gcore"): CNAME (flattened at apex by Gcore
# DNS) pointing at the account's Gcore CDN edge target (data.gcore_cdn_client.this[0].cname, e.g.
# cl-xxxx.gcdn.co) when proxied; A/AAAA/CNAME to the server when DNS-only.
resource "gcore_dns_zone_record" "cdn_cname" {
  count  = var.manage_dns && var.proxied ? 1 : 0
  zone   = var.dns_zone
  domain = var.domain
  type   = "CNAME"
  ttl    = 300

  resource_record {
    content = "\${data.gcore_cdn_client.this[0].cname}."
  }
}

resource "gcore_dns_zone_record" "www_cdn_cname" {
  count  = var.manage_dns && var.proxied && var.www ? 1 : 0
  zone   = var.dns_zone
  domain = "www.\${var.domain}"
  type   = "CNAME"
  ttl    = 300

  resource_record {
    content = "\${data.gcore_cdn_client.this[0].cname}."
  }
}

resource "gcore_dns_zone_record" "a" {
  count  = var.manage_dns && !var.proxied && var.ipv4 != null ? 1 : 0
  zone   = var.dns_zone
  domain = var.domain
  type   = "A"
  ttl    = 300

  resource_record {
    content = var.ipv4
  }
}

resource "gcore_dns_zone_record" "aaaa" {
  count  = var.manage_dns && !var.proxied && var.ipv6 != null ? 1 : 0
  zone   = var.dns_zone
  domain = var.domain
  type   = "AAAA"
  ttl    = 300

  resource_record {
    content = var.ipv6
  }
}

resource "gcore_dns_zone_record" "www_cname" {
  count  = var.manage_dns && !var.proxied && var.www ? 1 : 0
  zone   = var.dns_zone
  domain = "www.\${var.domain}"
  type   = "CNAME"
  ttl    = 300

  resource_record {
    content = "\${var.domain}."
  }
}
`;

const OUTPUTS_TF = `output "cdn_resource_id" {
  description = "Numeric Gcore CDN resource id (null when DNS-only)."
  value       = one(gcore_cdn_resource.this[*].id)
}

output "url" {
  description = "Public URL of the app."
  value       = "https://\${var.domain}"
}
`;

export const GCORE_EDGE_MODULE_FILES: Readonly<Record<string, string>> = {
  "versions.tf": VERSIONS_TF,
  "variables.tf": VARIABLES_TF,
  "main.tf": MAIN_TF,
  "outputs.tf": OUTPUTS_TF,
};
