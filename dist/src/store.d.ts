import { Clock, Component, Edit, Lease } from "./types";
export declare class ComponentStore {
    constructor(_clock?: Clock);
    checkout(_actor: string, _id: string): Lease;
    save(_actor: string, _edits: Edit[], _leases: Lease[]): void;
    read(): Component[];
}
