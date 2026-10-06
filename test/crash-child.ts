/**
 * Child-process driver for crash tests. Deterministic record content so the
 * parent can reconstruct the original ledger without reading the child's state.
 *
 * Env:
 *   CRASH_DIR     archive directory
 *   CRASH_ACTION  "append" | "archive"
 *   CRASH_COUNT   number of records to append (append action)
 *   CRASH_CUTOFF  cutoff ms (archive action)
 *   CRASH_HOOK    "none" | "afterSegmentSealed" | "afterCommit"
 */
import { AuditArchive } from "../src/index.ts";
import type { ArchiveHooks } from "../src/index.ts";
import { childBody, childEventTime } from "./crash-fixture.ts";

const dir = process.env.CRASH_DIR!;
const action = process.env.CRASH_ACTION!;
const hookName = process.env.CRASH_HOOK ?? "none";

const hooks: ArchiveHooks = {};
if (hookName !== "none") {
  const boom = () => {
    process.exit(1);
  };
  if (hookName === "afterSegmentSealed") hooks.afterSegmentSealed = boom;
  else if (hookName === "afterCommit") hooks.afterCommit = boom;
  else throw new Error(`unknown hook ${hookName}`);
}

const archive = AuditArchive.open({ dir, hooks });

if (action === "append") {
  const count = Number(process.env.CRASH_COUNT);
  for (let i = 0; i < count; i++) {
    archive.append(childEventTime(i), childBody(i));
  }
  archive.close();
} else if (action === "archive") {
  const cutoff = Number(process.env.CRASH_CUTOFF);
  const result = archive.archive(cutoff);
  archive.close();
  console.log(JSON.stringify(result));
} else {
  throw new Error(`unknown action ${action}`);
}
