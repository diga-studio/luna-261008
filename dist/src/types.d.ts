export declare type ComponentId = string;
export declare type ActorId = string;
export interface Component {
    id: ComponentId;
    dependsOn: ComponentId[];
}
export declare type Edit = {
    kind: "create";
    id: ComponentId;
    dependsOn?: ComponentId[];
} | {
    kind: "setDependsOn";
    id: ComponentId;
    dependsOn: ComponentId[];
} | {
    kind: "delete";
    id: ComponentId;
};
export interface Lease {
    id: ComponentId;
    actor: ActorId;
    token: string;
    expiresAt: number;
}
export declare type CheckoutResult = {
    ok: true;
    lease: Lease;
} | {
    ok: false;
    reason: "locked";
    holder: ActorId;
};
export declare type SaveError = {
    code: "no-valid-lease";
    id: ComponentId;
} | {
    code: "already-exists";
    id: ComponentId;
} | {
    code: "unknown-component";
    id: ComponentId;
} | {
    code: "dangling-reference";
    id: ComponentId;
    missing: ComponentId;
} | {
    code: "cycle";
    path: ComponentId[];
};
export declare type SaveResult = {
    ok: true;
} | {
    ok: false;
    error: SaveError;
};
