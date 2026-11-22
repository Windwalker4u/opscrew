/**
 * The cloud server providers as the tools' texts name them, from the registry (ADR 0029), so a
 * provider added there is listed everywhere.
 */
import { CLOUD_PROVIDERS } from "@opscrew/providers";

/** The cloud providers' ids, in the registry's order. */
export const CLOUD_IDS = CLOUD_PROVIDERS.map((provider) => provider.id);
