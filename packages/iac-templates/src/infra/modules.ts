import { EDGE_PROVIDERS } from "@opscrew/edge-providers";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { MODULE_FILES as OWN_MODULE_FILES, SERVER_MODULE_FILES } from "../generated/modules";

/**
 * Every module OpsCrew vendors beside a root module, by `<module>/<path>`: its own (Cloudflare's),
 * each edge provider's module from its definition (e.g. `bunny-edge`), and each cloud provider's
 * server module from its definition with the files OpsCrew adds to every server module (the first
 * boot's `cloud-init.yaml.tftpl`, ADR 0029 D5).
 */
export const MODULE_FILES: Readonly<Record<string, string>> = Object.fromEntries([
  ...Object.entries(OWN_MODULE_FILES),
  ...EDGE_PROVIDERS.flatMap(({ terraform: { module } }) =>
    module === undefined
      ? []
      : Object.entries(module.files).map(
          ([path, content]) => [`${module.name}/${path}`, content] as const,
        ),
  ),
  ...CLOUD_PROVIDERS.flatMap(({ terraform: { module } }) =>
    Object.entries({ ...module.files, ...SERVER_MODULE_FILES }).map(
      ([path, content]) => [`${module.name}/${path}`, content] as const,
    ),
  ),
]);
