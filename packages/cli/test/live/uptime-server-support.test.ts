import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  diskPercent,
  fillBytes,
  heartbeatBody,
  reportedCredentials,
  reportSignature,
  sshInvocation,
  titlesOf,
  UPTIME_SERVER_GATE,
  uptimeServerMissing,
} from "./uptime-server-support";

const DF = (used: number, free: number) =>
  [
    "Filesystem     1-blocks       Used  Available Capacity Mounted on",
    `/dev/sda1   ${used + free + 1000} ${used} ${free}      10% /`,
  ].join("\n");

describe("diskPercent", () => {
  it("rounds up as the server's script does", () => {
    expect(diskPercent(DF(840, 160))).toBe(84);
    expect(diskPercent(DF(841, 159))).toBe(85);
    expect(diskPercent(DF(1, 999))).toBe(1);
  });

  it("throws on a df output without a figures line", () => {
    expect(() => diskPercent("Filesystem 1-blocks Used Available")).toThrow(/df/);
  });
});

describe("fillBytes", () => {
  it("fills to the target percent, past the warning and under the high mark", () => {
    const used = 3_000_000_000;
    const free = 37_000_000_000;
    const bytes = fillBytes(DF(used, free), 88);
    expect(diskPercent(DF(used + bytes, free - bytes))).toBe(88);
  });

  it("refuses a target outside 85 to 94", () => {
    expect(() => fillBytes(DF(100, 900), 95)).toThrow(/85/);
    expect(() => fillBytes(DF(100, 900), 84)).toThrow(/85/);
  });

  it("refuses a disk already past the warning", () => {
    expect(() => fillBytes(DF(860, 140), 88)).toThrow(/already/);
  });
});

describe("sshInvocation", () => {
  it("sends a short one-line command as it is, with its input", () => {
    expect(sshInvocation("true", "x")).toEqual({ command: "true", input: "x" });
    expect(sshInvocation("true")).toEqual({ command: "true" });
  });

  it("sends a long or multi-line command over stdin, before the input", () => {
    const command = "echo a\necho b";
    const sent = sshInvocation(command, "secret\n");
    expect(sent.command).toContain(`count=${Buffer.byteLength(command)}`);
    expect(sent.command).not.toContain("echo a");
    expect(sent.input).toBe(`${command}secret\n`);
    expect(sshInvocation("x".repeat(3000)).input).toBe("x".repeat(3000));
  });
});

describe("reportSignature", () => {
  it("is the HMAC-SHA256 of the time, a newline and the body, with the key's bytes", () => {
    const key = "0f".repeat(32);
    const expected = createHmac("sha256", Buffer.from(key, "hex"))
      .update("1700000000\n{}")
      .digest("hex");
    expect(reportSignature(key, 1_700_000_000, "{}")).toBe(expected);
  });
});

describe("heartbeatBody", () => {
  it("is the stored report without its time and each check's since, as a heartbeat", () => {
    const stored = {
      version: 1,
      server: "own-abc",
      kind: "change",
      disk: { status: "warn", percent: 88, free: 1, total: 9, since: "2026-11-26T03:00:00.000Z" },
      snapshot: { status: "none" },
      drill: { status: "none" },
      certificates: [{ hostname: "a.example.com", status: "ok", days: 80 }],
      credentials: [{ name: "deploy-key", status: "old", days: 400, source: "made", since: "x" }],
      at: 1_700_000_000,
    };
    expect(JSON.parse(heartbeatBody(stored))).toEqual({
      version: 1,
      server: "own-abc",
      kind: "heartbeat",
      disk: { status: "warn", percent: 88, free: 1, total: 9 },
      snapshot: { status: "none" },
      drill: { status: "none" },
      certificates: [{ hostname: "a.example.com", status: "ok", days: 80 }],
      credentials: [{ name: "deploy-key", status: "old", days: 400, source: "made" }],
    });
  });

  it("leaves out credentials the stored report has none of", () => {
    const body = JSON.parse(
      heartbeatBody({
        version: 1,
        server: "s",
        kind: "change",
        disk: { status: "ok" },
        snapshot: { status: "none" },
        drill: { status: "none" },
        certificates: [],
        at: 1,
      }),
    );
    expect(body).not.toHaveProperty("credentials");
  });
});

describe("reportedCredentials", () => {
  it("dates the credentials the scheduled check dates, as the agents do", () => {
    const listed = [
      {
        name: "deploy-key",
        kind: "key",
        rotation: { mode: "swap" },
        changes: "",
        date: { at: "2026-11-26T03:00:00.000Z", source: "made" },
      },
      { name: "app", kind: "app", rotation: { mode: "restart" }, changes: "" },
      {
        name: "cloudflare-token",
        kind: "user-token",
        rotation: { mode: "user" },
        changes: "",
        date: { at: "2026-11-01T00:00:00.000Z", source: "first-seen" },
      },
      {
        name: "state-passphrase",
        kind: "passphrase",
        rotation: { mode: "none" },
        changes: "",
        date: { at: "2026-11-26T03:00:00.000Z", source: "made" },
      },
      { name: "undated", kind: "key", rotation: { mode: "swap" }, changes: "" },
    ];
    expect(reportedCredentials(listed)).toEqual([
      { name: "deploy-key", at: "2026-11-26T03:00:00.000Z", source: "made" },
    ]);
  });
});

describe("titlesOf", () => {
  it("gives the messages' titles that hold every part, in order", () => {
    const messages = [
      { time: 1, title: "OpsCrew check: app (prod) disk over 85% full on s", message: "" },
      { time: 2, title: "OpsCrew uptime check: reports from app (prod) on s stopped", message: "" },
      { time: 3, message: "no title" },
    ];
    expect(titlesOf(messages, "disk over")).toEqual([messages[0]?.title]);
    expect(titlesOf(messages, "reports from", "stopped")).toHaveLength(1);
    expect(titlesOf(messages, "nothing")).toEqual([]);
  });
});

describe("uptimeServerMissing", () => {
  it("names the gate and each variable not set", () => {
    expect(uptimeServerMissing({})).toContain(`${UPTIME_SERVER_GATE}=1`);
    expect(uptimeServerMissing({})).toContain("OPSCREW_CLOUDFLARE_TOKEN_B");
    expect(uptimeServerMissing({})).toContain("OPSCREW_E2E_NTFY_TOPIC");
    const all = Object.fromEntries(
      uptimeServerMissing({}).map((name) => [name.replace(/=1$/, ""), "1"]),
    );
    expect(uptimeServerMissing(all)).toEqual([]);
  });
});
