/**
 * Plan-hash-bound Fastly backend mTLS configuration (ADR 0038 D6).
 *
 * Why this is NOT in Terraform: `fastly_service_vcl.backend.ssl_client_key` would persist the
 * private client key inside Terraform state. Instead, OpsCrew keeps the per-app P-256 client key
 * in local `generated_values.json` (0600), puts only the public client certificate in `pull.pem`
 * on the server proxy, and configures `ssl_client_cert` + `ssl_client_key` on the Fastly backend
 * through Fastly's API (clone active version -> update backend -> activate) after an approval
 * bound to the plan's SHA-256 hash.
 */
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import type { FastlyClient } from "./client";

export type FastlyMtlsAction = "configure" | "update" | "noop";

export interface FastlyOriginMtlsPlan {
  action: FastlyMtlsAction;
  serviceId: string;
  activeVersion: number;
  backendName: string;
  /** Short SHA-256 fingerprint of the public client certificate PEM (never the private key). */
  certFingerprint: string;
  /** Plain-English summary shown before approval (contains no private key). */
  summary: string;
  /** SHA-256 hash binding approval to this exact service, version, backend, and cert fingerprint. */
  hash: string;
}

function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").trim();
}

function assertClientKeyPair(certPem: string, keyPem: string): void {
  if (!certPem.includes("BEGIN CERTIFICATE")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The origin mTLS client certificate must be a PEM-encoded X.509 certificate.",
    );
  }
  if (!keyPem.includes("PRIVATE KEY")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "The origin mTLS client private key must be a PEM-encoded private key.",
    );
  }
}

/**
 * Inspects the active Fastly VCL service version's backend and plans configuring or updating its
 * mTLS client certificate (`pull.pem`) without exposing the private key in the plan or hash.
 */
export async function planFastlyOriginMtls(
  client: Pick<FastlyClient, "getActiveVersion" | "getBackend">,
  input: {
    serviceId: string;
    backendName: string;
    clientCertPem: string;
    clientKeyPem: string;
  },
): Promise<FastlyOriginMtlsPlan> {
  assertClientKeyPair(input.clientCertPem, input.clientKeyPem);
  const activeVersion = await client.getActiveVersion(input.serviceId);
  const backend = await client.getBackend(input.serviceId, activeVersion, input.backendName);
  const desiredCert = normalizePem(input.clientCertPem);
  const existingCert = backend.ssl_client_cert ? normalizePem(backend.ssl_client_cert) : undefined;
  const certFingerprint = sha256Hex(desiredCert).slice(0, 12);
  const action: FastlyMtlsAction =
    existingCert === undefined ? "configure" : existingCert === desiredCert ? "noop" : "update";
  const summary =
    action === "noop"
      ? `Fastly service ${input.serviceId} (v${activeVersion}) backend "${input.backendName}" already uses client certificate ${certFingerprint}.`
      : action === "configure"
        ? `Clone Fastly service ${input.serviceId} v${activeVersion}, configure mTLS client certificate ${certFingerprint} on backend "${input.backendName}", and activate.`
        : `Clone Fastly service ${input.serviceId} v${activeVersion}, rotate mTLS client certificate to ${certFingerprint} on backend "${input.backendName}", and activate.`;
  const hash = sha256Hex(
    canonicalJson({
      op: "fastly-origin-mtls",
      serviceId: input.serviceId,
      activeVersion,
      backendName: input.backendName,
      action,
      certFingerprint,
    }),
  );
  return {
    action,
    serviceId: input.serviceId,
    activeVersion,
    backendName: input.backendName,
    certFingerprint,
    summary,
    hash,
  };
}

/**
 * Applies a previously planned Fastly backend mTLS update after verifying `approvedHash` matches
 * `plan.hash` (constitution I): clones active version, updates backend, and activates it.
 */
export async function applyFastlyOriginMtls(
  client: Pick<FastlyClient, "cloneVersion" | "updateBackendMtls" | "activateVersion">,
  plan: FastlyOriginMtlsPlan,
  input: {
    clientCertPem: string;
    clientKeyPem: string;
    approvedHash: string;
  },
): Promise<{ applied: boolean; activatedVersion?: number }> {
  assertClientKeyPair(input.clientCertPem, input.clientKeyPem);
  if (input.approvedHash.toLowerCase() !== plan.hash.toLowerCase()) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Approval hash mismatch for Fastly service ${plan.serviceId} backend mTLS update. Nothing was changed.`,
      { hint: "Re-run the command to generate a fresh plan and approve its hash." },
    );
  }
  const actualFingerprint = sha256Hex(normalizePem(input.clientCertPem)).slice(0, 12);
  if (actualFingerprint !== plan.certFingerprint) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The origin mTLS client certificate changed after the Fastly plan was hashed. Nothing was changed.",
      { hint: "Re-run the command so the approval hash matches the current certificate." },
    );
  }
  if (plan.action === "noop") return { applied: false };
  const nextVersion = await client.cloneVersion(plan.serviceId, plan.activeVersion);
  await client.updateBackendMtls({
    serviceId: plan.serviceId,
    version: nextVersion,
    backendName: plan.backendName,
    clientCertPem: normalizePem(input.clientCertPem),
    clientKeyPem: normalizePem(input.clientKeyPem),
  });
  await client.activateVersion(plan.serviceId, nextVersion);
  return { applied: true, activatedVersion: nextVersion };
}
