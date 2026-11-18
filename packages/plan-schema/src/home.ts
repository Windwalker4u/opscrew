import type { z } from "zod";

/** The parts of a plan the rules of a server at home read. */
interface HomeFields {
  target: { provider: string; access?: string; home?: { ipv4: boolean } };
  dns: { domain?: string };
  environment?: { runner: string; previews?: unknown };
  servers?: unknown[];
  network?: unknown;
}

/**
 * The rules of a server at the user's home (`target.home`): it serves at the home's own address,
 * on one server with a domain, and deploys without inbound SSH from the internet.
 */
export function checkHome(plan: HomeFields, ctx: z.RefinementCtx): void {
  const { target, environment } = plan;
  if (target.provider !== "own" || target.home === undefined) return;
  const issue = (path: string[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if (target.access === "tunnel") {
    issue(
      ["target", "home"],
      'through the tunnel, a server at home needs no home: remove target.home, or set target.access to "public" to serve the app at your home\'s own address',
    );
  }
  if (environment?.previews !== undefined) {
    issue(
      ["target", "home"],
      "previews can't run on a server at home: their wildcard record would point at an address that changes; remove target.home, or run the previews on a cloud server",
    );
  }
  if ((environment?.runner ?? "github") === "github") {
    issue(
      ["environment", "runner"],
      'must not be "github" with a server at home: GitHub\'s machines can\'t reach a server whose SSH is closed to the internet; set it to "server" (a runner on the server) or "host" (a runner machine in your home)',
    );
  }
  if (plan.servers !== undefined) {
    issue(
      ["servers"],
      "extra servers can't go with a server at home: remove servers and keep the app's services on the server at home",
    );
  }
  if (plan.network !== undefined) {
    issue(["network"], "the private network can't go with a server at home yet: remove network");
  }
  if (plan.dns.domain === undefined) {
    issue(
      ["dns", "domain"],
      "is required with a server at home: a server at home needs a domain, whose record the address updater keeps or you add at your DNS provider; set dns.domain to it",
    );
  }
}
