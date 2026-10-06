/**
 * Child process for crash-recovery tests. Not a test file itself.
 * Env:
 *   LEDGER_DIR        ledger directory (required)
 *   APPEND_COUNT      append this many pattern records first (default 0)
 *   DO_ARCHIVE        "1" to run archive(CHILD_CUTOFF)
 *   CRASH_POINT       CrashPoint at which to SIGKILL self inside archive()
 *   KILL_AFTER_APPEND SIGKILL self right after the Nth append commit
 */
import { AuditLedger } from "../src/index.js";
import { CHILD_CUTOFF, childBody, childTime } from "./crashPattern.js";

const dir = process.env["LEDGER_DIR"];
if (!dir) {
  throw new Error("LEDGER_DIR is required");
}
const crashPoint = process.env["CRASH_POINT"];
const killAfterAppend = Number(process.env["KILL_AFTER_APPEND"] ?? "0");
const appendCount = Number(process.env["APPEND_COUNT"] ?? "0");
const doArchive = process.env["DO_ARCHIVE"] === "1";

const ledger = AuditLedger.open({
  dir,
  crashHook: (point) => {
    if (point === crashPoint) {
      process.kill(process.pid, "SIGKILL");
    }
  },
});

for (let i = 0; i < appendCount; i++) {
  ledger.append(childTime(i), childBody(i));
  if (killAfterAppend > 0 && i + 1 === killAfterAppend) {
    process.kill(process.pid, "SIGKILL");
  }
}

if (doArchive) {
  ledger.archive(CHILD_CUTOFF);
}

ledger.close();
