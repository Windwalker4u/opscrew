/**
 * Typed Gcore API client (`https://api.gcore.com`, `Authorization: APIKey <token>`).
 * Every API response is validated with zod before use (constitution V), and the API token and
 * any origin-verification token are registered with the redactor so they never appear in errors
 * or logs.
 */
import type { CredentialCheck, FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { z } from "zod";

export const GCORE_API_BASE = "https://api.gcore.com";
export const GCORE_API_TOKEN_URL = "https://portal.gcore.com/accounts/profile/api-tokens";

const GcoreDnsZoneSchema = z.object({
  name: z.string().min(1),
});

const GcoreDnsZoneListSchema = z.object({
  zones: z.array(GcoreDnsZoneSchema),
});

const GcoreStaticRequestHeadersSchema = z.object({
  enabled: z.boolean().default(false),
  value: z.record(z.string(), z.string()).default({}),
});

const GcoreCdnResourceSchema = z.object({
  id: z.number().int(),
  cname: z.string().min(1),
  options: z
    .object({
      staticRequestHeaders: GcoreStaticRequestHeadersSchema.nullable().optional(),
    })
    .optional(),
});

export type GcoreDnsZone = { name: string };
export type GcoreCdnResource = z.infer<typeof GcoreCdnResourceSchema>;

export interface GcoreClientDeps {
  apiToken: string;
  fetch?: FetchLike;
  redactor?: Pick<Redactor, "addLiteral" | "redact">;
  baseUrl?: string;
}

export interface GcoreClient {
  verifyCredentials(): Promise<CredentialCheck>;
  findDnsZone(domain: string): Promise<GcoreDnsZone | undefined>;
  getCdnResource(resourceId: number): Promise<GcoreCdnResource>;
  patchStaticRequestHeaders(input: {
    resourceId: number;
    headers: Readonly<Record<string, string>>;
  }): Promise<void>;
}

/** Creates a typed Gcore API client authenticating via `Authorization: APIKey <token>`. */
export function gcoreClient(deps: GcoreClientDeps): GcoreClient {
  const apiToken = deps.apiToken.trim();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = (deps.baseUrl ?? GCORE_API_BASE).replace(/\/+$/, "");
  const redactor = deps.redactor ?? new Redactor();
  if (apiToken.length > 0) redactor.addLiteral(apiToken, "gcore-api-token");

  async function request(method: "GET" | "PATCH", path: string, body?: unknown): Promise<Response> {
    if (apiToken.length === 0) {
      throw new OpsCrewError("CREDENTIALS_MISSING", "GCORE_PERMANENT_API_TOKEN is not set.", {
        hint: `Create a permanent API token at ${GCORE_API_TOKEN_URL} and set GCORE_PERMANENT_API_TOKEN, then try again.`,
      });
    }
    const headers: Record<string, string> = {
      Authorization: `APIKey ${apiToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    };
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `Gcore rejected GCORE_PERMANENT_API_TOKEN (HTTP ${response.status}).`,
        {
          hint: `Check GCORE_PERMANENT_API_TOKEN at ${GCORE_API_TOKEN_URL} and ensure it has CDN and DNS permissions, then try again.`,
        },
      );
    }
    if (!response.ok) {
      const detail = redactor.redact((await response.text()).slice(0, 200));
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Gcore API ${method} ${path} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
        { hint: "Check Gcore's status page and account settings, then try again." },
      );
    }
    return response;
  }

  async function readJson<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new OpsCrewError("PROVIDER_ERROR", `Gcore returned non-JSON for ${label}.`, {
        cause: error,
        hint: "Retry in a moment; if it keeps failing, check Gcore's API status.",
      });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new OpsCrewError("PROVIDER_ERROR", `Gcore returned an unexpected ${label} response.`, {
        hint: "Retry in a moment or report this response shape mismatch.",
      });
    }
    return parsed.data;
  }

  return {
    async verifyCredentials(): Promise<CredentialCheck> {
      if (apiToken.length === 0) {
        return {
          ok: false,
          message: `GCORE_PERMANENT_API_TOKEN is not set. Create one at ${GCORE_API_TOKEN_URL}.`,
        };
      }
      try {
        const res = await fetchImpl(`${baseUrl}/dns/v2/zones?limit=1`, {
          method: "GET",
          headers: { Authorization: `APIKey ${apiToken}`, Accept: "application/json" },
        });
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message: `Gcore rejected GCORE_PERMANENT_API_TOKEN (HTTP ${res.status}). Check your permanent API token at ${GCORE_API_TOKEN_URL}.`,
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            message: `Gcore API answered HTTP ${res.status} while verifying GCORE_PERMANENT_API_TOKEN.`,
          };
        }
        await readJson(res, GcoreDnsZoneListSchema, "DNS zone list");
        return { ok: true, message: "Gcore permanent API token verified." };
      } catch (error) {
        return {
          ok: false,
          message: redactor.redact(
            `Could not verify GCORE_PERMANENT_API_TOKEN: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
    },

    async findDnsZone(domain: string): Promise<GcoreDnsZone | undefined> {
      const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
      const res = await request("GET", "/dns/v2/zones?limit=1000");
      const list = await readJson(res, GcoreDnsZoneListSchema, "DNS zone list");
      const matches = list.zones
        .filter((item) => {
          const zone = item.name.toLowerCase();
          return normalized === zone || normalized.endsWith(`.${zone}`);
        })
        .sort((a, b) => b.name.length - a.name.length);
      const best = matches[0];
      return best === undefined ? undefined : { name: best.name };
    },

    async getCdnResource(resourceId: number): Promise<GcoreCdnResource> {
      const res = await request("GET", `/cdn/resources/${resourceId}`);
      return readJson(res, GcoreCdnResourceSchema, "CDN resource");
    },

    async patchStaticRequestHeaders(input): Promise<void> {
      for (const value of Object.values(input.headers)) {
        if (value.length >= 32) redactor.addLiteral(value, "edge-origin-token");
      }
      await request("PATCH", `/cdn/resources/${input.resourceId}`, {
        options: {
          staticRequestHeaders: {
            enabled: true,
            value: input.headers,
          },
        },
      });
    },
  };
}
