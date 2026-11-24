import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PUBLIC_KEY } from "../__fixtures__/plans";
import { renderCloudInit } from "./cloud-init";
import { FIRST_BOOT_SCRIPT, renderFirstBootScript } from "./first-boot";
import { serverModuleFiles } from "./modules";

/** A provider's module, as the contract carries it. */
const module = { name: "example-server", files: { "main.tf": "" } } as const;

/** A POSIX shell to check the script's syntax with, or undefined when none is here. */
const shell = (() => {
  const candidates = [
    "sh",
    "bash",
    // Git for Windows installs its shell off PATH, where a Windows session usually finds it.
    ...(process.platform === "win32"
      ? [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\sh.exe`]
      : []),
  ];
  return candidates.find((candidate) => spawnSync(candidate, ["-n", "-c", "true"]).status === 0);
})();

/** Why the shell check is skipped, or undefined when it runs. */
const shellSkip = shell === undefined ? "no sh or bash is here" : undefined;
if (shellSkip !== undefined) console.warn(`[iac-templates] skipping the shell check: ${shellSkip}`);

describe("a provider that takes the first boot as a startup script", () => {
  it("gets the shared script beside the cloud-config, and no other provider does", () => {
    const script = serverModuleFiles({ module, firstBoot: "script" });
    expect(script[FIRST_BOOT_SCRIPT]).toBeTruthy();
    expect(script["cloud-init.yaml.tftpl"]).toBeTruthy();

    const others = serverModuleFiles({ module });
    expect(others[FIRST_BOOT_SCRIPT]).toBeUndefined();
    expect(others["cloud-init.yaml.tftpl"]).toBeTruthy();
  });

  it("carries the same cloud-config, base64-encoded, with nothing left to interpolate", () => {
    const config = renderCloudInit({ sshPublicKey: PUBLIC_KEY, web: true });
    const script = renderFirstBootScript(config);
    const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(script)?.[1] ?? "";
    expect(encoded).not.toBe("");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(config);
    expect(script).not.toContain("${");
  });

  it("runs once, and says so with a marker", () => {
    const script = renderFirstBootScript(renderCloudInit({ sshPublicKey: PUBLIC_KEY, web: false }));
    expect(script).toContain("if [ -e /var/lib/opscrew/first-boot.done ]; then");
    expect(script).toContain("date -Is >/var/lib/opscrew/first-boot.done");
    // The steps come from cloud-init, as on every other provider.
    expect(script).toContain("cloud-init modules --mode=final");
  });

  it.skipIf(shellSkip !== undefined)("is a script the shell accepts", () => {
    const script = renderFirstBootScript(
      renderCloudInit({
        sshPublicKey: PUBLIC_KEY,
        checkKeyLine: "ssh-ed25519 AAAA check",
        web: true,
      }),
    );
    const result = spawnSync(shell ?? "sh", ["-n"], { input: script, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
