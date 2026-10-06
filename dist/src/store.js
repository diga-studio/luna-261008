"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComponentStore = exports.LEASE_TTL_MS = void 0;
const clock_1 = require("./clock");
exports.LEASE_TTL_MS = 10 * 60 * 1000;
function copyGraph(source) {
    const copy = new Map();
    for (const [id, deps] of source) {
        copy.set(id, [...deps]);
    }
    return copy;
}
function findCycle(graph) {
    const state = new Map();
    const stack = [];
    const visit = (id) => {
        state.set(id, "visiting");
        stack.push(id);
        for (const dep of graph.get(id) ?? []) {
            if (state.get(dep) === "visiting") {
                return [...stack.slice(stack.indexOf(dep)), dep];
            }
            if (!state.has(dep)) {
                const cycle = visit(dep);
                if (cycle)
                    return cycle;
            }
        }
        stack.pop();
        state.set(id, "done");
        return null;
    };
    for (const id of graph.keys()) {
        if (!state.has(id)) {
            const cycle = visit(id);
            if (cycle)
                return cycle;
        }
    }
    return null;
}
class ComponentStore {
    constructor(clock = new clock_1.SystemClock()) {
        this.components = new Map();
        this.leases = new Map();
        this.tokenSeq = 0;
        this.clock = clock;
    }
    checkout(actor, id) {
        const now = this.clock.now();
        const current = this.leases.get(id);
        if (current && current.expiresAt > now && current.actor !== actor) {
            return { ok: false, reason: "locked", holder: current.actor };
        }
        const record = {
            actor,
            token: `lease-${++this.tokenSeq}`,
            expiresAt: now + exports.LEASE_TTL_MS,
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
    save(actor, edits, leases) {
        const now = this.clock.now();
        const modifiedIds = [...new Set(edits.map((edit) => edit.id))];
        const validRecords = new Map();
        for (const id of modifiedIds) {
            const record = this.leases.get(id);
            const presented = leases.find((lease) => lease.id === id && lease.actor === actor);
            if (!record ||
                !presented ||
                presented.token !== record.token ||
                record.expiresAt <= now) {
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
                record.expiresAt = now + exports.LEASE_TTL_MS;
            }
        }
        return { ok: true };
    }
    read() {
        const snapshot = new Map();
        for (const [id, deps] of this.components) {
            snapshot.set(id, { id, dependsOn: [...deps] });
        }
        return snapshot;
    }
}
exports.ComponentStore = ComponentStore;
