import type { FetchLike, ProviderRedactor } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  changedApiHint,
  durationText,
  type ErrorCode,
  type JsonClient,
  jsonClient,
  listText,
  OpsCrewError,
  pollAction,
  RATE_LIMIT_HINT,
  type RequestFailure,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";

/**
 * Kamatera's CLI API, the front its Terraform provider (`api_url`'s default) and its CLI use. Every
 * call carries the API key in the `AuthClientId` and `AuthSecret` headers; there is no token step.
 */
export const KAMATERA_API_URL = "https://cloudcli.cloudwm.com";

/** Version sent in the `User-Agent` header when the caller does not pass one. */
const CONNECTOR_VERSION = "0.1.0";
/** Default time one HTTP request may take before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How often a queued command's status is read (the Terraform provider's `waitCommand`). */
const QUEUE_INTERVAL_MS = 2_000;

/** The two environment variables of Kamatera's API key, both needed. */
export const KAMATERA_ENV = {
  clientId: "KAMATERA_API_CLIENT_ID",
  secret: "KAMATERA_API_SECRET",
} as const;

/** Overrides {@link KAMATERA_API_URL}, as it does for Kamatera's Terraform provider. */
export const KAMATERA_API_URL_ENV = "KAMATERA_API_URL";

/** How to create the API key and where it goes. */
export const KAMATERA_CREDENTIALS_HINT = `In Kamatera's console, open API → Keys and create a key, then set ${KAMATERA_ENV.clientId} to its access key and ${KAMATERA_ENV.secret} to its secret key.`;

/** Kamatera's API key: the access key (client id) and its secret. */
export interface KamateraCredentials {
  clientId: string;
  secret: string;
}

/**
 * The API key from `env`, each value registered with `redactor` as soon as it is read, and the
 * API's base (`KAMATERA_API_URL`, else {@link KAMATERA_API_URL}); or a plain-English `problem`
 * naming the variables that are missing (empty or blank), or a base that isn't `https://`.
 * Without the key nothing calls Kamatera.
 */
export function readKamateraCredentials(
  env: Record<string, string | undefined>,
  redactor: ProviderRedactor,
): { credentials: KamateraCredentials; apiUrl: string } | { problem: string } {
  const values: Partial<KamateraCredentials> = {};
  const missing: string[] = [];
  for (const [key, name] of Object.entries(KAMATERA_ENV) as [keyof KamateraCredentials, string][]) {
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
      problem: `${listText(missing)} ${verb} not set: Kamatera needs both ${KAMATERA_ENV.clientId} and ${KAMATERA_ENV.secret}. ${KAMATERA_CREDENTIALS_HINT}`,
    };
  }
  const base = env[KAMATERA_API_URL_ENV]?.trim() || KAMATERA_API_URL;
  // The key travels in headers, so it goes to an https:// address only.
  if (URL.parse(base)?.protocol !== "https:") {
    return {
      problem: `${KAMATERA_API_URL_ENV} must be an https:// address. Unset it to use ${KAMATERA_API_URL}, or set it to an https:// address.`,
    };
  }
  const { clientId, secret } = values as KamateraCredentials;
  return { credentials: { clientId, secret }, apiUrl: base.replace(/\/+$/, "") };
}

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

/**
 * A queued command's id: a bare number (the console API's terminate and power examples, and the
 * Terraform provider's `getCommandIdFromResult`) or a list of one id (the CLI's `[]string`, the
 * console API's create example `[17635771]`).
 */
const commandIdSchema = z
  .union([z.number().int(), z.tuple([z.union([z.string().min(1), z.number().int()])])])
  .transform((id) => String(Array.isArray(id) ? id[0] : id));

/** One command in the queue (the CLI schema's `queue detail`: `status` and `log`, among others). */
const commandSchema = z.looseObject({
  /** `complete` when done and `error` when it failed (the CLI schema's `wait` and `waitError`). */
  status: z.string(),
  log: z.string().nullish(),
});

/** A queued command once it is complete. */
export type KamateraCommand = z.infer<typeof commandSchema>;

/**
 * `GET /service/queue?id=` answers a list of the one command (the Terraform provider's
 * `waitCommand`); the CLI waits on an empty list, as a command not listed yet.
 */
const queueSchema = z.array(commandSchema).max(1);

const errorInfosSchema = z.array(z.looseObject({ info: z.string().optional() }));

/**
 * Kamatera's error answer: `message`, which may hold `{"errors":[{"code","info","category"}]}` as
 * a string (the Terraform provider's issue #32), or `errors` itself; the CLI's own errors are
 * `{"error":true,"message":…}`.
 */
const errorBodySchema = z.looseObject({
  message: z.string().optional(),
  errors: errorInfosSchema.optional(),
});

// --- Client -------------------------------------------------------------------------------------

/** A path of Kamatera's CLI API, such as `/service/servers`. */
export type KamateraPath = `/${string}`;

export interface KamateraClientOptions {
  credentials: KamateraCredentials;
  /** The API's base (default {@link KAMATERA_API_URL}), from {@link readKamateraCredentials}. */
  apiUrl?: string;
  /** Masks the API key in every error. */
  redactor: ProviderRedactor;
  fetch?: FetchLike;
  /** Version used in `User-Agent: opscrew/<version>`. */
  version?: string;
  /** Injectable delay between reads of a queued command. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (epoch ms) for a queued command's timeout. */
  now?: () => number;
  /** Per-request timeout in milliseconds (default 30 seconds). */
  timeoutMs?: number;
}

/** What a queued command does, for its errors, and how long it may take. */
export interface KamateraWait {
  /** Ends "Kamatera's command to <what> failed": `power the server off`. */
  what: string;
  timeoutMs: number;
}

type Method = "GET" | "POST";

/**
 * Typed client for Kamatera's CLI API. Every request carries the API key's `AuthClientId` and
 * `AuthSecret` headers, every answer is validated against the schema the caller passes, and every
 * error is plain English with its next step. Nothing is sent twice: Kamatera answers a request it
 * refuses with HTTP 500, so repeating it would not help, and a `post` may already have been done.
 */
export class KamateraClient {
  readonly #credentials: KamateraCredentials;
  readonly #apiUrl: string;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;
  readonly #http: JsonClient;

  constructor(options: KamateraClientOptions) {
    this.#credentials = options.credentials;
    this.#apiUrl = options.apiUrl ?? KAMATERA_API_URL;
    this.#redactor = options.redactor;
    this.#userAgent = `opscrew/${options.version ?? CONNECTOR_VERSION}`;
    this.#http = jsonClient(options, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      retry: {
        serverErrors: 0,
        serverErrorDelayMs: () => 0,
        rateLimits: 0,
        rateLimitDelayMs: () => 0,
      },
    });
  }

  /** `GET path` (with `query`), its answer parsed with `schema`. */
  get<S extends z.ZodType>(
    path: KamateraPath,
    schema: S,
    query?: Record<string, string>,
  ): Promise<z.output<S>> {
    return this.#request("GET", path, schema, query === undefined ? {} : { query });
  }

  /** `POST path` with the JSON `body`, its answer parsed with `schema`. Never sent twice. */
  post<S extends z.ZodType>(path: KamateraPath, schema: S, body: unknown): Promise<z.output<S>> {
    return this.#request("POST", path, schema, { body });
  }

  /**
   * `POST path` with the JSON `body`, whose answer is a queued command's id, then the command's
   * status read through `GET /service/queue?id=` every 2 seconds until it is `complete`.
   * @throws OpsCrewError with the command's log when its status is `error`, or when it is still
   * running after `wait.timeoutMs`.
   */
  async command(path: KamateraPath, body: unknown, wait: KamateraWait): Promise<KamateraCommand> {
    const id = await this.post(path, commandIdSchema, body);
    const timedOut = () =>
      this.#failure(
        "PROVIDER_ERROR",
        `Kamatera's command to ${wait.what} did not finish within ${durationText(wait.timeoutMs)}.`,
        "It may still finish: check the server in your Kamatera account's console before trying again.",
      );
    const [done] = await pollAction({
      read: () => this.get("/service/queue", queueSchema, { id }),
      finished: ([command]) => {
        if (command?.status === "error") throw this.#commandFailed(command, wait.what);
        return command?.status === "complete";
      },
      timedOut,
      timeoutMs: wait.timeoutMs,
      intervalMs: QUEUE_INTERVAL_MS,
      sleep: this.#http.sleep,
      now: this.#http.now,
    });
    if (done === undefined) throw timedOut();
    return done;
  }

  #commandFailed(command: KamateraCommand, what: string): OpsCrewError {
    const log = command.log?.trim();
    return this.#failure(
      "PROVIDER_ERROR",
      log
        ? `Kamatera's command to ${what} failed: ${log}`
        : `Kamatera's command to ${what} failed, and Kamatera gave no log.`,
      "Check the server in your Kamatera account's console, fix what the log names, then try again.",
    );
  }

  #request<S extends z.ZodType>(
    method: Method,
    path: KamateraPath,
    schema: S,
    options: { query?: Record<string, string>; body?: unknown },
  ): Promise<z.output<S>> {
    return requestJson(this.#http, {
      url: `${this.#apiUrl}${path}`,
      method,
      headers: {
        AuthClientId: this.#credentials.clientId,
        AuthSecret: this.#credentials.secret,
        "User-Agent": this.#userAgent,
      },
      ...(options.query !== undefined && { query: options.query }),
      ...(options.body !== undefined && { body: options.body }),
      schema,
      fail: (failure) => this.#error(failure, `${method} ${path}`, method),
    });
  }

  async #error(failure: RequestFailure, request: string, method: Method): Promise<OpsCrewError> {
    switch (failure.kind) {
      case "unreachable": {
        const what = failure.timedOut
          ? `Kamatera's API did not answer within ${durationText(this.#http.timeoutMs)}`
          : "Lost the connection to Kamatera's API";
        return this.#failure(
          "PROVIDER_ERROR",
          `${what} (${request}).`,
          method === "GET"
            ? CONNECTION_HINT
            : "The change may still have been made: check your Kamatera account in its console before trying again.",
        );
      }
      case "invalid-json":
        return this.#failure("PROVIDER_ERROR", `Kamatera returned invalid JSON for ${request}.`);
      case "unexpected":
        return this.#failure(
          "PROVIDER_ERROR",
          `Kamatera returned an unexpected answer for ${request}: ${failure.issues}`,
          changedApiHint("Kamatera"),
        );
      case "status":
        return this.#statusError(failure.response, request, method);
    }
  }

  async #statusError(
    response: Response,
    request: string,
    method: Method,
  ): Promise<KamateraStatusError> {
    const { status } = response;
    const fail = (code: ErrorCode, message: string, hint: string) =>
      new KamateraStatusError(
        status,
        code,
        this.#redactor.redact(message),
        this.#redactor.redact(hint),
      );
    const detail = errorDetail(await response.text().catch(() => ""));
    const tail = detail === undefined ? "." : `: ${detail}`;
    switch (status) {
      case 401:
      case 403:
        return fail(
          "CREDENTIALS_INVALID",
          `Kamatera refused the API key (HTTP ${status}, ${request})${tail}`,
          `Check that ${KAMATERA_ENV.clientId} and ${KAMATERA_ENV.secret} are a key of your Kamatera account. ${KAMATERA_CREDENTIALS_HINT}`,
        );
      case 404: {
        const hint =
          "The server may have been removed: check your Kamatera account in its console.";
        return fail(
          "PROVIDER_ERROR",
          `Kamatera found no such server or route (${request})${tail}`,
          this.#apiUrl === KAMATERA_API_URL
            ? hint
            : `${hint} If every request fails this way, check ${KAMATERA_API_URL_ENV}, or unset it to use ${KAMATERA_API_URL}.`,
        );
      }
      case 429:
        return fail(
          "PROVIDER_ERROR",
          `Kamatera's rate limit was reached (${request})${tail}`,
          RATE_LIMIT_HINT,
        );
    }
    if (detail !== undefined) {
      return fail(
        "PROVIDER_ERROR",
        `Kamatera refused ${request}: ${detail}`,
        "Fix what Kamatera named above, then try again. If it names nothing you can change, check your Kamatera account in its console, or contact Kamatera's support.",
      );
    }
    return fail(
      "PROVIDER_ERROR",
      `Kamatera answered HTTP ${status} to ${request}.`,
      status < 500
        ? "Check your Kamatera account in its console, then try again."
        : method === "GET"
          ? "Kamatera failed on its side: try again in a few minutes, and contact Kamatera's support if it keeps failing."
          : "Kamatera failed on its side, and the change may still have been made: check your Kamatera account in its console before trying again.",
    );
  }

  /** An `OpsCrewError` with its message and hint passed through the redactor. */
  #failure(code: ErrorCode, message: string, hint?: string): OpsCrewError {
    return new OpsCrewError(code, this.#redactor.redact(message), {
      ...(hint !== undefined && { hint: this.#redactor.redact(hint) }),
    });
  }
}

/** An error of a request Kamatera answered with an error `status`. */
export class KamateraStatusError extends OpsCrewError {
  constructor(
    readonly status: number,
    code: ErrorCode,
    message: string,
    hint: string,
  ) {
    super(code, message, { hint });
  }
}

/**
 * What an error answer says: its `message` and every `errors[].info`, also those of a `message`
 * that holds `{"errors":[…]}` as a string; `undefined` when it says nothing.
 */
function errorDetail(text: string): string | undefined {
  const parsed = errorBodySchema.safeParse(parseJson(text));
  if (!parsed.success) return undefined;
  const { message, errors = [] } = parsed.data;
  const nested = z.looseObject({ errors: errorInfosSchema }).safeParse(parseJson(message ?? ""));
  const parts = [...(nested.success ? nested.data.errors : [{ info: message }]), ...errors].flatMap(
    ({ info }) => (info?.trim() ? [info.trim()] : []),
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
