output "ipv4_address" {
  description = "Public IPv4 address of the server."
  value       = one([for ip in kamatera_server.this.public_ips : ip if !strcontains(ip, ":")])
}

output "ipv6_address" {
  description = "Public IPv6 address of the server, or null when it has none."
  value       = one([for ip in kamatera_server.this.public_ips : ip if strcontains(ip, ":")])
}

# Kamatera reaches a server by its name, which is also its Terraform id after a create.
output "server_id" {
  description = "Name of the server, by which OpsCrew finds it at Kamatera."
  value       = kamatera_server.this.name
}

output "server_name" {
  description = "Server name."
  value       = kamatera_server.this.name
}

# The root module reads every server module's deploy key from ssh_key_id. Kamatera keeps no copy
# of a key, so this is the key's public half, which the app's other servers take as text too.
output "ssh_key_id" {
  description = "Public half of the deploy key, for the app's other servers on Kamatera."
  value       = var.ssh_public_key
}
