import { providerCatalogue } from "@opscrew/agents";
import { listText, orText } from "@opscrew/core";
import type { CatalogueProvider } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";

interface ProvidersFlags {
  json?: boolean;
}

/** One provider in a line: its id, kind, name and the variables it needs. */
function line(provider: CatalogueProvider, width: { id: number; kind: number }): string {
  const { mode, variables } = provider.credentials;
  const names = variables.map((variable) => variable.name);
  return `${provider.id.padEnd(width.id)}  ${provider.kind.padEnd(width.kind)}  ${provider.name}: ${mode === "all" ? listText(names) : orText(names)}`;
}

/**
 * `opscrew providers`: the cloud server providers, Cloudflare and the registrars OpsCrew works
 * with, one line each; with `--json`, the whole catalogue (`ProviderCatalogueSchema`) for tools.
 * It reads no network, no credential and no project: the prices are OpsCrew's dated built-in
 * lists, so one version always prints the same catalogue.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("providers")
    .description("List the providers OpsCrew works with and what each one needs")
    .option(
      "--json",
      "Print the catalogue as JSON, for tools: credentials, sizes and built-in prices",
    )
    .action(async (flags: ProvidersFlags) => {
      const catalogue = await providerCatalogue(ctx.version);
      if (flags.json === true) {
        ctx.stdout(`${JSON.stringify(catalogue, null, 2)}\n`);
        return;
      }
      const { providers } = catalogue;
      const width = {
        id: Math.max(...providers.map((provider) => provider.id.length)),
        kind: Math.max(...providers.map((provider) => provider.kind.length)),
      };
      ctx.stdout(`${providers.map((provider) => line(provider, width)).join("\n")}\n`);
    });
}
