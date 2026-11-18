import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * A new folder named `prefix` plus random characters in the temp folder (the test run's own),
 * removed after the current test. Windows can keep a file in it open a moment longer: the removal
 * retries, and a folder still busy (`EBUSY`) is left to the run's global teardown, which removes
 * the whole run folder. Call it inside a test.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(async () => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  });
  return dir;
}
