import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { OVHCLOUD_API_URL, OVHCLOUD_TOKEN_URL } from "../client";

/** The four values, synthetic, by environment variable. */
export const CREDENTIALS_ENV = {
  OVH_ENDPOINT: "ovh-eu",
  OVH_CLIENT_ID: fakeSecret("generic-password", "ovh-client-id"),
  OVH_CLIENT_SECRET: fakeSecret("generic-password", "ovh-client-secret"),
  OVH_CLOUD_PROJECT_SERVICE: fakeSecret("generic-password", "ovh-project-id"),
} as const;

/** The same values as the client takes them. */
export const CREDENTIALS = {
  clientId: CREDENTIALS_ENV.OVH_CLIENT_ID,
  clientSecret: CREDENTIALS_ENV.OVH_CLIENT_SECRET,
  projectId: CREDENTIALS_ENV.OVH_CLOUD_PROJECT_SERVICE,
};

/** The project's id, as it appears in request paths. */
export const PROJECT = CREDENTIALS.projectId;

/** The route of OVHcloud's OAuth2 token endpoint. */
export const TOKEN = `POST ${OVHCLOUD_TOKEN_URL}`;

/** An access token, synthetic and long enough for the redactor to mask it. */
export function accessToken(seed: string): string {
  return fakeSecret("generic-password", `ovh-access-${seed}`);
}

/**
 * The token endpoint answering with the access token of `seed`, valid for `expiresIn` seconds,
 * in the shape OVHcloud's service-account guide shows.
 */
export function token(seed: string, expiresIn = 3599): FakeReply {
  return {
    body: {
      access_token: accessToken(seed),
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "all",
    },
  };
}

/**
 * Core's fake fetch with routes relative to OVHcloud's API (`/v1/cloud/project/…`) and a token
 * endpoint answering `accessToken("1")` unless `routes` sets {@link TOKEN}.
 */
export function ovhFetch(routes: Record<string, FakeReply | FakeReply[]>) {
  return fakeFetch({ [TOKEN]: token("1"), ...routes }, { base: OVHCLOUD_API_URL });
}

/**
 * An OVHcloud error answer: `{ class, message, details }` (go-ovh `ovh/error.go`), with the
 * `X-Ovh-QueryID` header OVHcloud sends with it.
 */
export function apiError(
  status: number,
  body: { class?: string; message: string; details?: Record<string, string> },
  headers: Record<string, string> = {},
): FakeReply {
  return { status, body, headers: { "X-Ovh-QueryID": "EU.ext-1.fake.0001", ...headers } };
}

/** A clock that the recorded sleeps move forward. */
export function fakeTime(start = Date.parse("2026-11-21T10:00:00Z")) {
  let time = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}
