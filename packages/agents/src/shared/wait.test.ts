import type { ApprovalRequest } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { confirmChangedHostKey } from "./wait";

describe("confirmChangedHostKey", () => {
  it("names the server in the details only: the title goes to the approvals record and the audit log", async () => {
    const seen: ApprovalRequest[] = [];
    const approvals = {
      async request(request: ApprovalRequest) {
        seen.push(request);
        return { approved: true };
      },
    } as unknown as PhaseDeps["approvals"];
    const confirm = confirmChangedHostKey({ approvals });
    const approved = await confirm({
      host: "203.0.113.10",
      previous: ["ssh-ed25519 AAAAold"],
      current: ["ssh-ed25519 AAAAnew"],
    });
    expect(approved).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe("Trust the server's new SSH host key");
    expect(seen[0]?.title).not.toContain("203.0.113.10");
    expect(seen[0]?.details).toContain("Server: 203.0.113.10");
  });
});
