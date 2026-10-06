import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/index.js";
export function freshLedger() {
    const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
    const dbPath = join(dir, "ledger.db");
    const ledger = new Ledger(dbPath);
    return {
        ledger,
        dbPath,
        dir,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}
