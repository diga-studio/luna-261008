import type { Clock } from "./clock";
import { SystemClock } from "./clock";
import type {
  ActorId,
  CheckoutResult,
  Component,
  ComponentId,
  Edit,
  Lease,
  SaveResult,
} from "./types";

export const LEASE_TTL_MS = 10 * 60 * 1000;

interface LeaseRecord {
  actor: ActorId;
  token: string;
  expiresAt: number;
}

function copyGraph(
  source: Map<ComponentId, ComponentId[]>,
): Map<ComponentId, ComponentId[]> {
  const copy = new Map<ComponentId, ComponentId[]>();
  for (const [id, deps] of source) {
    copy.set(id, [...deps]);
  }
  return copy;
}

function findCycle(graph: Map<ComponentId, ComponentId[]>): ComponentId[] | null {
  const state = new Map<ComponentId, "visiting" | "done">();
  const stack: ComponentId[] = [];

  const visit = (id: ComponentId): ComponentId[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (state.get(dep) === "visiting") {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (!state.has(dep)) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of graph.keys()) {
    if (!state.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export class ComponentStore {
  private readonly clock: Clock;
  private readonly components = new Map<ComponentId, ComponentId[]>();
  private readonly leases = new Map<ComponentId, LeaseRecord>();
  private tokenSeq = 0;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  checkout(actor: ActorId, id: ComponentId): CheckoutResult {
    const now = this.clock.now();
    const current = this.leases.get(id);
    if (current && current.expiresAt > now && current.actor !== actor) {
      return { ok: false, reason: "locked", holder: current.actor };
    }
    const record: LeaseRecord = {
      actor,
      token: `lease-${++this.tokenSeq}`,
      expiresAt: now + LEASE_TTL_MS,
    };
    this.leases.set(id, record);
    return {
      ok: true,
      lease: {
        id,
        actor: record.actor,
        token: record.token,
        expiresAt: record.expiresAt,
      },
    };
  }

  save(actor: ActorId, edits: Edit[], leases: Lease[]): SaveResult {
    const now = this.clock.now();
    const modifiedIds = [...new Set(edits.map((edit) => edit.id))];

    const validRecords = new Map<ComponentId, LeaseRecord>();
    for (const id of modifiedIds) {
      const record = this.leases.get(id);
      const presented = leases.find(
        (lease) => lease.id === id && lease.actor === actor,
      );
      if (
        !record ||
        !presented ||
        presented.token !== record.token ||
        record.expiresAt <= now
      ) {
        return { ok: false, error: { code: "no-valid-lease", id } };
      }
      validRecords.set(id, record);
    }

    const next = copyGraph(this.components);
    for (const edit of edits) {
      switch (edit.kind) {
        case "create":
          if (next.has(edit.id)) {
            return {
              ok: false,
              error: { code: "already-exists", id: edit.id },
            };
          }
          next.set(edit.id, [...(edit.dependsOn ?? [])]);
          break;
        case "setDependsOn": {
          const deps = next.get(edit.id);
          if (!deps) {
            return {
              ok: false,
              error: { code: "unknown-component", id: edit.id },
            };
          }
          next.set(edit.id, [...edit.dependsOn]);
          break;
        }
        case "delete":
          next.delete(edit.id);
          break;
      }
    }

    for (const [id, deps] of next) {
      for (const dep of deps) {
        if (!next.has(dep)) {
          return {
            ok: false,
            error: { code: "dangling-reference", id, missing: dep },
          };
        }
      }
    }

    const cycle = findCycle(next);
    if (cycle) {
      return { ok: false, error: { code: "cycle", path: cycle } };
    }

    this.components.clear();
    for (const [id, deps] of next) {
      this.components.set(id, deps);
    }
    for (const id of modifiedIds) {
      if (!next.has(id)) {
        this.leases.delete(id);
        continue;
      }
      const record = validRecords.get(id);
      if (record && this.leases.get(id) === record) {
        record.expiresAt = now + LEASE_TTL_MS;
      }
    }
    return { ok: true };
  }

  read(): Map<ComponentId, Component> {
    const snapshot = new Map<ComponentId, Component>();
    for (const [id, deps] of this.components) {
      snapshot.set(id, { id, dependsOn: [...deps] });
    }
    return snapshot;
  }
}
