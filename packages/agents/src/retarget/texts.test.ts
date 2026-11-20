import { describe, expect, it } from "vitest";
import { moveMinutes, preCopyWords } from "./texts";

const MB = 1024 * 1024;

describe("a move's minutes before and in its maintenance window", () => {
  it("counts the data copied about whole in the window at the copy's rate, the rest at a twentieth", () => {
    // The PHP app: 262 MB of files and 219 MB of MySQL, through this computer between two servers.
    const forum = moveMinutes(
      { files: 262 * MB, whole: 219 * MB },
      { portainer: false, server: true },
    );
    // Before: two minutes and 481 MB at 100 MB a minute, plus the deploy that starts the app.
    // The window: a minute, MySQL's folder (3 minutes), and a twentieth of the files (1 minute).
    expect(forum).toEqual({ preCopy: 12, window: 5 });
    // Postgres's 50 MB by its dump; no deploy before the window in Portainer.
    expect(moveMinutes({ files: 0, whole: 50 * MB }, { portainer: false, server: true })).toEqual({
      preCopy: 8,
      window: 2,
    });
    expect(moveMinutes({ files: 0, whole: 50 * MB }, { portainer: true, server: false })).toEqual({
      preCopy: 3,
      window: 2,
    });
    // Files alone: their changes only.
    expect(moveMinutes({ files: 100 * MB, whole: 0 }, { portainer: false, server: true })).toEqual({
      preCopy: 8,
      window: 2,
    });
  });

  it("says the time before the window after its downtime, once", () => {
    const data = [{ owner: "db", key: "/var/lib/postgresql/data", bytes: 1, copy: true }];
    expect(preCopyWords({ preCopyMinutes: 8, data })).toBe(
      ", after about 8 minutes of copying while your app serves",
    );
    expect(preCopyWords({ preCopyMinutes: 7, data: [] })).toBe(
      ", after about 7 minutes of starting the app there while your app serves",
    );
    expect(preCopyWords({ data })).toBe("");
  });
});
