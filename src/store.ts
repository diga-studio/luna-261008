import { Clock, Component, Edit, Lease } from "./types";

export class ComponentStore {
  constructor(_clock?: Clock) {}

  checkout(_actor: string, _id: string): Lease {
    throw new Error("not implemented");
  }

  save(_actor: string, _edits: Edit[], _leases: Lease[]): void {
    throw new Error("not implemented");
  }

  read(): Component[] {
    throw new Error("not implemented");
  }
}
