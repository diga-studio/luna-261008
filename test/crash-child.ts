/**
 * Subprocess helper: seeds two employees, then starts erasing one and
 * SIGKILLs itself at the erase persistence boundary named by argv[4].
 * A real process kill (not an exception) simulates forced termination.
 */
import { EvidenceStore } from "../src/store";

const [dir, target, killStep] = process.argv.slice(2);

const store = EvidenceStore.open(dir, {
  onEraseBoundary: (step) => {
    if (step === killStep) {
      process.kill(process.pid, "SIGKILL");
    }
  },
});

store.ingest("emp-target", [
  { timestamp: "2026-01-05T09:00:00.000Z", eventType: "login", metadata: { ip: "10.0.0.1" } },
  { timestamp: "2026-01-05T17:30:00.000Z", eventType: "logout", metadata: {} },
]);
store.ingest("emp-target", [
  { timestamp: "2026-01-06T10:00:00.000Z", eventType: "login", metadata: { device: "laptop" } },
]);
store.ingest("emp-other", [
  { timestamp: "2026-01-05T12:00:00.000Z", eventType: "login", metadata: { note: "keep me" } },
]);

store.eraseEmployee(target);
console.log("erase completed without kill");
