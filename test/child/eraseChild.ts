// Child process: populate the store, then erase the victim.
// Killed mid-erase via EES_CRASH_AFTER_STEP (see src/crashHook.ts).
import { EvidenceStore } from "../../src/index.js";

const [dir, victim, other, victimNote, otherNote] = process.argv.slice(2);
if (!dir || !victim || !other || !victimNote || !otherNote) {
  throw new Error("usage: eraseChild <dir> <victim> <other> <victimNote> <otherNote>");
}

const store = new EvidenceStore({ dir });
store.ingest(victim, [
  { timestamp: "2026-01-05T09:00:00Z", eventType: "login", metadata: { note: victimNote } },
  { timestamp: "2026-01-06T09:00:00Z", eventType: "export", metadata: { note: victimNote } },
]);
store.ingest(other, [
  { timestamp: "2026-02-01T00:00:00Z", eventType: "login", metadata: { note: otherNote } },
]);
store.ingest(victim, [
  { timestamp: "2026-01-07T09:00:00Z", eventType: "login", metadata: { note: victimNote } },
]);
store.eraseEmployee(victim);
console.log("ERASE_COMPLETED_NORMALLY");
