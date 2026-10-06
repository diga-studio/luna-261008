// Child process: reopen the store on an existing dir (runs crash recovery
// in the constructor), then print a JSON verification report.
import { EvidenceStore } from "../../src/index.js";
import { dirContainsPlaintext, listFiles } from "../helpers.js";

const [dir, victim, other, victimNote, otherNote] = process.argv.slice(2);
if (!dir || !victim || !other || !victimNote || !otherNote) {
  throw new Error("usage: verifyChild <dir> <victim> <other> <victimNote> <otherNote>");
}

const store = new EvidenceStore({ dir });

const victimRead = store.readEmployee(victim);
let ingestRejected = false;
try {
  store.ingest(victim, [
    { timestamp: "2026-03-01T00:00:00Z", eventType: "login", metadata: { note: "post-erase" } },
  ]);
} catch {
  ingestRejected = true;
}
// Repeated erase must not add a second erase-complete audit item.
store.eraseEmployee(victim);

const report = store.inspectAudit();
const otherRead = store.readEmployee(other);

const result = {
  victimRead,
  ingestRejected,
  eraseItemCount: report.items.filter((i) => i.type === "erase" && i.employeeId === victim).length,
  integrityOk: report.integrityOk,
  integrityError: report.integrityError,
  victimPayloads: report.items.filter((i) => i.employeeId === victim).map((i) => i.payload),
  otherEventCount: otherRead.events.length,
  otherSummaries: otherRead.summaries,
  files: listFiles(dir),
  victimPlaintextFound: dirContainsPlaintext(dir, victimNote),
  otherPlaintextFound: dirContainsPlaintext(dir, otherNote),
};
console.log("RESULT:" + JSON.stringify(result));
