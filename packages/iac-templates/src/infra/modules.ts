import type { ProviderTerraform } from "@opscrew/contracts";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { MODULE_FILES as OWN_MODULE_FILES, SERVER_MODULE_FILES } from "../generated/modules";
import { FIRST_BOOT_SCRIPT } from "./first-boot";

/**
 * The files of one provider's server module: its own, and the files OpsCrew adds to every server
 * module (the first boot's `cloud-init.yaml.tftpl`, ADR 0029 D5). A provider whose servers take the
 * first boot as a startup script also gets `first-boot.sh.tftpl` (D12); the others never do.
 */
export function serverModuleFiles(
  terraform: Pick<ProviderTerraform, "module" | "firstBoot">,
): Record<string, string> {
  const shared = Object.entries(SERVER_MODULE_FILES).filter(
    ([path]) => path !== FIRST_BOOT_SCRIPT || terraform.firstBoot === "script",
  );
  return { ...terraform.module.files, ...Object.fromEntries(shared) };
}

/**
 * Every module OpsCrew vendors beside a root module, by `<module>/<path>`: its own (Cloudflare's),
 * and each cloud provider's server module with the files OpsCrew adds to it (ADR 0029 D5 and D12).
 */
export const MODULE_FILES: Readonly<Record<string, string>> = Object.fromEntries([
  ...Object.entries(OWN_MODULE_FILES),
  ...CLOUD_PROVIDERS.flatMap(({ terraform }) =>
    Object.entries(serverModuleFiles(terraform)).map(
      ([path, content]) => [`${terraform.module.name}/${path}`, content] as const,
    ),
  ),
]);
