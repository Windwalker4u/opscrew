import type { ManifestEntry } from "@opscrew/connector-docker";
import { describe, expect, it } from "vitest";
import { mountDelta } from "./delta";

const folder = (path: string, mode = "755", uid = 0): ManifestEntry => ({
  path,
  type: "directory",
  mode,
  uid,
  gid: uid,
  size: 0,
});
const file = (path: string, sha: string, size = 3): ManifestEntry => ({
  path,
  type: size === 0 ? "regular empty file" : "regular file",
  mode: "644",
  uid: 999,
  gid: 999,
  size,
  sha256: sha.repeat(64).slice(0, 64),
});
const link = (path: string, target: string): ManifestEntry => ({
  path,
  type: "symbolic link",
  mode: "777",
  uid: 0,
  gid: 0,
  size: target.length,
  target,
});

describe("mountDelta", () => {
  it("copies nothing and removes nothing when both sides hold the same", () => {
    const same = [folder("."), folder("./a"), file("./a/one.txt", "1"), link("./b", "a")];
    expect(mountDelta(same, structuredClone(same))).toEqual({ copy: [], remove: [] });
  });

  it("copies what is new or differs in content, size, type, mode, owner, group or target", () => {
    const old = [
      folder("."),
      file("./changed.txt", "2"),
      file("./grown.txt", "1", 9),
      file("./mode.txt", "1"),
      file("./owner.txt", "1"),
      file("./group.txt", "1"),
      link("./link", "new-target"),
      folder("./now-a-folder"),
      file("./new.txt", "4"),
      folder("./new"),
      file("./new/inside.txt", "5"),
      file("./same.txt", "1"),
    ];
    const fresh = [
      folder("."),
      file("./changed.txt", "1"),
      file("./grown.txt", "1", 3),
      { ...file("./mode.txt", "1"), mode: "600" },
      { ...file("./owner.txt", "1"), uid: 0 },
      { ...file("./group.txt", "1"), gid: 0 },
      link("./link", "old-target"),
      file("./now-a-folder", "1"),
      file("./same.txt", "1"),
    ];
    expect(mountDelta(old, fresh)).toEqual({
      copy: [
        "./changed.txt",
        "./grown.txt",
        "./mode.txt",
        "./owner.txt",
        "./group.txt",
        "./link",
        "./now-a-folder",
        "./new.txt",
        "./new",
        "./new/inside.txt",
      ],
      remove: [],
    });
  });

  it("copies a folder's own entry only when its mode or owner differs", () => {
    const old = [folder("."), folder("./uploads", "775", 33)];
    expect(mountDelta(old, [folder("."), folder("./uploads", "755", 33)]).copy).toEqual([
      "./uploads",
    ]);
    expect(mountDelta(old, [folder(".", "700"), folder("./uploads", "775", 0)]).copy).toEqual([
      ".",
      "./uploads",
    ]);
  });

  it("removes what only the new side has, a removed folder once with its content", () => {
    const old = [folder("."), file("./kept.txt", "1")];
    const fresh = [
      folder("."),
      folder("./cache"),
      folder("./cache/pages"),
      file("./cache/pages/1.html", "1"),
      file("./cache-file.txt", "1"),
      file("./kept.txt", "1"),
      file("./stale.log", "1", 0),
    ];
    expect(mountDelta(old, fresh)).toEqual({
      copy: [],
      remove: ["./cache", "./cache-file.txt", "./stale.log"],
    });
  });
});
