/**
 * Typed Bunny.net Core Platform API client (`https://api.bunny.net`, `AccessKey` header).
 * Every API response is validated with zod before use (constitution V), and the API key and any
 * origin-verification token are registered with the redactor so they never appear in errors or logs.
 */
import type { CredentialCheck, FetchLike } from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { z } from "zod";

export const BUNNY_API_BASE = "https://api.bunny.net";
export const BUNNY_API_KEY_URL = "https://dash.bunny.net/account/api-key";

/** Bunny Edge Rule ActionType integer for `SetRequestHeader` (official Bunny.net Core API). */
export const BUNNY_ACTION_SET_REQUEST_HEADER = 6;
/** Bunny Edge Rule Trigger Type integer for `Url` wildcard match. */
export const BUNNY_TRIGGER_URL = 0;

/** Description marking OpsCrew's connector-managed origin-verification header rule. */
export const OPSCREW_ORIGIN_HEADER_DESCRIPTION = "OpsCrew origin verification header";

const BunnyDnsZoneSchema = z.object({
  Id: z.number().int(),
  Domain: z.string().min(1),
});

const BunnyDnsZoneListSchema = z.object({
  Items: z.array(BunnyDnsZoneSchema),
});

const BunnyEdgeRuleTriggerSchema = z.object({
  Type: z.number().int(),
  PatternMatches: z.array(z.string()).default([]),
  Parameter1: z.string().nullable().optional(),
});

const BunnyEdgeRuleSchema = z.object({
  Guid: z.string().min(1),
  ActionType: z.number().int(),
  ActionParameter1: z.string().nullable().optional(),
  ActionParameter2: z.string().nullable().optional(),
  ActionParameter3: z.string().nullable().optional(),
  Description: z.string().nullable().optional(),
  Enabled: z.boolean().default(true),
  Triggers: z.array(BunnyEdgeRuleTriggerSchema).default([]),
});

const BunnyPullZoneSchema = z.object({
  Id: z.number().int(),
  Name: z.string().min(1),
  EdgeRules: z.array(BunnyEdgeRuleSchema).default([]),
});

export type BunnyDnsZone = { id: number; domain: string };
export type BunnyEdgeRule = z.infer<typeof BunnyEdgeRuleSchema>;

export interface BunnyClientDeps {
  apiKey: string;
  fetch?: FetchLike;
  redactor?: Pick<Redactor, "addLiteral" | "redact">;
  baseUrl?: string;
}

export interface BunnyClient {
  verifyCredentials(): Promise<CredentialCheck>;
  findDnsZone(domain: string): Promise<BunnyDnsZone | undefined>;
  listEdgeRules(pullZoneId: number): Promise<BunnyEdgeRule[]>;
  upsertOriginHeaderRule(input: {
    pullZoneId: number;
    guid?: string;
    headerName: string;
    token: string;
  }): Promise<void>;
  deleteEdgeRule(pullZoneId: number, guid: string): Promise<void>;
}

/** Creates a typed Bunny.net API client authenticating via `AccessKey`. */
export function bunnyClient(deps: BunnyClientDeps): BunnyClient {
  const apiKey = deps.apiKey.trim();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = (deps.baseUrl ?? BUNNY_API_BASE).replace(/\/+$/, "");
  const redactor = deps.redactor ?? new Redactor();
  if (apiKey.length > 0) redactor.addLiteral(apiKey, "bunny-api-key");

  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    if (apiKey.length === 0) {
      throw new OpsCrewError("CREDENTIALS_MISSING", "BUNNYNET_API_KEY is not set.", {
        hint: `Create an API key at ${BUNNY_API_KEY_URL} and set BUNNYNET_API_KEY, then try again.`,
      });
    }
    const headers: Record<string, string> = {
      AccessKey: apiKey,
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
        `Bunny.net rejected BUNNYNET_API_KEY (HTTP ${response.status}).`,
        {
          hint: `Check BUNNYNET_API_KEY at ${BUNNY_API_KEY_URL} and make sure it is your account API key, then try again.`,
        },
      );
    }
    if (!response.ok) {
      const detail = redactor.redact((await response.text()).slice(0, 200));
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Bunny.net API ${method} ${path} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
        { hint: "Check Bunny.net's status page and your account settings, then try again." },
      );
    }
    return response;
  }

  async function readJson<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new OpsCrewError("PROVIDER_ERROR", `Bunny.net returned non-JSON for ${label}.`, {
        cause: error,
        hint: "Retry in a moment; if it keeps failing, check Bunny.net's API status.",
      });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Bunny.net returned an unexpected ${label} response.`,
        {
          hint: "Retry in a moment or report this response shape mismatch.",
        },
      );
    }
    return parsed.data;
  }

  return {
    async verifyCredentials(): Promise<CredentialCheck> {
      if (apiKey.length === 0) {
        return {
          ok: false,
          message: `BUNNYNET_API_KEY is not set. Create one at ${BUNNY_API_KEY_URL}.`,
        };
      }
      try {
        const res = await fetchImpl(`${baseUrl}/dnszone?page=1&perPage=1`, {
          method: "GET",
          headers: { AccessKey: apiKey, Accept: "application/json" },
        });
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message: `Bunny.net rejected BUNNYNET_API_KEY (HTTP ${res.status}). Check your account API key at ${BUNNY_API_KEY_URL}.`,
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            message: `Bunny.net API answered HTTP ${res.status} while verifying BUNNYNET_API_KEY.`,
          };
        }
        await readJson(res, BunnyDnsZoneListSchema, "DNS zone list");
        return { ok: true, message: "Bunny.net API key verified." };
      } catch (error) {
        return {
          ok: false,
          message: redactor.redact(
            `Could not verify BUNNYNET_API_KEY: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
    },

    async findDnsZone(domain: string): Promise<BunnyDnsZone | undefined> {
      const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
      const res = await request("GET", "/dnszone?page=1&perPage=1000");
      const list = await readJson(res, BunnyDnsZoneListSchema, "DNS zone list");
      const matches = list.Items.filter((item) => {
        const zone = item.Domain.toLowerCase();
        return normalized === zone || normalized.endsWith(`.${zone}`);
      }).sort((a, b) => b.Domain.length - a.Domain.length);
      const best = matches[0];
      return best === undefined ? undefined : { id: best.Id, domain: best.Domain };
    },

    async listEdgeRules(pullZoneId: number): Promise<BunnyEdgeRule[]> {
      const res = await request("GET", `/pullzone/${pullZoneId}`);
      const zone = await readJson(res, BunnyPullZoneSchema, "Pull Zone");
      return zone.EdgeRules;
    },

    async upsertOriginHeaderRule(input): Promise<void> {
      redactor.addLiteral(input.token, "edge-origin-token");
      await request("POST", `/pullzone/${input.pullZoneId}/edgerules/addOrUpdate`, {
        ...(input.guid === undefined ? {} : { Guid: input.guid }),
        ActionType: BUNNY_ACTION_SET_REQUEST_HEADER,
        ActionParameter1: input.headerName,
        ActionParameter2: input.token,
        ActionParameter3: null,
        Description: OPSCREW_ORIGIN_HEADER_DESCRIPTION,
        Enabled: true,
        Triggers: [
          {
            Type: BUNNY_TRIGGER_URL,
            PatternMatches: ["*"],
            Parameter1: "",
          },
        ],
      });
    },

    async deleteEdgeRule(pullZoneId: number, guid: string): Promise<void> {
      await request("DELETE", `/pullzone/${pullZoneId}/edgerules/${encodeURIComponent(guid)}`);
    },
  };
}
