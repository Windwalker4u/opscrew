variable "name" {
  description = "Server name; also names its security group (opscrew-<name>) and SSH key (<name>-deploy)."
  type        = string
}

variable "project_id" {
  description = "Id of the Public Cloud project that holds the server, its security group and its SSH key."
  type        = string
}

variable "location" {
  description = "OVHcloud Public Cloud region, for example GRA11."
  type        = string
}

variable "server_type" {
  description = "OVHcloud model (flavor name) of the server, for example d2-4; its id is looked up in the region."
  type        = string
}

variable "image" {
  description = "Name of the operating system image at OVHcloud (Ubuntu 24.04); its id is looked up in the region."
  type        = string
}

variable "ssh_public_key" {
  description = "Public half of the OpsCrew deploy key (ssh-ed25519 ...)."
  type        = string
}

variable "check_key_line" {
  description = "The scheduled check's authorized_keys line for the deploy user (its key, restricted to OpsCrew's read-only command for the disk and the scheduled snapshots), written at the first boot; empty for none."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (port 22); empty for no SSH rule (public SSH closed)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "http_allowed_cidrs" {
  description = "Networks allowed to reach HTTP/HTTPS (ports 80 and 443)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "web" {
  description = "Whether the server serves the web: false leaves ports 80 and 443 closed, in the security group and in ufw."
  type        = bool
  default     = true
}

variable "wireguard_port" {
  description = "UDP port of the app's private WireGuard network, open to everyone; null for none."
  type        = number
  default     = null
}

variable "ssh_key_id" {
  description = "Name of the deploy key when another server of the app or the root module already holds it (OVHcloud names an SSH key by its name, unique in the project); null creates the key here."
  type        = string
  default     = null
}
