/**
 * The uptime Worker's texts and thresholds are copies of the scheduled check's (the Worker's
 * script has no imports): each one is compared with check.mjs's, as ssh-host compares
 * `UPTIME_REPORT_READ` with `CHECK_KEY_COMMAND`.
 */
import { expect, it } from "vitest";
import * as check from "../../check/check.mjs";
import * as worker from "../../uptime/worker.mjs";
import { CHECK_THRESHOLDS } from "../check";

it("the Worker's drill failures, hints, credential dates and thresholds are check.mjs's", () => {
  expect(worker.DRILL_FAILURES).toEqual(check.DRILL_FAILURES);
  expect(worker.HINTS).toEqual({
    disk: check.DISK_HINT,
    snapshot: check.SNAPSHOT_HINT,
    drill: check.DRILL_HINT,
    certificate: check.CERTIFICATE_HINT,
  });
  expect(worker.CREDENTIAL_DATES).toEqual(check.CREDENTIAL_DATES);
  expect({
    diskWarn: worker.DISK_WARN,
    diskHigh: worker.DISK_HIGH,
    certDays: worker.CERT_DAYS,
  }).toEqual({
    diskWarn: CHECK_THRESHOLDS.diskWarn,
    diskHigh: CHECK_THRESHOLDS.diskHigh,
    certDays: CHECK_THRESHOLDS.certDays,
  });
});
