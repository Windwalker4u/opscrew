import { describe, expect, it } from "vitest";
import { requireSnapshotId } from "./store";

describe("a whole-server snapshot's id", () => {
  it("takes each provider's shape: a number, Contabo's two parts, OVHcloud's UUID", () => {
    for (const id of ["9001", "202611001:snap1762862400", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
      expect(() => requireSnapshotId(id, { server: true })).not.toThrow();
    }
  });

  it("refuses a UUID as a data snapshot's id, and anything else that isn't one of those shapes", () => {
    expect(() => requireSnapshotId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toThrow(/only letters and digits./);
    for (const id of [
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/x",
      "../etc",
      "a;b",
      "",
    ]) {
      expect(() => requireSnapshotId(id, { server: true })).toThrow(/is no snapshot's id/);
    }
  });
});
