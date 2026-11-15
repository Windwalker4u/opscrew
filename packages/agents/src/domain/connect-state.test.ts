import { describe, expect, it } from "vitest";
import { dsWaitSeconds, laterSwitch } from "./connect-state";

describe("dsWaitSeconds", () => {
  it.each([
    [1800, 7200],
    [3600, 10_800],
    [0, 3600],
    [43_200, 90_000],
    [86_400, 172_800],
    [604_800, 172_800],
  ])(
    "waits a registry TTL of %i seconds as %i seconds: twice it plus an hour, within 1 and 48 hours",
    (ttl, wait) => {
      expect(dsWaitSeconds(ttl)).toBe(wait);
    },
  );

  it.each([
    [undefined, 86_400],
    [7200, 86_400],
    [108_000, 108_000],
    [604_800, 172_800],
  ])(
    "without the registry's TTL, waits 24 hours, or a resolver copy's TTL of %s seconds up to 48 hours",
    (resolverTtl, wait) => {
      expect(dsWaitSeconds(undefined, resolverTtl)).toBe(wait);
    },
  );
});

describe("laterSwitch", () => {
  const state = {
    domain: "example.com",
    registrar: "porkbun" as const,
    switchAfter: "2026-10-12T14:00:00.000Z",
    waitSeconds: 86_400,
  };

  it("only ever moves the switch time later", () => {
    expect(laterSwitch(state, Date.parse("2026-10-13T15:00:00.000Z"))).toBe(
      "2026-10-13T15:00:00.000Z",
    );
    expect(laterSwitch(state, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T14:00:00.000Z",
    );
    expect(laterSwitch(undefined, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T13:00:00.000Z",
    );
    const seen = { ...state, switchAfter: undefined, dsSeen: "2026-10-11T12:00:00.000Z" };
    expect(laterSwitch(seen, Date.parse("2026-10-12T13:00:00.000Z"))).toBe(
      "2026-10-12T13:00:00.000Z",
    );
  });
});
