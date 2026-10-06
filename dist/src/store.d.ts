import type { Clock } from "./clock";
import type { ActorId, CheckoutResult, Component, ComponentId, Edit, Lease, SaveResult } from "./types";
export declare const LEASE_TTL_MS: number;
export declare class ComponentStore {
    private readonly clock;
    private readonly components;
    private readonly leases;
    private tokenSeq;
    constructor(clock?: Clock);
    checkout(actor: ActorId, id: ComponentId): CheckoutResult;
    save(actor: ActorId, edits: Edit[], leases: Lease[]): SaveResult;
    read(): Map<ComponentId, Component>;
}
