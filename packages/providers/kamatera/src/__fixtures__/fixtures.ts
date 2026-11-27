import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { KAMATERA_API_URL } from "../client";

/** The two values, synthetic, by environment variable. */
export const CREDENTIALS_ENV = {
  KAMATERA_API_CLIENT_ID: fakeSecret("generic-password", "kamatera-client-id"),
  KAMATERA_API_SECRET: fakeSecret("generic-password", "kamatera-secret"),
} as const;

/** The same values as the client takes them. */
export const CREDENTIALS = {
  clientId: CREDENTIALS_ENV.KAMATERA_API_CLIENT_ID,
  secret: CREDENTIALS_ENV.KAMATERA_API_SECRET,
};

/** Core's fake fetch with routes relative to `base` (`/service/servers`, `GET /service/queue`). */
export function kamateraFetch(
  routes: Record<string, FakeReply | FakeReply[]>,
  base = KAMATERA_API_URL,
) {
  return fakeFetch(routes, { base });
}

/**
 * The queue's answer for one command: a list of one item with its `status` and `log`, the fields
 * of the CLI schema's `queue detail` (`id`, `status`, `server`, `description`, `added`, `executed`,
 * `completed`, `log`).
 */
export function queued(status: string, log = ""): FakeReply {
  return {
    body: [
      {
        id: 4242,
        status,
        server: "shop",
        description: "Fake command",
        added: "2026-11-26 10:00:00",
        executed: status === "pending" ? null : "2026-11-26 10:00:02",
        completed: status === "complete" || status === "error" ? "2026-11-26 10:00:09" : null,
        log,
      },
    ],
  };
}

/**
 * Kamatera's error answer for a refused request, as the Terraform provider's issue #32 printed it:
 * HTTP 500 with `message` holding `{"errors":[{"code","info","category"}]}` as a string.
 */
export function refused(...infos: string[]): FakeReply {
  const errors = infos.map((info) => ({ code: 2, info, category: "General Error" }));
  return { status: 500, body: { message: JSON.stringify({ errors }) } };
}

/** The proxy's own error answer: `{"error":true,"message":…}` (a 404 for an unknown route). */
export function proxyError(status: number, message: string): FakeReply {
  return { status, body: { error: true, message } };
}

/** A clock that the recorded sleeps move forward. */
export function fakeTime(start = Date.parse("2026-11-26T10:00:00Z")) {
  let time = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}
