import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { executeBuiltinTool, toolDefinitionsFor } from "./tools";

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-openai-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

type RunOpts = Parameters<CommandRunner["run"]>[2];

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: RunOpts }> = [];
  next: CommandResult = { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };

  async run(command: string, args: string[], options?: RunOpts): Promise<CommandResult> {
    this.calls.push({ command, args, ...(options === undefined ? {} : { options }) });
    return this.next;
  }
}

describe("toolDefinitionsFor", () => {
  it("builds function tool schemas with DefaultToolPolicy parameter names", () => {
    const defs = toolDefinitionsFor(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
    expect(defs.map((d) => d.name)).toEqual(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.strict).toBe(false);
    }
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.parameters]));
    expect(byName.Read?.required).toEqual(["file_path"]);
    expect(byName.Write?.required).toEqual(["file_path", "content"]);
    expect(byName.Edit?.required).toEqual(["file_path", "old_string", "new_string"]);
    expect(byName.Glob?.required).toEqual(["pattern"]);
    expect(byName.Grep?.required).toEqual(["pattern"]);
    expect(byName.Bash?.required).toEqual(["command"]);
  });
});

describe("executeBuiltinTool", () => {
  it("reads files with 1-based offset and limit, and refuses secrets or root escapes", async () => {
    const root = await makeTempProject();
    await writeFile(path.join(root, "app.ts"), "line1\nline2\nline3\nline4\n");
    await writeFile(path.join(root, ".env"), "SECRET=value\n");
    const runner = new RecordingRunner();

    const read = await executeBuiltinTool(
      "Read",
      { file_path: "app.ts", offset: 2, limit: 2 },
      { projectRoot: root, env: {}, runner },
    );
    expect(read.ok).toBe(true);
    expect(read.output).toContain("2\tline2");
    expect(read.output).toContain("3\tline3");
    expect(read.output).not.toContain("line1");
    expect(read.output).not.toContain("line4");

    const secret = await executeBuiltinTool(
      "Read",
      { file_path: ".env" },
      { projectRoot: root, env: {}, runner },
    );
    expect(secret.ok).toBe(false);
    expect(secret.output).toContain("secrets");

    const escaped = await executeBuiltinTool(
      "Read",
      { file_path: "../outside.txt" },
      { projectRoot: root, env: {}, runner },
    );
    expect(escaped.ok).toBe(false);
    expect(escaped.output).toContain("outside");
  });

  it("writes and edits files inside projectRoot and rejects non-unique edits unless replace_all", async () => {
    const root = await makeTempProject();
    const runner = new RecordingRunner();

    const written = await executeBuiltinTool(
      "Write",
      { file_path: "src/server.ts", content: "const a = 1;\nconst b = 1;\n" },
      { projectRoot: root, env: {}, runner },
    );
    expect(written.ok).toBe(true);
    expect(await readFile(path.join(root, "src/server.ts"), "utf8")).toBe(
      "const a = 1;\nconst b = 1;\n",
    );

    const ambiguous = await executeBuiltinTool(
      "Edit",
      { file_path: "src/server.ts", old_string: "= 1", new_string: "= 2" },
      { projectRoot: root, env: {}, runner },
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.output).toContain("2 times");

    const all = await executeBuiltinTool(
      "Edit",
      { file_path: "src/server.ts", old_string: "= 1", new_string: "= 2", replace_all: true },
      { projectRoot: root, env: {}, runner },
    );
    expect(all.ok).toBe(true);
    expect(await readFile(path.join(root, "src/server.ts"), "utf8")).toBe(
      "const a = 2;\nconst b = 2;\n",
    );
  });

  it("blocks symlink escapes during Read and Write as defense in depth", async () => {
    const outer = await makeTempProject();
    const root = path.join(outer, "app");
    await mkdir(root, { recursive: true });
    const outsideFile = path.join(outer, "outside.txt");
    await writeFile(outsideFile, "outside-data");
    const linkPath = path.join(root, "escape.txt");
    try {
      await symlink(outsideFile, linkPath);
    } catch {
      // Skip on Windows environments without symlink privileges.
      return;
    }
    const runner = new RecordingRunner();
    const read = await executeBuiltinTool(
      "Read",
      { file_path: "escape.txt" },
      { projectRoot: root, env: {}, runner },
    );
    expect(read.ok).toBe(false);

    const write = await executeBuiltinTool(
      "Write",
      { file_path: "escape.txt", content: "overwrite" },
      { projectRoot: root, env: {}, runner },
    );
    expect(write.ok).toBe(false);
    expect(await readFile(outsideFile, "utf8")).toBe("outside-data");
  });

  it("globs and greps files while always skipping secret files", async () => {
    const root = await makeTempProject();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/index.ts"), "export const PORT = 3000;\n");
    await writeFile(path.join(root, "src/health.ts"), "export const route = '/health';\n");
    await writeFile(path.join(root, ".env"), "PORT=3000\nAPI_SECRET=do-not-leak\n");
    await writeFile(path.join(root, "server.key"), "PORT=3000\n");
    const runner = new RecordingRunner();

    const globbed = await executeBuiltinTool(
      "Glob",
      { pattern: "**/*" },
      { projectRoot: root, env: {}, runner },
    );
    expect(globbed.ok).toBe(true);
    expect(globbed.output).toContain("src/index.ts");
    expect(globbed.output).toContain("src/health.ts");
    expect(globbed.output).not.toContain(".env");
    expect(globbed.output).not.toContain("server.key");

    const grepped = await executeBuiltinTool(
      "Grep",
      { pattern: "PORT", glob: "*.ts" },
      { projectRoot: root, env: {}, runner },
    );
    expect(grepped.ok).toBe(true);
    expect(grepped.output).toContain("src/index.ts:1:export const PORT = 3000;");
    expect(grepped.output).not.toContain(".env");
    expect(grepped.output).not.toContain("server.key");
  });

  it("runs Bash with sanitized environment stripping OPENAI_API_KEY and provider secrets", async () => {
    const root = await makeTempProject();
    const runner = new RecordingRunner();
    runner.next = { exitCode: 0, stdout: "node v22\n", stderr: "", timedOut: false };

    const env = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: fakeSecret("openai-key"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"),
      NODE_ENV: "test",
    };

    const res = await executeBuiltinTool(
      "Bash",
      { command: "node -v" },
      { projectRoot: root, env, runner },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("node v22");
    expect(runner.calls).toHaveLength(1);
    const passedEnv = runner.calls[0]?.options?.env ?? {};
    expect(passedEnv.NODE_ENV).toBe("test");
    expect(passedEnv.OPENAI_API_KEY).toBeUndefined();
    expect(passedEnv.HCLOUD_TOKEN).toBeUndefined();
    expect(passedEnv.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(runner.calls[0]?.options?.cwd).toBe(root);
  });
});
