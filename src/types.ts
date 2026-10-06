export type ComponentId = string;
export type ActorId = string;

export interface Component {
  id: ComponentId;
  dependsOn: ComponentId[];
}

export type Edit =
  | { kind: "create"; id: ComponentId; dependsOn?: ComponentId[] }
  | { kind: "setDependsOn"; id: ComponentId; dependsOn: ComponentId[] }
  | { kind: "delete"; id: ComponentId };

export interface Lease {
  id: ComponentId;
  actor: ActorId;
  token: string;
  expiresAt: number;
}

export type CheckoutResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "locked"; holder: ActorId };

export type SaveError =
  | { code: "no-valid-lease"; id: ComponentId }
  | { code: "already-exists"; id: ComponentId }
  | { code: "unknown-component"; id: ComponentId }
  | { code: "dangling-reference"; id: ComponentId; missing: ComponentId }
  | { code: "cycle"; path: ComponentId[] };

export type SaveResult = { ok: true } | { ok: false; error: SaveError };
