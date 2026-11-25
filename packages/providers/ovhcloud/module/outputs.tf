output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = one([for address in local.public_addresses : address.ip if address.version == 4])
}

output "ipv6_address" {
  description = "Public IPv6 address of the server, or null when it has none."
  value       = one([for address in local.public_addresses : address.ip if address.version == 6])
}

output "server_id" {
  description = "OVHcloud instance id."
  value       = ovh_cloud_instance.this.id
}

output "server_name" {
  description = "Server name."
  value       = ovh_cloud_instance.this.name
}

# The root module reads every server module's deploy key from ssh_key_id. OVHcloud names a key by
# its name, so this holds the name.
output "ssh_key_id" {
  description = "Name of the deploy key, for the app's other servers on OVHcloud."
  value       = local.ssh_key_name
}
