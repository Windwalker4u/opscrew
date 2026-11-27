locals {
  # OpsCrew's plans as Kamatera's configurations: Kamatera sells a CPU type, a number of cores, the
  # memory and the disks rather than named sizes, so the plan's id stays OpsCrew's own. Type A
  # shares its threads with other servers; type B has them to itself. One disk, the system's.
  plans = {
    "A-1-2" = { cpu_type = "A", cpu_cores = 1, ram_mb = 2048, disk_sizes_gb = [40] }
    "A-2-4" = { cpu_type = "A", cpu_cores = 2, ram_mb = 4096, disk_sizes_gb = [40] }
    "A-4-8" = { cpu_type = "A", cpu_cores = 4, ram_mb = 8192, disk_sizes_gb = [80] }
    "B-1-2" = { cpu_type = "B", cpu_cores = 1, ram_mb = 2048, disk_sizes_gb = [40] }
    "B-2-4" = { cpu_type = "B", cpu_cores = 2, ram_mb = 4096, disk_sizes_gb = [40] }
    "B-4-8" = { cpu_type = "B", cpu_cores = 4, ram_mb = 8192, disk_sizes_gb = [80] }
  }
  plan = local.plans[var.server_type]

  # Kamatera's image data source takes an operating system and a code, not an image's name.
  images = {
    "Ubuntu 24.04" = { os = "Ubuntu", code = "24.04 64bit" }
  }
  image = local.images[var.image]
}

data "kamatera_image" "this" {
  datacenter_id = var.location
  os            = local.image.os
  code          = local.image.code
}

# Kamatera has no cloud firewall that Terraform or its API can set, so the server's own firewall,
# set up by the first boot, is its only one.
resource "kamatera_server" "this" {
  name          = var.name
  datacenter_id = var.location
  image_id      = data.kamatera_image.this.id
  cpu_type      = local.plan.cpu_type
  cpu_cores     = local.plan.cpu_cores
  ram_mb        = local.plan.ram_mb
  disk_sizes_gb = local.plan.disk_sizes_gb

  # Billed by the minute at the monthly price divided by 730, until the server is terminated; a
  # stopped server still bills its address and its disk.
  billing_cycle = "hourly"

  # The deploy key's text: Kamatera keeps no copy of a key. No password is set, so Kamatera
  # generates the root password, which its provider keeps in the state as generated_password.
  ssh_pubkey = var.ssh_public_key

  # Kamatera takes no cloud-init user data, so the shared first boot runs as the startup script,
  # which applies the same cloud-config through cloud-init. The scheduled check's key goes in as a
  # second authorized key (YAML-quoted); none without it.
  startup_script = templatefile("${path.module}/first-boot.sh.tftpl", {
    cloud_config_b64 = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      ssh_public_key  = var.ssh_public_key
      check_key_entry = var.check_key_line == "" ? "" : "\n      - ${jsonencode(var.check_key_line)}"
      web             = var.web
    }))
  })

  daily_backup   = false
  power_on       = true
  allow_recreate = false

  lifecycle {
    # A changed image, key or startup script would make a new server, and its disk with it;
    # OpsCrew never does that silently. A server taken over with an import block has no key or
    # startup script in the state, which then stays as it is.
    ignore_changes = [image_id, ssh_pubkey, startup_script]
  }
}
