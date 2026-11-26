/**
 * Server reverse-proxy snippets for `shared-header` edge providers (ADR 0038 D6, Bunny.net / Gcore).
 *
 * Security invariants:
 * - The secret token(s) NEVER appear in committed site files or Terraform state. They live in
 *   `/srv/edge/tls/<app>/origin-token.<ext>` (mode 0600 on the server), written at deploy/rotate
 *   from `OPSCREW_EDGE_ORIGIN_TOKEN` (1 or 2 lines of 64 lower-case hex characters).
 * - Every proxy rejects requests missing an exact matching header value with HTTP 403 BEFORE
 *   forwarding to `kamal-proxy` and BEFORE trusting the edge's visitor-IP header (`realIpHeader`).
 * - During `opscrew rotate`, passing `[newToken, oldToken]` accepts both values seamlessly until
 *   the edge switches and the server narrows to `[newToken]`.
 */
import { OpsCrewError } from "@opscrew/core";
import type { EdgeProxy } from "./index";

/** Default HTTP header carrying OpsCrew's shared origin-verification secret. */
export const ORIGIN_TOKEN_HEADER = "X-OpsCrew-Origin-Token";

/** File name inside `/srv/edge/tls/<app>/` for each reverse proxy. */
export const ORIGIN_TOKEN_FILE: Record<EdgeProxy, string> = {
  caddy: "origin-token.caddy",
  nginx: "origin-token.conf",
  openlitespeed: "origin-token.conf",
};

/** Information passed to site renderers when `originAuth` is `"shared-header"`. */
export interface SharedOriginHeader {
  /** Header verified on every request (for example `X-OpsCrew-Origin-Token`). */
  headerName: string;
  /** Visitor-IP header trusted ONLY after `headerName` passes (for example `X-Real-IP`). */
  realIpHeader: string;
  /** Container path to the 0600 snippet file included/imported by the site config. */
  file: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Path to the 0600 origin-token snippet inside the proxy container. */
export function originTokenContainerPath(proxy: EdgeProxy, app: string): string {
  const dir =
    proxy === "caddy"
      ? `/etc/caddy/tls/${app}`
      : proxy === "nginx"
        ? `/etc/nginx/tls/${app}`
        : `/etc/opscrew/tls/${app}`;
  return `${dir}/${ORIGIN_TOKEN_FILE[proxy]}`;
}

/** Path to the 0600 origin-token snippet on the host server (`/srv/edge/tls/<app>/...`). */
export function originTokenServerPath(proxy: EdgeProxy, app: string): string {
  return `/srv/edge/tls/${app}/${ORIGIN_TOKEN_FILE[proxy]}`;
}

/** nginx `$http_<name>` variable for an HTTP header name. */
export function nginxHeaderVar(headerName: string): string {
  return `$http_${headerName.toLowerCase().replaceAll("-", "_")}`;
}

/**
 * Renders the server-side 0600 snippet file for `proxy` enforcing `headerName` against one or two
 * 64-char hex `tokens` (one normally, two during zero-downtime rotation).
 */
export function originTokenSnippet(
  proxy: EdgeProxy,
  headerName: string,
  tokens: readonly string[],
): string {
  if (!HEADER_RE.test(headerName)) {
    throw new OpsCrewError("INVALID_INPUT", `Invalid origin-auth header name "${headerName}".`);
  }
  if (tokens.length === 0 || tokens.length > 2) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Expected 1 or 2 origin-verification tokens (current, and optionally previous during rotation).",
    );
  }
  for (const token of tokens) {
    if (!HEX_64.test(token)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "Each origin-verification token must be 64 lower-case hexadecimal characters.",
      );
    }
  }
  const pattern = tokens.join("|");
  if (proxy === "caddy") {
    return [
      "@bad_origin_token {",
      "\tnot path /.well-known/acme-challenge/*",
      `\tnot header_regexp ${headerName} ^(${pattern})$`,
      "}",
      "respond @bad_origin_token 403",
      "",
    ].join("\n");
  }
  if (proxy === "nginx") {
    const variable = nginxHeaderVar(headerName);
    return [`if (${variable} !~ "^(${pattern})$") {`, "\treturn 403;", "}", ""].join("\n");
  }
  // OpenLiteSpeed rewriteFile loaded inside top-level `rewrite { rules ... }` (runs before both
  // `context /` and `websocket /`, while keeping certbot's HTTP-01 challenge reachable).
  return [
    "RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/",
    `RewriteCond %{HTTP:${headerName}} !^(${pattern})$`,
    "RewriteRule ^ - [F]",
    "",
  ].join("\n");
}
