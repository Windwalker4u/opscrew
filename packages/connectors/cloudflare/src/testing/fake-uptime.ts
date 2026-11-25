import type { FetchLike } from "@opscrew/contracts";
import type { FakeReply } from "@opscrew/core/testing";
import { CLOUDFLARE_API } from "../client";
import { FAKE_ACCOUNT_ID } from "./fake-zone";
import { answer, DENIED, type FakeFault, ok, only, paged, refuse, takeFault } from "./replies";

/**
 * A fake Cloudflare account for the uptime Worker (feature 046): Workers KV and Worker module
 * uploads with their schedules and secrets, behind one `fetch`, as research R2 to R4 describe them.
 *
 * - **KV namespaces** are listed by page, created (a title the account has is refused with HTTP
 *   400, code 10014) and deleted with their keys.
 * - **KV keys** are listed by `prefix`, `limit` and `cursor`; a value is read as it is stored (a
 *   missing key answers 404 with code 10009), written from a plain-text body and deleted (a
 *   missing key too, without an error).
 * - **A Worker upload** (`PUT …/workers/scripts/{name}`, multipart) needs a `metadata` part with
 *   `main_module` naming a part of type `application/javascript+module`; every `kv_namespace`
 *   binding must name an existing namespace. The upload replaces the bindings: secrets stay only
 *   with `keep_bindings: ["secret_text"]`.
 * - **Schedules** are replaced as a whole; **secrets** are listed by name, set (`secret_text`) and
 *   deleted; deleting a Worker deletes its schedules and secrets. A Worker the account doesn't
 *   have answers 404 with code 10007.
 *
 * Any other request goes to `fallback` (another fake), or throws. Every request is recorded in
 * `calls`, a multipart one with its parts as text.
 */

/** A Workers KV namespace and its keys. */
export interface FakeKvNamespace {
  id: string;
  title: string;
  values: Map<string, string>;
}

/** A Worker uploaded as a module, as the fake keeps it. */
export interface FakeUptimeScript {
  /** The main module's text. */
  content: string;
  compatibilityDate: string;
  /** The bindings as uploaded, without its secrets. */
  bindings: Record<string, unknown>[];
  /** Secret names and values. */
  secrets: Map<string, string>;
  crons: string[];
}

/** A request the fake received. */
export interface FakeUptimeCall {
  method: string;
  path: string;
  /** JSON parsed, plain text as it came, a multipart form as its parts' text by name. */
  body: unknown;
}

/** Something another app (or Cloudflare) does just before a matching request is handled. */
export interface FakeUptimeHook {
  /** `"METHOD /path"` prefix. */
  match: string;
  run: () => void;
}

export class FakeUptime {
  readonly accountId: string;
  readonly namespaces: FakeKvNamespace[] = [];
  readonly scripts = new Map<string, FakeUptimeScript>();
  readonly calls: FakeUptimeCall[] = [];
  /** One-shot failures of the next matching request. */
  readonly faults: FakeFault[] = [];
  /** One-shot hooks, run before the next matching request is handled. */
  readonly hooks: FakeUptimeHook[] = [];
  /** What the token may not do (HTTP 403): `kv` for Workers KV, `workers` for the Workers. */
  readonly denied = new Set<"kv" | "workers">();
  /**
   * The account's workers.dev subdomain; `undefined`: it never chose one, so its subdomain reads
   * 404 (code 10007) and setting a Worker's schedules is refused (HTTP 403, code 10063).
   */
  subdomain: string | undefined = "opscrew-test";
  readonly #fallback: FetchLike | undefined;
  #ids = 0;

  constructor(options: { accountId?: string; fallback?: FetchLike } = {}) {
    this.accountId = options.accountId ?? FAKE_ACCOUNT_ID;
    this.#fallback = options.fallback;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).slice(CLOUDFLARE_API.length);
    const route = new URL(path, "https://fake.invalid").pathname;
    const account = `/accounts/${this.accountId}`;
    const scripts = `${account}/workers/scripts/`;
    const ours =
      route === `${account}/workers/subdomain` ||
      route.startsWith(`${account}/storage/kv/namespaces`) ||
      (route.startsWith(scripts) &&
        /^[^/]+(?:\/schedules|\/secrets(?:\/[^/]+)?)?$/.test(route.slice(scripts.length)));
    if (!ours) {
      if (this.#fallback) return this.#fallback(input, init);
      throw new Error(`fake uptime: no route for ${method} ${path}`);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = await readBody(init?.body, headers["Content-Type"]);
    this.calls.push({ method, path, body });
    const at = this.hooks.findIndex((h) => `${method} ${path}`.startsWith(h.match));
    if (at !== -1) this.hooks.splice(at, 1)[0]?.run();
    const fault = takeFault(this.faults, method, path);
    if (!fault || fault.applied) {
      const reply = this.#handle(method, path, body);
      if (!fault) return answer(reply, input, init);
    }
    return answer((fault as FakeFault).reply, input, init);
  };

  /** The namespace with this title, if any. */
  namespace(title: string): FakeKvNamespace | undefined {
    return this.namespaces.find((n) => n.title === title);
  }

  /** Adds a namespace, as Cloudflare would hold it. */
  addNamespace(title: string): FakeKvNamespace {
    const namespace = { id: this.#id(), title, values: new Map<string, string>() };
    this.namespaces.push(namespace);
    return namespace;
  }

  /** The write requests received (everything but `GET`). */
  writes(): FakeUptimeCall[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  #id(): string {
    this.#ids++;
    return this.#ids.toString(16).padStart(32, "0");
  }

  #handle(method: string, path: string, body: unknown): FakeReply {
    const url = new URL(path, "https://fake.invalid");
    const route = url.pathname;
    const kv = `/accounts/${this.accountId}/storage/kv/namespaces`;
    if (route.startsWith(kv)) {
      if (this.denied.has("kv")) return DENIED;
      return this.#kv(method, route.slice(kv.length), url, body);
    }
    if (this.denied.has("workers")) return DENIED;
    if (route === `/accounts/${this.accountId}/workers/subdomain` && method === "GET") {
      return this.subdomain === undefined
        ? refuse(404, 10007, "This subdomain does not exist.")
        : ok({ subdomain: this.subdomain });
    }
    const [, name = "", rest = ""] =
      /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)(.*)$/.exec(route) ?? [];
    return this.#script(method, decodeURIComponent(name), rest, body);
  }

  #kv(method: string, rest: string, url: URL, body: unknown): FakeReply {
    if (rest === "" && method === "GET") {
      only(url, ["page", "per_page"]);
      const perPage = Number(url.searchParams.get("per_page") ?? 20);
      if (perPage < 5 || perPage > 100) return refuse(400, 10001, "per_page must be 5 to 100");
      const items = this.namespaces.map(({ id, title }) => ({
        id,
        title,
        supports_url_encoding: true,
      }));
      return paged(items, url, perPage);
    }
    if (rest === "" && method === "POST") {
      const { title } = body as { title: string };
      if (this.namespace(title)) {
        return refuse(400, 10014, "a namespace with this account ID and title already exists");
      }
      const { id } = this.addNamespace(title);
      return ok({ id, title, supports_url_encoding: true });
    }
    const [, id = "", tail = ""] = /^\/([^/]+)(.*)$/.exec(rest) ?? [];
    const namespace = this.namespaces.find((n) => n.id === decodeURIComponent(id));
    if (!namespace) return refuse(404, 10013, "namespace not found");
    if (tail === "" && method === "DELETE") {
      this.namespaces.splice(this.namespaces.indexOf(namespace), 1);
      return ok(null);
    }
    if (tail === "/keys" && method === "GET") {
      only(url, ["prefix", "limit", "cursor"]);
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const start = Number(url.searchParams.get("cursor") || 0);
      const names = [...namespace.values.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = names.slice(start, start + limit);
      const next = start + limit < names.length ? String(start + limit) : "";
      return {
        body: {
          success: true,
          errors: [],
          messages: [],
          result: page.map((name) => ({ name })),
          result_info: { count: page.length, cursor: next },
        },
      };
    }
    const key = /^\/values\/([^/]+)$/.exec(tail)?.[1];
    if (key === undefined) throw new Error(`fake uptime: ${method} on KV ${rest}`);
    const name = decodeURIComponent(key);
    if (method === "GET") {
      const value = namespace.values.get(name);
      if (value === undefined) return refuse(404, 10009, "get: 'key not found'");
      return { text: value, headers: { "content-type": "application/octet-stream" } };
    }
    if (method === "PUT") {
      if (typeof body !== "string") return refuse(400, 10002, "the value must be sent as the body");
      namespace.values.set(name, body);
      return ok(null);
    }
    if (method === "DELETE") {
      namespace.values.delete(name);
      return ok(null);
    }
    throw new Error(`fake uptime: ${method} on KV ${rest}`);
  }

  #script(method: string, name: string, rest: string, body: unknown): FakeReply {
    const script = this.scripts.get(name);
    if (rest === "" && method === "PUT") return this.#upload(name, script, body);
    if (!script) return refuse(404, 10007, "This Worker does not exist on your account.");
    if (rest === "" && method === "DELETE") {
      this.scripts.delete(name);
      return ok(null);
    }
    if (rest === "/schedules" && method === "PUT") {
      if (this.subdomain === undefined) {
        return refuse(403, 10063, "You need a workers.dev subdomain in order to proceed");
      }
      script.crons = (body as { cron: string }[]).map((s) => s.cron);
      return ok({
        schedules: script.crons.map((cron) => ({ cron, created_on: "", modified_on: "" })),
      });
    }
    if (rest === "/secrets" && method === "GET") {
      return ok(
        [...script.secrets.keys()].map((secret) => ({ name: secret, type: "secret_text" })),
      );
    }
    if (rest === "/secrets" && method === "PUT") {
      const sent = body as { name: string; text: string; type: string };
      if (sent.type !== "secret_text" || !sent.name) return refuse(400, 10021, "invalid secret");
      script.secrets.set(sent.name, sent.text);
      return ok({ name: sent.name, type: "secret_text" });
    }
    const secret = /^\/secrets\/([^/]+)$/.exec(rest)?.[1];
    if (secret !== undefined && method === "DELETE") {
      if (!script.secrets.delete(decodeURIComponent(secret))) {
        return refuse(404, 10056, "secret not found");
      }
      return ok(null);
    }
    throw new Error(`fake uptime: ${method} on the Worker ${name}${rest}`);
  }

  #upload(name: string, previous: FakeUptimeScript | undefined, body: unknown): FakeReply {
    const parts = body as Record<string, { text: string; type: string }> | undefined;
    const metadata = parts?.metadata ? JSON.parse(parts.metadata.text) : undefined;
    const main = metadata ? parts?.[metadata.main_module] : undefined;
    if (!metadata || !main || main.type !== "application/javascript+module") {
      return refuse(400, 10021, "the upload needs metadata and its main module");
    }
    const bindings = (metadata.bindings ?? []) as Record<string, unknown>[];
    for (const binding of bindings) {
      if (binding.type !== "kv_namespace") continue;
      if (!this.namespaces.some((n) => n.id === binding.namespace_id)) {
        return refuse(400, 10041, `KV namespace '${String(binding.namespace_id)}' is not valid`);
      }
    }
    const kept = ((metadata.keep_bindings ?? []) as string[]).includes("secret_text");
    this.scripts.set(name, {
      content: main.text,
      compatibilityDate: String(metadata.compatibility_date),
      bindings,
      secrets: kept && previous ? previous.secrets : new Map(),
      crons: previous?.crons ?? [],
    });
    return ok({ id: name, etag: this.#id(), handlers: ["scheduled"] });
  }
}

/** A request's body: JSON parsed, other text as it came, a form as its parts' text by name. */
async function readBody(body: RequestInit["body"], type: string | undefined): Promise<unknown> {
  if (typeof body === "string") return type === "application/json" ? JSON.parse(body) : body;
  if (!(body instanceof FormData)) return undefined;
  const parts: Record<string, { text: string; type: string }> = {};
  for (const [name, value] of body.entries()) {
    parts[name] =
      typeof value === "string"
        ? { text: value, type: "text/plain" }
        : { text: await value.text(), type: value.type };
  }
  return parts;
}
