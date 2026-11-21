locals {
  # OVHcloud names an SSH key by its name, so another server of the app passes the deploy key's
  # name (ssh_key_id). It is known before apply, so the key's count below is known too.
  ssh_key_name = coalesce(var.ssh_key_id, one(ovh_cloud_ssh_key.deploy[*].name))

  # The model and the image by name: their ids differ from one region to another.
  flavor_id = one([for flavor in data.ovh_cloud_instance_flavors.this.flavors : flavor.id if flavor.name == var.server_type])
  image_id  = one([for image in data.ovh_cloud_instance_images.this.images : image.id if image.name == var.image])

  web_ports = [
    { description = "HTTP", protocol = "TCP", port = 80 },
    { description = "HTTPS", protocol = "TCP", port = 443 },
    { description = "HTTP/3", protocol = "UDP", port = 443 },
  ]

  # A security group rule has one source of one IP family, so each port gets one rule per network.
  rules = concat(
    # SSH from the allowed networks; no rule once public SSH is closed (an empty list), when SSH
    # answers on the app's private network only.
    [
      for cidr in var.ssh_allowed_cidrs :
      { description = "SSH", protocol = "TCP", port = 22, cidr = cidr }
    ],
    # Ports 80 and 443, only on a server that serves the web.
    flatten([
      for rule in var.web ? local.web_ports : [] :
      [for cidr in var.http_allowed_cidrs : merge(rule, { cidr = cidr })]
    ]),
    [
      { description = "Ping", protocol = "ICMP", port = null, cidr = "0.0.0.0/0" },
      { description = "Ping", protocol = "ICMPV6", port = null, cidr = "::/0" },
    ],
    # WireGuard answers nothing without a valid key, and devices roam, so it is open to all.
    flatten([
      for port in var.wireguard_port[*] :
      [for cidr in ["0.0.0.0/0", "::/0"] : { description = "WireGuard", protocol = "UDP", port = port, cidr = cidr }]
    ]),
  )

  # The public interface is the one observed network without an id; its own (fixed) addresses
  # are the server's public IPv4 and IPv6.
  public_addresses = [
    for address in flatten([
      for network in ovh_cloud_instance.this.current_state.networks : network.addresses if network.id == null
    ]) : address if address.type == "FIXED"
  ]
}

data "ovh_cloud_instance_flavors" "this" {
  service_name = var.project_id
  region       = var.location
}

data "ovh_cloud_instance_images" "this" {
  service_name = var.project_id
  region       = var.location
}

# One deploy key serves all the app's servers (its name is unique in the project), so another
# server of the app passes the app server's key (ssh_key_id) and none is created here.
resource "ovh_cloud_ssh_key" "deploy" {
  count        = var.ssh_key_id == null ? 1 : 0
  service_name = var.project_id
  name         = "${var.name}-deploy"
  public_key   = var.ssh_public_key
}

# The server's firewall. OpenStack adds an allow-all outbound rule to every new group by itself,
# outside these rules; nothing else comes in.
resource "ovh_cloud_security_group" "this" {
  service_name = var.project_id
  region       = var.location
  name         = "opscrew-${var.name}"
  description  = "OpsCrew's firewall of ${var.name}."

  rule = [
    for rule in local.rules : {
      direction        = "INGRESS"
      ethernet_type    = strcontains(rule.cidr, ":") ? "IPV6" : "IPV4"
      protocol         = rule.protocol
      port_range_min   = rule.port
      port_range_max   = rule.port
      remote_ip_prefix = rule.cidr
      description      = rule.description
    }
  ]
}

resource "ovh_cloud_instance" "this" {
  service_name = var.project_id
  region       = var.location
  name         = var.name
  flavor_id    = local.flavor_id
  image_id     = local.image_id
  ssh_key_name = local.ssh_key_name

  # Always set: without it OVHcloud puts the server on the project's default group, which lets
  # every connection in.
  security_group_ids = [ovh_cloud_security_group.this.id]

  # A public interface, with the addresses OVHcloud assigns.
  networks = [{ auto_assign_public_ip = true }]

  # The scheduled check's key goes in as a second authorized key (YAML-quoted); none without it.
  user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key  = var.ssh_public_key
    check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
    web             = var.web
  }))

  lifecycle {
    # Changing user_data or image_id reinstalls the server and wipes its disk, and changing
    # ssh_key_name recreates it; OpsCrew never does that silently. A server taken over with an
    # import block has no user_data in the state, which then stays as it is.
    ignore_changes = [user_data, image_id, ssh_key_name]
  }
}
