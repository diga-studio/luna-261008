import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  DeployResult,
  Handle,
  Item,
  ResourceLedger,
} from "../src/ledger";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await tick();
  }
}

interface PrepareCall {
  item: Item;
  gate: Deferred<Handle>;
}

function makeHarness(capacities: Record<string, { cpu: number; memory: number }>) {
  const prepareCalls: PrepareCall[] = [];
  const destroyCalls: Handle[] = [];
  const destroyGates = new Map<Handle, Deferred<void>>();
  let nextHandle = 0;
  const harness = {
    hangDestroy: false,
  };
  const ledger = new ResourceLedger(capacities, {
    prepare: (item) => {
      const gate = deferred<Handle>();
      prepareCalls.push({ item, gate });
      return gate.promise;
    },
    destroy: (handle) => {
      destroyCalls.push(handle);
      if (!harness.hangDestroy) {
        return Promise.resolve();
      }
      const gate = deferred<void>();
      destroyGates.set(handle, gate);
      return gate.promise;
    },
  });
  return {
    ledger,
    prepareCalls,
    destroyCalls,
    destroyGates,
    harness,
    allocHandle: () => `handle-${(nextHandle += 1)}`,
  };
}

test("CPU sufficient but memory insufficient: batch rejected, prepare not called", async () => {
  const { ledger, prepareCalls } = makeHarness({
    n1: { cpu: 4000, memory: 1024 },
  });
  const items: Item[] = [
    { node: "n1", cpu: 1000, memory: 800 },
    { node: "n1", cpu: 1000, memory: 800 },
  ];
  const result = await ledger.deploy("k1", items);
  assert.deepEqual(result, { ok: false, reason: "capacity-exceeded" });
  assert.equal(prepareCalls.length, 0);
  assert.deepEqual(ledger.inspect().nodes["n1"].used, { cpu: 0, memory: 0 });

  // Retry with the same key and content shares the rejection.
  const retry = await ledger.deploy("k1", items);
  assert.deepEqual(retry, { ok: false, reason: "capacity-exceeded" });
  assert.equal(prepareCalls.length, 0);
});

test("one item fails, another succeeds late, destroy hangs; quota held then released exactly once", async () => {
  const { ledger, prepareCalls, destroyCalls, destroyGates, allocHandle, harness } =
    makeHarness({ n1: { cpu: 1500, memory: 1536 } });
  harness.hangDestroy = true;
  const items: Item[] = [
    { node: "n1", cpu: 1000, memory: 1024 },
    { node: "n1", cpu: 500, memory: 512 },
  ];
  const deployPromise = ledger.deploy("k1", items);
  await flush();
  assert.equal(prepareCalls.length, 2);
  assert.deepEqual(ledger.inspect().nodes["n1"].used, {
    cpu: 1500,
    memory: 1536,
  });

  // First item fails: its quota is returned immediately.
  prepareCalls[0].gate.reject(new Error("boom"));
  await flush();
  assert.deepEqual(ledger.inspect().nodes["n1"].used, {
    cpu: 500,
    memory: 512,
  });
  assert.equal(ledger.inspect().batches["k1"].state, "compensating");

  // While the second item still holds quota, a new batch cannot use it.
  const blocked = await ledger.deploy("k2", [
    { node: "n1", cpu: 1001, memory: 1024 },
  ]);
  assert.deepEqual(blocked, { ok: false, reason: "capacity-exceeded" });
  assert.equal(prepareCalls.length, 2);

  // The freed quota of the failed item is usable.
  const k3 = ledger.deploy("k3", [{ node: "n1", cpu: 1000, memory: 1024 }]);
  await flush();
  assert.equal(prepareCalls.length, 3);

  // Late success of the second item: must be destroyed, destroy hangs.
  const lateHandle = allocHandle();
  prepareCalls[1].gate.resolve(lateHandle);
  await flush();
  assert.deepEqual(destroyCalls, [lateHandle]);
  assert.deepEqual(ledger.inspect().nodes["n1"].used, {
    cpu: 1500,
    memory: 1536,
  });
  assert.equal(ledger.inspect().batches["k1"].state, "compensating");

  // Still cannot use the quota held by the hanging destroy.
  const stillBlocked = await ledger.deploy("k4", [
    { node: "n1", cpu: 1, memory: 1 },
  ]);
  assert.deepEqual(stillBlocked, { ok: false, reason: "capacity-exceeded" });

  // Destroy confirms: quota returned exactly once, deploy resolves failed.
  destroyGates.get(lateHandle)!.resolve();
  await flush();
  assert.deepEqual(await deployPromise, {
    ok: false,
    reason: "prepare-failed",
  });
  assert.deepEqual(ledger.inspect().nodes["n1"].used, {
    cpu: 1000,
    memory: 1024,
  });
  assert.equal(ledger.inspect().batches["k1"].state, "failed");
  assert.equal(destroyCalls.length, 1);

  // Clean up k3.
  prepareCalls[2].gate.resolve(allocHandle());
  await flush();
  assert.deepEqual(await k3, { ok: true });
});

test("same key and content executes creation once and shares the result", async () => {
  const { ledger, prepareCalls, allocHandle } = makeHarness({
    n1: { cpu: 2000, memory: 2048 },
  });
  const items: Item[] = [{ node: "n1", cpu: 500, memory: 512 }];

  const first = ledger.deploy("k", items);
  const duringRetry = ledger.deploy("k", [
    { node: "n1", cpu: 500, memory: 512 },
  ]);
  await flush();
  assert.equal(prepareCalls.length, 1);

  prepareCalls[0].gate.resolve(allocHandle());
  const firstResult = await first;
  const retryResult = await duringRetry;
  assert.deepEqual(firstResult, { ok: true });
  assert.deepEqual(retryResult, { ok: true });

  // Retry after the batch reached a terminal-ish state and even after
  // cancellation: no new creation, original result preserved.
  await ledger.cancel("k");
  const afterCancel = await ledger.deploy("k", items);
  assert.deepEqual(afterCancel, { ok: true });
  assert.equal(prepareCalls.length, 1);
  assert.equal(ledger.inspect().batches["k"].state, "cancelled");
});

test("same key with different content conflicts without affecting the original", async () => {
  const { ledger, prepareCalls, allocHandle } = makeHarness({
    n1: { cpu: 2000, memory: 2048 },
  });
  const deployPromise = ledger.deploy("k", [
    { node: "n1", cpu: 500, memory: 512 },
  ]);
  assert.throws(() =>
    ledger.deploy("k", [{ node: "n1", cpu: 600, memory: 512 }]),
  );
  await flush();
  assert.equal(prepareCalls.length, 1);
  prepareCalls[0].gate.resolve(allocHandle());
  assert.deepEqual(await deployPromise, { ok: true });
});

test("cancel during creation ends deploy as cancelled and destroys late successes", async () => {
  const { ledger, prepareCalls, destroyCalls, destroyGates, allocHandle, harness } =
    makeHarness({ n1: { cpu: 2000, memory: 2048 } });
  harness.hangDestroy = true;
  const items: Item[] = [
    { node: "n1", cpu: 500, memory: 512 },
    { node: "n1", cpu: 500, memory: 512 },
  ];
  const deployPromise = ledger.deploy("k", items);
  await flush();
  assert.equal(ledger.inspect().batches["k"].state, "creating");

  const cancelPromise = ledger.cancel("k");
  await flush();
  assert.equal(ledger.inspect().batches["k"].state, "compensating");

  // One prepare succeeds late, the other fails.
  const late = allocHandle();
  prepareCalls[0].gate.resolve(late);
  prepareCalls[1].gate.reject(new Error("nope"));
  await flush();
  assert.deepEqual(destroyCalls, [late]);

  destroyGates.get(late)!.resolve();
  await flush();
  await cancelPromise;
  assert.deepEqual(await deployPromise, { ok: false, reason: "cancelled" });
  assert.deepEqual(ledger.inspect().nodes["n1"].used, { cpu: 0, memory: 0 });
  assert.equal(ledger.inspect().batches["k"].state, "cancelled");

  // Repeated cancel has no effect.
  await ledger.cancel("k");
  assert.equal(destroyCalls.length, 1);
});

test("cancel of a running batch destroys everything and keeps the deploy result", async () => {
  const { ledger, prepareCalls, destroyCalls, destroyGates, allocHandle, harness } =
    makeHarness({ n1: { cpu: 2000, memory: 2048 } });
  harness.hangDestroy = true;
  const items: Item[] = [
    { node: "n1", cpu: 500, memory: 512 },
    { node: "n1", cpu: 500, memory: 512 },
  ];
  const deployPromise = ledger.deploy("k", items);
  await flush();
  const handles = [allocHandle(), allocHandle()];
  prepareCalls[0].gate.resolve(handles[0]);
  prepareCalls[1].gate.resolve(handles[1]);
  assert.deepEqual(await deployPromise, { ok: true });
  assert.equal(ledger.inspect().batches["k"].state, "running");

  const cancelPromise = ledger.cancel("k");
  await flush();
  assert.equal(ledger.inspect().batches["k"].state, "compensating");
  assert.deepEqual(new Set(destroyCalls), new Set(handles));
  assert.deepEqual(ledger.inspect().nodes["n1"].used, {
    cpu: 1000,
    memory: 1024,
  });

  destroyGates.get(handles[0])!.resolve();
  destroyGates.get(handles[1])!.resolve();
  await cancelPromise;
  assert.deepEqual(ledger.inspect().nodes["n1"].used, { cpu: 0, memory: 0 });
  assert.equal(ledger.inspect().batches["k"].state, "cancelled");

  // The original successful result is not rewritten.
  assert.deepEqual(await deployPromise, { ok: true });
});

test("cancel of an unknown key is a no-op", async () => {
  const { ledger } = makeHarness({ n1: { cpu: 1000, memory: 1024 } });
  await ledger.cancel("missing");
  assert.deepEqual(ledger.inspect().batches, {});
});

test("deploy result type sanity", async () => {
  const { ledger, prepareCalls, allocHandle } = makeHarness({
    n1: { cpu: 1000, memory: 1024 },
  });
  const promise: Promise<DeployResult> = ledger.deploy("k", [
    { node: "n1", cpu: 100, memory: 100 },
  ]);
  await flush();
  prepareCalls[0].gate.resolve(allocHandle());
  const result = await promise;
  assert.ok(result.ok);
});

test("empty batch succeeds immediately", async () => {
  const { ledger, prepareCalls } = makeHarness({
    n1: { cpu: 1000, memory: 1024 },
  });
  assert.deepEqual(await ledger.deploy("empty", []), { ok: true });
  assert.equal(prepareCalls.length, 0);
  assert.equal(ledger.inspect().batches["empty"].state, "running");
});
