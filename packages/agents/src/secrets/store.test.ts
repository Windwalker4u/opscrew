// T2839: one creation rule per app's recovery copy in opscrew/.sops.yaml.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgeIdentity, resolveProjectPaths } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readRecipients, SOPS_CONFIG_PATH, sopsConfigFile } from "./store";

const key = () => generateAgeIdentity().recipient;

/** The rule sops picks for `file`: the first whose `path_regex` matches (RE2 and JS agree here). */
function ruleFor(content: string, file: string): string | undefined {
  const rules = parse(content).creation_rules as { path_regex: string; age: string }[];
  return rules.find((rule) => new RegExp(rule.path_regex).test(file))?.age;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repository(sopsYaml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-sops-rules-"));
  roots.push(root);
  if (sopsYaml !== undefined) {
    await mkdir(join(root, "opscrew"), { recursive: true });
    await writeFile(join(root, SOPS_CONFIG_PATH), sopsYaml);
  }
  return root;
}

describe("sopsConfigFile", () => {
  it("one app: the general rule alone, as before", () => {
    const a = key();
    expect(parse(sopsConfigFile([a]).content)).toEqual({
      creation_rules: [{ path_regex: "secrets\\.sops\\.json$", age: a }],
    });
  });

  it("a further app's rule goes before the general one and matches only its own copies", () => {
    const [first, pay, docs] = [key(), key(), key()];
    const one = sopsConfigFile([first]).content;
    const two = sopsConfigFile([pay], "pay", one).content;
    const three = sopsConfigFile([docs], "docs", two).content;
    const rules = parse(three).creation_rules as { path_regex: string }[];
    expect(rules.at(-1)?.path_regex).toBe("secrets\\.sops\\.json$");
    expect(rules).toHaveLength(3);
    // sops matches the copy's path relative to opscrew/ (with the system's separator), or the
    // full path when the file lies elsewhere.
    for (const [file, age] of [
      ["secrets.sops.json", first],
      ["environments/staging/secrets.sops.json", first],
      ["apps/pay/secrets.sops.json", pay],
      ["apps/pay/environments/staging/secrets.sops.json", pay],
      ["apps\\pay\\environments\\staging\\secrets.sops.json", pay],
      ["/work/shop/opscrew/apps/pay/secrets.sops.json", pay],
      ["apps/docs/secrets.sops.json", docs],
      ["apps/xpay/secrets.sops.json", first],
    ] as const) {
      expect(ruleFor(three, file), file).toBe(age);
    }
  });

  it("replaces only its own app's rule, and the first app's rule is added after the further ones", () => {
    const [pay, first, again] = [key(), key(), key()];
    const onlyPay = sopsConfigFile([pay], "pay").content;
    const both = sopsConfigFile([first], undefined, onlyPay).content;
    expect(ruleFor(both, "apps/pay/secrets.sops.json")).toBe(pay);
    expect(ruleFor(both, "secrets.sops.json")).toBe(first);
    const rotated = sopsConfigFile([again], undefined, both).content;
    expect(ruleFor(rotated, "apps/pay/secrets.sops.json")).toBe(pay);
    expect(ruleFor(rotated, "secrets.sops.json")).toBe(again);
    // A file that does not parse is never written over with this app's rule alone.
    expect(() => sopsConfigFile([again], "pay", "creation_rules: [broken\n")).toThrow(
      /does not parse/,
    );
  });
});

describe("readRecipients", () => {
  /** The paths of the app `app` (absent: the first app) in the repository at `root`. */
  const at = (root: string, app?: string) =>
    resolveProjectPaths(root, {
      env: { OPSCREW_HOME: join(root, ".home-opscrew") },
      ...(app === undefined ? {} : { app }),
    });

  /** A sops-shaped copy of the app at `root`, sealed to `recipients`. */
  async function copyOf(root: string, app: string | undefined, recipients: string[]) {
    const dir = at(root, app).artefactsDir;
    await mkdir(dir, { recursive: true });
    const sops = { age: recipients.map((recipient) => ({ recipient, enc: "sealed" })), mac: "x" };
    await writeFile(join(dir, "secrets.sops.json"), JSON.stringify({ files: {}, sops }));
  }

  it("reads each app's own rule; a further app without one follows the general rule", async () => {
    const [first, backup, pay] = [key(), key(), key()];
    const general = sopsConfigFile([first, backup]).content;
    const root = await repository(general);
    expect(await readRecipients(at(root))).toEqual([first, backup]);
    expect(await readRecipients(at(root, "pay"))).toEqual([first, backup]);

    await writeFile(join(root, SOPS_CONFIG_PATH), sopsConfigFile([pay], "pay", general).content);
    expect(await readRecipients(at(root))).toEqual([first, backup]);
    expect(await readRecipients(at(root, "pay"))).toEqual([pay]);
  });

  it("an app with a copy but no rule of its own: the keys its copy is sealed to", async () => {
    const [first, backup, old] = [key(), key(), key()];
    const root = await repository(sopsConfigFile([first, backup]).content);
    await copyOf(root, "pay", [old, backup]);
    expect(await readRecipients(at(root, "pay"))).toEqual([old, backup]);
    // Its own rule wins once it has one.
    const own = key();
    const general = sopsConfigFile([first, backup]).content;
    await writeFile(join(root, SOPS_CONFIG_PATH), sopsConfigFile([own], "pay", general).content);
    expect(await readRecipients(at(root, "pay"))).toEqual([own]);
    // A copy that is not a sops file stops plainly.
    await copyOf(root, "docs", []);
    await expect(readRecipients(at(root, "docs"))).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
  });

  it("undefined without the file or the app's rule; a file that does not parse stops plainly", async () => {
    expect(await readRecipients(at(await repository()))).toBeUndefined();
    const onlyPay = await repository(sopsConfigFile([key()], "pay").content);
    expect(await readRecipients(at(onlyPay))).toBeUndefined();
    expect(await readRecipients(at(onlyPay, "docs"))).toBeUndefined();
    const damaged = await repository("creation_rules: [broken\n");
    await expect(readRecipients(at(damaged, "pay"))).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("opscrew/.sops.yaml does not parse"),
      hint: expect.stringContaining("git restore opscrew/.sops.yaml"),
    });
    const tooMany = await repository(sopsConfigFile([key(), key(), key()]).content);
    await expect(readRecipients(at(tooMany))).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      hint: expect.stringContaining("opscrew rotate recovery-key"),
    });
  });
});
