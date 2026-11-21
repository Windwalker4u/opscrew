import type { FetchLike, ProviderRedactor } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  changedApiHint,
  durationText,
  type ErrorCode,
  type JsonClient,
  jsonClient,
  listText,
  lowerFirst,
  OpsCrewError,
  RATE_LIMIT_HINT,
  type RequestFailure,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";

/** The only OVHcloud zone OpsCrew supports: OVHcloud Europe. */
export const OVHCLOUD_ENDPOINT = "ovh-eu";
/**
 * OVHcloud Europe's API. Paths start with `/v1/` or `/v2/` (go-ovh `ovh/ovh.go`: `OvhEU` is
 * `<this>/1.0`, and a path starting with `/v1/` or `/v2/` replaces the `/1.0`).
 */
export const OVHCLOUD_API_URL = "https://api.eu.ovhcloud.com";
/** OVHcloud Europe's OAuth2 token endpoint (go-ovh `tokensURLs`). */
export const OVHCLOUD_TOKEN_URL = "https://auth.eu.ovhcloud.com/oauth2/token";
/** OVHcloud's guide to service accounts: how to create one and give it rights. */
export const OVHCLOUD_CREDENTIALS_URL =
  "https://docs.ovhcloud.com/en/guides/manage-and-operate/api/manage-service-account";

/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A token is renewed this long before OVHcloud says it expires, so none expires in flight. */
const TOKEN_MARGIN_MS = 30_000;
/** The wait before repeating a read OVHcloud answered with 429 and no usable `Retry-After`. */
const RATE_LIMIT_WAIT_MS = 2_000;
/** Longest wait after a 429, whatever `Retry-After` says. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** The four environment variables of OVHcloud's credentials, all needed. */
export const OVHCLOUD_ENV = {
  endpoint: "OVH_ENDPOINT",
  clientId: "OVH_CLIENT_ID",
  clientSecret: "OVH_CLIENT_SECRET",
  projectId: "OVH_CLOUD_PROJECT_SERVICE",
} as const;

/** How to create the credentials and where they go. */
export const OVHCLOUD_CREDENTIALS_HINT = `In the OVHcloud control panel, create a service account (Identity and Access Management → Identities → Service accounts; see ${OVHCLOUD_CREDENTIALS_URL}) and give it an IAM policy on your Public Cloud project. Then set ${OVHCLOUD_ENV.clientId} and ${OVHCLOUD_ENV.clientSecret} to its id and secret, ${OVHCLOUD_ENV.projectId} to your Public Cloud project's id and ${OVHCLOUD_ENV.endpoint} to ${OVHCLOUD_ENDPOINT}.`;

/** Where a missing right is added, for the hints. */
const IAM_POLICIES = "the control panel: Identity and Access Management → Policies";

/** OVHcloud's credentials: a service account and the Public Cloud project it works in. */
export interface OvhcloudCredentials {
  clientId: string;
  clientSecret: string;
  /** The Public Cloud project's id (`OVH_CLOUD_PROJECT_SERVICE`). */
  projectId: string;
}

/**
 * The credentials from `env`, each value registered with `redactor` as soon as it is read, or a
 * plain-English `problem`: the variables that are missing (empty or blank), or an `OVH_ENDPOINT`
 * other than `ovh-eu`. Without credentials nothing calls OVHcloud.
 */
export function readOvhcloudCredentials(
  env: Record<string, string | undefined>,
  redactor: ProviderRedactor,
): { credentials: OvhcloudCredentials } | { problem: string } {
  const values: Partial<Record<keyof typeof OVHCLOUD_ENV, string>> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(OVHCLOUD_ENV) as [keyof typeof OVHCLOUD_ENV, string][]) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
      continue;
    }
    redactor.addLiteral(value, name);
    values[key] = value;
  }
  if (missing.length > 0) {
    const verb = missing.length === 1 ? "is" : "are";
    return {
      problem: `${listText(missing)} ${verb} not set: OVHcloud needs all four. ${OVHCLOUD_CREDENTIALS_HINT}`,
    };
  }
  if (values.endpoint !== OVHCLOUD_ENDPOINT) {
    return {
      problem: `${OVHCLOUD_ENV.endpoint} must be ${OVHCLOUD_ENDPOINT}: OpsCrew works only with OVHcloud Europe accounts. Set ${OVHCLOUD_ENV.endpoint}=${OVHCLOUD_ENDPOINT} and use a service account of an OVHcloud Europe account.`,
    };
  }
  const { clientId, clientSecret, projectId } = values as Required<typeof values>;
  return { credentials: { clientId, clientSecret, projectId } };
}

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

/** The token answer (OVHcloud's service-account guide: `access_token`, `token_type`, `expires_in`). */
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  /** Seconds (3599 in the guide's example). */
  expires_in: z.number().positive(),
});

const tokenErrorSchema = z.looseObject({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/** OVHcloud's error answer (go-ovh `ovh/error.go`: `class`, `message`, `details`). */
const errorBodySchema = z.looseObject({
  class: z.string().optional(),
  message: z.string().optional(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** The `details` keys that name the actions a missing right refused (go-ovh `ovh/error.go`). */
const REFUSED_ACTION_KEYS = ["unauthorizedActionsByAuthentication", "unauthorizedActionsByIAM"];

// --- Client -------------------------------------------------------------------------------------

/** A path of OVHcloud's API, under its v1 or its v2 base. */
export type OvhcloudPath = `/v1/${string}` | `/v2/${string}`;

export interface OvhcloudClientOptions {
  credentials: OvhcloudCredentials;
  /** Masks the credentials (and the access tokens, registered as they come) in every error. */
  redactor: ProviderRedactor;
  fetch?: FetchLike;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay, used after a 429. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for the token's expiry and `Retry-After`. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 30 seconds). */
  timeoutMs?: number;
}

/** Thrown inside a request whose token OVHcloud refused, so that it is renewed and sent again. */
const TOKEN_REFUSED = new Error("OVHcloud refused the access token.");

/** Thrown inside a read OVHcloud answered with 429, so that it is sent again after `waitMs`. */
class RetryAfter extends Error {
  constructor(readonly waitMs: number) {
    super("OVHcloud's rate limit was reached.");
  }
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Typed client for OVHcloud Europe's API, signed in by an OAuth2 service account (client
 * credentials, scope `all`). The access token is kept until it expires. Every answer is validated
 * against the schema the caller passes, and every error is plain English with its next step.
 * A request OVHcloud answers with 401 gets a new token and is sent once more, except a `post`:
 * a `post` is never sent twice. A read answered with 429 is sent once more after `Retry-After`.
 * Nothing else is repeated.
 */
export class OvhcloudClient {
  readonly #credentials: OvhcloudCredentials;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;
  readonly #http: JsonClient;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: OvhcloudClientOptions) {
    this.#credentials = options.credentials;
    this.#redactor = options.redactor;
    this.#userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.#http = jsonClient(options, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      // The client decides itself what is sent again (see the class's comment).
      retry: {
        serverErrors: 0,
        serverErrorDelayMs: () => 0,
        rateLimits: 0,
        rateLimitDelayMs: () => 0,
      },
    });
  }

  /** The Public Cloud project's path: `/v1/cloud/project/{id}` or `/v2/publicCloud/project/{id}`. */
  projectPath(api: "v1" | "v2"): OvhcloudPath {
    const id = encodeURIComponent(this.#credentials.projectId);
    return api === "v1" ? `/v1/cloud/project/${id}` : `/v2/publicCloud/project/${id}`;
  }

  /** `GET path` (with `query`), its answer parsed with `schema`. */
  get<S extends z.ZodType>(
    path: OvhcloudPath,
    schema: S,
    query?: Record<string, string>,
  ): Promise<z.output<S>> {
    return this.#request("GET", path, schema, query === undefined ? {} : { query });
  }

  /** `POST path` with the JSON `body`, if any, its answer parsed with `schema`. Never sent twice. */
  post<S extends z.ZodType>(path: OvhcloudPath, schema: S, body?: unknown): Promise<z.output<S>> {
    return this.#request("POST", path, schema, body === undefined ? {} : { body });
  }

  /** `PUT path` with the JSON `body`, its answer parsed with `schema`. */
  put<S extends z.ZodType>(path: OvhcloudPath, schema: S, body: unknown): Promise<z.output<S>> {
    return this.#request("PUT", path, schema, { body });
  }

  /** `DELETE path`, its answer parsed with `schema` (`z.undefined()` for an empty one). */
  delete<S extends z.ZodType>(path: OvhcloudPath, schema: S): Promise<z.output<S>> {
    return this.#request("DELETE", path, schema);
  }

  async #request<S extends z.ZodType>(
    method: Method,
    path: OvhcloudPath,
    schema: S,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<z.output<S>> {
    let renewed = false;
    let waited = false;
    for (;;) {
      const token = await this.#accessToken();
      try {
        return await requestJson(this.#http, {
          url: `${OVHCLOUD_API_URL}${path}`,
          method,
          headers: { Authorization: `Bearer ${token}`, "User-Agent": this.#userAgent },
          ...(options.query !== undefined && { query: options.query }),
          ...(options.body !== undefined && { body: options.body }),
          schema,
          fail: (failure) => {
            if (failure.kind === "status") {
              const { status, headers } = failure.response;
              // A 401 means OVHcloud did nothing; the token is renewed for the next request.
              if (status === 401) this.#token = undefined;
              if (status === 401 && method !== "POST" && !renewed) return TOKEN_REFUSED;
              if (status === 429 && method === "GET" && !waited) {
                return new RetryAfter(this.#retryAfterMs(headers.get("Retry-After")));
              }
            }
            return this.#error(failure, method, path);
          },
        });
      } catch (error) {
        if (error === TOKEN_REFUSED) {
          renewed = true;
        } else if (error instanceof RetryAfter) {
          waited = true;
          await this.#http.sleep(error.waitMs);
        } else {
          throw error;
        }
      }
    }
  }

  /** The wait `Retry-After` asks for (seconds or an HTTP date), within a minute. */
  #retryAfterMs(header: string | null): number {
    const value = header?.trim() ?? "";
    if (value === "") return RATE_LIMIT_WAIT_MS;
    const seconds = Number(value);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - this.#http.now();
    return Number.isFinite(wait)
      ? Math.min(Math.max(wait, 0), MAX_RATE_LIMIT_WAIT_MS)
      : RATE_LIMIT_WAIT_MS;
  }

  /** The cached access token, or a new one when there is none or it has expired. */
  async #accessToken(): Promise<string> {
    if (this.#token !== undefined && this.#http.now() < this.#token.expiresAt) {
      return this.#token.value;
    }
    this.#token = undefined;
    const answer = await this.#signIn();
    this.#redactor.addLiteral(answer.access_token, "OVHcloud access token");
    this.#token = {
      value: answer.access_token,
      expiresAt: this.#http.now() + answer.expires_in * 1000 - TOKEN_MARGIN_MS,
    };
    return this.#token.value;
  }

  /** The OAuth2 client-credentials grant, as OVHcloud's service-account guide sends it. */
  async #signIn(): Promise<z.infer<typeof tokenSchema>> {
    const { clientId, clientSecret } = this.#credentials;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "all",
    });
    const signal = AbortSignal.timeout(this.#http.timeoutMs);
    const host = new URL(OVHCLOUD_TOKEN_URL).host;
    let response: Response;
    let text: string;
    try {
      response = await this.#http.fetch(OVHCLOUD_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.#userAgent,
        },
        body: form.toString(),
        signal,
      });
      text = await response.text();
    } catch {
      throw signal.aborted
        ? this.#failure(
            "PROVIDER_ERROR",
            `OVHcloud's sign-in (${host}) did not answer within ${durationText(this.#http.timeoutMs)}.`,
            "Try again in a few minutes.",
          )
        : this.#failure(
            "PROVIDER_ERROR",
            `Could not reach OVHcloud's sign-in (${host}).`,
            CONNECTION_HINT,
          );
    }
    const json = parseJson(text);
    if (!response.ok) {
      const body = tokenErrorSchema.safeParse(json);
      const detail =
        (body.success && (body.data.error_description || body.data.error)) ||
        response.statusText ||
        `HTTP ${response.status}`;
      if (response.status === 400 || response.status === 401) {
        throw this.#failure(
          "CREDENTIALS_INVALID",
          `OVHcloud refused the service account: ${detail}`,
          OVHCLOUD_CREDENTIALS_HINT,
        );
      }
      throw this.#failure(
        "PROVIDER_ERROR",
        `OVHcloud's sign-in failed (HTTP ${response.status}): ${detail}`,
        statusHint(response.status, "GET"),
      );
    }
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) {
      throw this.#failure(
        "PROVIDER_ERROR",
        "OVHcloud's sign-in answered without an access token.",
        changedApiHint("OVHcloud"),
      );
    }
    return parsed.data;
  }

  async #error(failure: RequestFailure, method: Method, path: string): Promise<OpsCrewError> {
    const request = `${method} ${path}`;
    switch (failure.kind) {
      case "unreachable": {
        const what = failure.timedOut
          ? `OVHcloud's API did not answer within ${durationText(this.#http.timeoutMs)}`
          : "Lost the connection to OVHcloud's API";
        return this.#failure(
          "PROVIDER_ERROR",
          `${what} (${request}).`,
          method === "GET"
            ? CONNECTION_HINT
            : "The change may still have been made: check your Public Cloud project in the control panel before trying again.",
        );
      }
      case "invalid-json":
        return this.#failure("PROVIDER_ERROR", `OVHcloud returned invalid JSON for ${request}.`);
      case "unexpected":
        return this.#failure(
          "PROVIDER_ERROR",
          `OVHcloud returned an unexpected answer for ${request}: ${failure.issues}`,
          changedApiHint("OVHcloud"),
        );
      case "status":
        return this.#statusError(failure.response, method, path);
    }
  }

  async #statusError(
    response: Response,
    method: Method,
    path: string,
  ): Promise<OvhcloudStatusError> {
    const { status } = response;
    const fail = (code: ErrorCode, message: string, hint: string) =>
      new OvhcloudStatusError(
        status,
        code,
        this.#redactor.redact(message),
        this.#redactor.redact(hint),
      );
    const parsed = errorBodySchema.safeParse(parseJson(await response.text().catch(() => "")));
    const body = parsed.success ? parsed.data : {};
    const detail = body.message || body.class || response.statusText || `HTTP ${status}`;
    const request = `${method} ${path}`;

    const refused = REFUSED_ACTION_KEYS.map((key) => body.details?.[key]).filter(
      (actions): actions is string => typeof actions === "string" && actions !== "",
    );
    if (refused.length > 0) {
      const actions = listText(refused);
      return fail(
        "CREDENTIALS_INVALID",
        `OVHcloud's IAM doesn't allow the service account to do ${actions} (${request}): ${detail}`,
        `Allow ${actions} in the IAM policy that names the service account and your Public Cloud project (${IAM_POLICIES}), then try again.`,
      );
    }
    switch (status) {
      case 401:
        return fail(
          "CREDENTIALS_INVALID",
          `OVHcloud refused the service account's access token (HTTP 401, ${request}): ${detail}`,
          // A post isn't sent again with a new token, but the next request gets one.
          method === "POST"
            ? `OVHcloud refused the access token, so nothing was changed. Run the command again; only if it fails the same way, ${lowerFirst(OVHCLOUD_CREDENTIALS_HINT)}`
            : OVHCLOUD_CREDENTIALS_HINT,
        );
      case 403:
        return fail(
          "CREDENTIALS_INVALID",
          `OVHcloud refused ${request} (HTTP 403): ${detail}`,
          `Check that an IAM policy gives the service account the rights OpsCrew needs on your Public Cloud project (${IAM_POLICIES}), then try again.`,
        );
      case 404:
        if (path === this.projectPath("v1") || path === this.projectPath("v2")) {
          return fail(
            "PROVIDER_ERROR",
            `OVHcloud found no Public Cloud project with the id in ${OVHCLOUD_ENV.projectId} (${request}): ${detail}`,
            `Check that ${OVHCLOUD_ENV.projectId} is your Public Cloud project's id (the control panel shows it under the project's name) and that the service account's IAM policy names that project.`,
          );
        }
        return fail(
          "PROVIDER_ERROR",
          `OVHcloud answered HTTP 404 to ${request}: ${detail}`,
          `It may have been deleted: check your Public Cloud project in the control panel. If every request fails this way, check that ${OVHCLOUD_ENV.projectId} is your Public Cloud project's id.`,
        );
      case 429:
        return fail(
          "PROVIDER_ERROR",
          `OVHcloud's rate limit was reached (${request}): ${detail}`,
          RATE_LIMIT_HINT,
        );
      default:
        return fail(
          "PROVIDER_ERROR",
          `OVHcloud answered HTTP ${status} to ${request}: ${detail}`,
          statusHint(status, method),
        );
    }
  }

  /** An `OpsCrewError` with its message and hint passed through the redactor. */
  #failure(code: ErrorCode, message: string, hint?: string): OpsCrewError {
    return new OpsCrewError(code, this.#redactor.redact(message), {
      ...(hint !== undefined && { hint: this.#redactor.redact(hint) }),
    });
  }
}

/** An error of a request OVHcloud answered with an error `status` (a 404 when a thing is gone). */
export class OvhcloudStatusError extends OpsCrewError {
  constructor(
    readonly status: number,
    code: ErrorCode,
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
  }
}

/** The next step after OVHcloud answered `method` with an error `status`. */
function statusHint(status: number, method: Method): string {
  switch (status) {
    case 400:
    case 422:
      return "OVHcloud refused the request as sent: fix what it named above, then try again.";
    case 409:
      return "It conflicts with the resource's current state, or another change is still running: wait until it is done, check it in the control panel, then try again.";
    case 429:
      return RATE_LIMIT_HINT;
    default:
      if (status < 500)
        return "Check your Public Cloud project in the control panel, then try again.";
      return method === "GET"
        ? "OVHcloud failed on its side: try again in a few minutes, and contact OVHcloud's support if it keeps failing."
        : "OVHcloud failed on its side, and the change may still have been made: check your Public Cloud project in the control panel before trying again.";
  }
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
