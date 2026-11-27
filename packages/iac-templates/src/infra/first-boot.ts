import { SERVER_MODULE_FILES } from "../generated/modules";
import { templatefile } from "./cloud-init";

/**
 * The file OpsCrew adds to a server module's folder when its provider takes the first boot as a
 * startup script (ADR 0029, D12). It is the other providers' `cloud-init.yaml.tftpl`, wrapped.
 */
export const FIRST_BOOT_SCRIPT = "first-boot.sh.tftpl";

/** Where `first-boot.sh.tftpl` logs on the server, the server firewall's step included. */
export const FIRST_BOOT_LOG = "/var/log/opscrew-first-boot.log";

/** The variable the module's `templatefile` of `first-boot.sh.tftpl` fills (HCL's `base64encode`). */
export const FIRST_BOOT_CONFIG = "cloud_config_b64";

/**
 * Renders `first-boot.sh.tftpl` the way the module's `templatefile` does: the cloud-config, which
 * is the same file every other provider gets, base64-encoded into the wrapper that runs it through
 * cloud-init. Base64 keeps the YAML's own `$` and quotes out of the shell's reach. `serverFirewall`
 * is the server firewall's step (`renderServerFirewall`), which runs first; none for a provider
 * with a cloud firewall.
 */
export function renderFirstBootScript(cloudConfig: string, serverFirewall = ""): string {
  const source = SERVER_MODULE_FILES[FIRST_BOOT_SCRIPT] ?? "";
  return templatefile(source, {
    [FIRST_BOOT_CONFIG]: Buffer.from(cloudConfig, "utf8").toString("base64"),
    server_firewall: serverFirewall,
  });
}
