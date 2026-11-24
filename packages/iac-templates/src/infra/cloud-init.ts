import { SERVER_MODULE_FILES } from "../generated/modules";

/** What a server module passes its `templatefile` of `cloud-init.yaml.tftpl`, by meaning. */
export interface CloudInitInputs {
  /** The deploy key's public line, as the module's `ssh_public_key` (trimmed). */
  sshPublicKey: string;
  /** The scheduled check's authorized_keys line (`check_key_line`); none without the check. */
  checkKeyLine?: string | undefined;
  /** Whether the server serves the web (`web`): ufw then allows ports 80 and 443. */
  web: boolean;
}

/**
 * HCL's `jsonencode` of a string: JSON, with `<`, `>`, `&`, U+2028 and U+2029 written as `\u`
 * escapes (Go's HTML-safe encoding, which OpenTofu and Terraform use).
 */
function jsonencode(text: string): string {
  return JSON.stringify(text).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Renders a template the way `templatefile` renders one under OpenTofu and Terraform: keeps or
 * drops the lines of each whole-line `%{ if <bool> ~}` … `%{ endif ~}`, puts in the string
 * variables (their values as they are, never read as patterns or templates) and unescapes `$${`
 * and `%%{`. Throws on any other interpolation or directive.
 */
export function templatefile(source: string, vars: Record<string, string | boolean>): string {
  const kept = source.replace(
    /^%\{ if (\w+) ~\}\n([\s\S]*?)^%\{ endif ~\}\n/gm,
    (_match, name: string, body: string) => {
      const value = vars[name];
      if (typeof value !== "boolean") throw new Error(`The template needs the boolean ${name}.`);
      return value ? body : "";
    },
  );
  return kept.replace(/\$\$\{|%%\{|\$\{([^}]*)\}|%\{[^}]*\}/g, (match, name?: string) => {
    if (match === "$${") return "${";
    if (match === "%%{") return "%{";
    const value = name === undefined ? undefined : vars[name.trim()];
    if (typeof value === "string") return value;
    throw new Error(`The template has an expression OpsCrew does not render: ${match}`);
  });
}

/**
 * The first-boot file (cloud-init user data) the server modules render from
 * `cloud-init.yaml.tftpl` with `templatefile`, byte for byte: the check key's line goes in as a
 * second authorized key, YAML-quoted by `jsonencode`, as each module's `check_key_entry` does. For
 * an install of a server again through its provider's API, which needs the same file.
 */
export function renderCloudInit(inputs: CloudInitInputs): string {
  const line = inputs.checkKeyLine ?? "";
  return templatefile(SERVER_MODULE_FILES["cloud-init.yaml.tftpl"] ?? "", {
    ssh_public_key: inputs.sshPublicKey,
    check_key_entry: line === "" ? "" : `\n      - ${jsonencode(line)}`,
    web: inputs.web,
  });
}
