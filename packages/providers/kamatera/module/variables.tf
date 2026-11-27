variable "name" {
  description = "Server name, which is also its Terraform id at Kamatera: 4 to 40 letters, digits, dashes or dots."
  type        = string
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

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed in its firewall."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network; null for none."
  type        = number
  default     = null
}

variable "ssh_key_id" {
  description = "Unused: Kamatera keeps no copy of a key, so every server takes the deploy key's text (ssh_public_key). OpsCrew passes the app's other servers the same text here."
  type        = string
  default     = null
}
