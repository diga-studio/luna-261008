/** Lifecycle state of a tunnel. Only Active counts as up. */
export type TunnelLifecycleState = string;

/** Interface availability state. */
export enum InterfaceStatus {
  Up = "Up",
  Down = "Down",
}

/** The kind of object a status record refers to. */
export enum ObjectKind {
  Tunnel = "Tunnel",
  Interface = "Interface",
}

/** A single status change record supplied by the caller. */
export interface StatusRecord {
  /** Globally unique record id. Same id => same content, applied once. */
  recordId: string;
  /** Object the record refers to (tunnel id or interface id). */
  objectId: string;
  objectKind: ObjectKind;
  /** Business time in integer milliseconds. */
  timestampMs: number;
  /** Per-object monotonic sequence; highest seq wins within the same ms. */
  seq: number;
  /** New state: InterfaceStatus for interfaces, lifecycle string for tunnels. */
  state: string;
}

/** A tunnel connecting two sites, bound to one interface on each end. */
export interface TunnelDefinition {
  tunnelId: string;
  siteA: string;
  siteB: string;
  interfaceA: string;
  interfaceB: string;
}

/** Availability report for a site pair over [windowStartMs, windowEndMs). */
export interface AvailabilityReport {
  siteA: string;
  siteB: string;
  windowStartMs: number;
  windowEndMs: number;
  /** Total milliseconds the site pair was connectable inside the window. */
  connectedMs: number;
  /** connectedMs / (windowEndMs - windowStartMs). */
  availability: number;
}
