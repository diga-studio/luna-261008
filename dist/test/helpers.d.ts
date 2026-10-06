import { Ledger } from "../src/index.js";
export interface TestLedger {
    ledger: Ledger;
    dbPath: string;
    dir: string;
    cleanup: () => void;
}
export declare function freshLedger(): TestLedger;
