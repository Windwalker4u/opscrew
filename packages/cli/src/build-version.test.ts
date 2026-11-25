import { describe, expect, it } from "vitest";
import { buildVersion } from "../scripts/build-version.mjs";

const git = (tags: string[], commit: string | undefined) => ({
  tagsAtHead: () => tags,
  shortCommit: () => commit,
});

describe("buildVersion", () => {
  it("reports the release's own version on the commit of its tag", () => {
    expect(buildVersion("0.2.12", git(["v0.2.12"], "abc1234"))).toBe("0.2.12");
    expect(buildVersion("0.2.12", git(["latest", "v0.2.12"], "abc1234"))).toBe("0.2.12");
  });

  it("reports a pre-release naming the commit anywhere else", () => {
    expect(buildVersion("0.2.12", git([], "abc1234"))).toBe("0.2.12-dev.abc1234");
    // Another release's tag, or a tag that isn't one, is not this version's.
    expect(buildVersion("0.2.12", git(["v0.2.11", "0.2.12"], "abc1234"))).toBe(
      "0.2.12-dev.abc1234",
    );
  });

  it("never reports the release's version when git can't name the commit", () => {
    expect(buildVersion("0.2.12", git([], undefined))).toBe("0.2.12-dev");
  });
});
