variable "name" {
  description = "Server name, which is also its Terraform id at Kamatera: 4 to 40 letters, digits, dashes or dots."
  type        = string

  validation {
    # Kamatera's provider takes 4 to 40 characters from a-z, A-Z, 0-9, - and . (resource_server.go).
    condition     = can(regex("^[a-zA-Z0-9.-]{4,40}$", var.name))
    error_message = "Kamatera needs a server name of 4 to 40 letters, digits, dashes or dots, and OpsCrew would name this server \"${var.name}\". Choose a different app name (or extra server's name) so that the server's name fits."
  }
}

variable "location" {
  description = "Kamatera datacenter code, for example EU-FR."
  type        = string
}

variable "server_type" {
  description = "OpsCrew's plan id for the server, for example A-2-4: Kamatera's CPU type, the number of vCPUs and the GB of memory, mapped to Kamatera's configuration in main.tf."
  type        = string
}

variable "image" {
  description = "Operating system image (Ubuntu 24.04), looked up by Kamatera's os and code in the datacenter."
  type        = string
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...), which the server takes as text."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at the first boot; empty for none."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (port 22) through the server's own firewall; empty for none (public SSH closed)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    # The first boot writes each one into the firewall's rules; one that isn't a network would stop
    # it, and the server would power itself off.
    condition     = alltrue([for cidr in var.ssh_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Each network in ssh_allowed_cidrs must be an address range such as 203.0.113.7/32 or 2001:db8::/48. Correct it in the tfvars file, then plan again."
  }
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443) through the server's own firewall."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]

  validation {
    condition     = alltrue([for cidr in var.http_allowed_cidrs : can(cidrhost(cidr, 0))])
    error_message = "Each network in http_allowed_cidrs must be an address range such as 173.245.48.0/20 or 2400:cb00::/32. Correct it in the tfvars file, then plan again."
  }
}

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed, in the server's own firewall and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to everyone in the server's own firewall; null for none."
  type        = number
  default     = null

  validation {
    # A conditional, not ||: an engine that evaluates both sides would compare null.
    condition     = var.wireguard_port == null ? true : var.wireguard_port >= 1 && var.wireguard_port <= 65535 && floor(var.wireguard_port) == var.wireguard_port
    error_message = "The WireGuard port must be a whole number from 1 to 65535, or null for none."
  }
}

variable "ssh_key_id" {
  description = "Unused: Kamatera keeps no copy of a key, so every server takes the deploy key's text (ssh_public_key). OpsCrew passes the app's other servers the same text here."
  type        = string
  default     = null
}
