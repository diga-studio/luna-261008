import test from "node:test";
import assert from "node:assert/strict";
import { ResourceLedger } from "../src/ledger";
import type { Item, ResourceHandle } from "../src/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Harness {
  prepares: { item: Item; gate: Deferred<ResourceHandle> }[] = [];
  destroys: { handle: ResourceHandle; gate: Deferred<void> }[] = [];
  ledger: ResourceLedger;

  constructor(capacities: Record<string, { cpuMillicores: number; memoryMiB: number }>) {
    this.ledger = new ResourceLedger(
      capacities,
      (item) => {
        const gate = deferred<ResourceHandle>();
        this.prepares.push({ item, gate });
        return gate.promise;
      },
      (handle) => {
        const gate = deferred<void>();
        this.destroys.push({ handle, gate });
        return gate.promise;
      },
    );
  }

  used(node: string) {
    const n = this.ledger.inspect().nodes.find((x) => x.node === node);
    assert.ok(n, `node ${node} exists`);
    return n.used;
  }

  batchState(key: string) {
    return this.ledger.inspect().batches.find((b) => b.key === key)?.state;
  }
}

const tick = () => new Promise<void>((res) => setTimeout(res, 0));

test("insufficient memory rejects the whole batch without calling prepare", async () => {
  const h = new Harness({ n1: { cpuMillicores: 8000, memoryMiB: 1024 } });
  const items: Item[] = [
    { node: "n1", usage: { cpuMillicores: 500, memoryMiB: 512 } },
    { node: "n1", usage: { cpuMillicores: 500, memoryMiB: 600 } },
  ];
  const result = await h.ledger.deploy("k1", items);
  assert.deepEqual(result, { ok: false, reason: "insufficient-capacity" });
  assert.equal(h.prepares.length, 0);
  assert.deepEqual(h.used("n1"), { cpuMillicores: 0, memoryMiB: 0 });
  assert.equal(h.batchState("k1"), "failed");
});

test("one failure + one late success + hanging destroy: quota held, released exactly once", async () => {
  const h = new Harness({ n1: { cpuMillicores: 1000, memoryMiB: 1000 } });
  const items: Item[] = [
    { node: "n1", usage: { cpuMillicores: 400, memoryMiB: 400 } },
    { node: "n1", usage: { cpuMillicores: 600, memoryMiB: 600 } },
  ];
  const deployPromise = h.ledger.deploy("k1", items);
  assert.equal(h.prepares.length, 2);
  assert.deepEqual(h.used("n1"), { cpuMillicores: 1000, memoryMiB: 1000 });

  // First item fails: its quota is returned, the rest is retained.
  h.prepares[0]!.gate.reject(new Error("boom"));
  await tick();
  assert.equal(h.batchState("k1"), "compensating");
  assert.deepEqual(h.used("n1"), { cpuMillicores: 600, memoryMiB: 600 });

  // While compensation is stuck, a new batch cannot use the retained quota.
  const blocked = await h.ledger.deploy("k2", [
    { node: "n1", usage: { cpuMillicores: 500, memoryMiB: 500 } },
  ]);
  assert.deepEqual(blocked, { ok: false, reason: "insufficient-capacity" });

  // Late success of the second item must be destroyed, not revived.
  h.prepares[1]!.gate.resolve("handle-2");
  await tick();
  assert.equal(h.destroys.length, 1);
  assert.equal(h.destroys[0]!.handle, "handle-2");
  // Destroy hangs: quota still held, batch still compensating.
  assert.deepEqual(h.used("n1"), { cpuMillicores: 600, memoryMiB: 600 });
  assert.equal(h.batchState("k1"), "compensating");

  // Destroy confirms: quota released exactly once, deploy fails.
  h.destroys[0]!.gate.resolve();
  const result = await deployPromise;
  assert.deepEqual(result, { ok: false, reason: "prepare-failed" });
  assert.deepEqual(h.used("n1"), { cpuMillicores: 0, memoryMiB: 0 });
  assert.equal(h.batchState("k1"), "failed");

  // Now the quota is available again.
  const retry = h.ledger.deploy("k3", [
    { node: "n1", usage: { cpuMillicores: 1000, memoryMiB: 1000 } },
  ]);
  await tick();
  assert.equal(h.prepares.length, 3);
  h.prepares[2]!.gate.resolve("handle-3");
  assert.deepEqual(await retry, { ok: true });
});

test("successful deploy becomes running and occupies quota", async () => {
  const h = new Harness({
    n1: { cpuMillicores: 2000, memoryMiB: 2048 },
    n2: { cpuMillicores: 1000, memoryMiB: 1024 },
  });
  const p = h.ledger.deploy("k1", [
    { node: "n1", usage: { cpuMillicores: 1000, memoryMiB: 1024 } },
    { node: "n2", usage: { cpuMillicores: 500, memoryMiB: 512 } },
  ]);
  assert.equal(h.batchState("k1"), "creating");
  h.prepares[0]!.gate.resolve("a");
  await tick();
  assert.equal(h.batchState("k1"), "creating");
  h.prepares[1]!.gate.resolve("b");
  assert.deepEqual(await p, { ok: true });
  assert.equal(h.batchState("k1"), "running");
  assert.deepEqual(h.used("n1"), { cpuMillicores: 1000, memoryMiB: 1024 });
  assert.deepEqual(h.used("n2"), { cpuMillicores: 500, memoryMiB: 512 });
});

test("cancel a running batch destroys everything and releases quota", async () => {
  const h = new Harness({ n1: { cpuMillicores: 1000, memoryMiB: 1000 } });
  const p = h.ledger.deploy("k1", [
    { node: "n1", usage: { cpuMillicores: 400, memoryMiB: 400 } },
  ]);
  h.prepares[0]!.gate.resolve("h1");
  assert.deepEqual(await p, { ok: true });

  const cancelPromise = h.ledger.cancel("k1");
  await tick();
  assert.equal(h.batchState("k1"), "destroying");
  assert.deepEqual(h.used("n1"), { cpuMillicores: 400, memoryMiB: 400 });
  assert.equal(h.destroys.length, 1);
  h.destroys[0]!.gate.resolve();
  await cancelPromise;
  assert.equal(h.batchState("k1"), "cancelled");
  assert.deepEqual(h.used("n1"), { cpuMillicores: 0, memoryMiB: 0 });

  // Repeated cancel is a no-op.
  await h.ledger.cancel("k1");
  await h.ledger.cancel("missing-key");
  assert.equal(h.destroys.length, 1);
});

test("cancel during creating ends deploy as cancelled; late success is destroyed", async () => {
  const h = new Harness({ n1: { cpuMillicores: 1000, memoryMiB: 1000 } });
  const p = h.ledger.deploy("k1", [
    { node: "n1", usage: { cpuMillicores: 400, memoryMiB: 400 } },
    { node: "n1", usage: { cpuMillicores: 400, memoryMiB: 400 } },
  ]);
  const cancelPromise = h.ledger.cancel("k1");
  await tick();
  assert.equal(h.batchState("k1"), "destroying");

  // Late success must be destroyed, not revive the batch.
  h.prepares[0]!.gate.resolve("h1");
  await tick();
  assert.equal(h.destroys.length, 1);
  // Late failure just releases its quota.
  h.prepares[1]!.gate.reject(new Error("late failure"));
  await tick();
  assert.deepEqual(h.used("n1"), { cpuMillicores: 400, memoryMiB: 400 });

  h.destroys[0]!.gate.resolve();
  await cancelPromise;
  assert.deepEqual(await p, { ok: false, reason: "cancelled" });
  assert.equal(h.batchState("k1"), "cancelled");
  assert.deepEqual(h.used("n1"), { cpuMillicores: 0, memoryMiB: 0 });
});

test("same key + same content shares the first result; different content conflicts", async () => {
  const h = new Harness({ n1: { cpuMillicores: 1000, memoryMiB: 1000 } });
  const items: Item[] = [{ node: "n1", usage: { cpuMillicores: 100, memoryMiB: 100 } }];

  // In-flight retry shares the first deploy.
  const p1 = h.ledger.deploy("k1", items);
  const p2 = h.ledger.deploy("k1", items);
  assert.equal(h.prepares.length, 1);
  h.prepares[0]!.gate.resolve("h1");
  assert.deepEqual(await p1, { ok: true });
  assert.deepEqual(await p2, { ok: true });

  // After cancel, retrying still returns the original result and never re-creates.
  const c = h.ledger.cancel("k1");
  h.destroys[0]!.gate.resolve();
  await c;
  assert.deepEqual(await h.ledger.deploy("k1", items), { ok: true });
  assert.equal(h.prepares.length, 1);

  // Different content under the same key conflicts and does not touch the batch.
  const conflict = await h.ledger.deploy("k1", [
    { node: "n1", usage: { cpuMillicores: 200, memoryMiB: 100 } },
  ]);
  assert.deepEqual(conflict, { ok: false, reason: "conflict" });
  assert.equal(h.prepares.length, 1);
  assert.equal(h.batchState("k1"), "cancelled");
});

test("capacity rejection is remembered and shared for the same key", async () => {
  const h = new Harness({ n1: { cpuMillicores: 100, memoryMiB: 100 } });
  const items: Item[] = [{ node: "n1", usage: { cpuMillicores: 500, memoryMiB: 500 } }];
  const r1 = await h.ledger.deploy("k1", items);
  const r2 = await h.ledger.deploy("k1", items);
  assert.deepEqual(r1, { ok: false, reason: "insufficient-capacity" });
  assert.deepEqual(r2, { ok: false, reason: "insufficient-capacity" });
  assert.equal(h.prepares.length, 0);
});

test("failure already decided: cancel does not rewrite the deploy result", async () => {
  const h = new Harness({ n1: { cpuMillicores: 1000, memoryMiB: 1000 } });
  const p = h.ledger.deploy("k1", [
    { node: "n1", usage: { cpuMillicores: 300, memoryMiB: 300 } },
    { node: "n1", usage: { cpuMillicores: 300, memoryMiB: 300 } },
  ]);
  h.prepares[0]!.gate.reject(new Error("boom"));
  await tick();
  assert.equal(h.batchState("k1"), "compensating");

  const cancelPromise = h.ledger.cancel("k1");
  h.prepares[1]!.gate.resolve("h2");
  await tick();
  assert.equal(h.destroys.length, 1);
  h.destroys[0]!.gate.resolve();
  await cancelPromise;
  assert.deepEqual(await p, { ok: false, reason: "prepare-failed" });
  assert.equal(h.batchState("k1"), "failed");
});
