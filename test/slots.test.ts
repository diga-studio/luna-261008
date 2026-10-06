import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { RenderQueue } from '../src/queue.ts';
import {
  StageDriver,
  defer,
  listFiles,
  makeTempDir,
  pathExists,
  writeArtifact,
} from './helpers.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

test('cancel of abort-ignoring job holds slot until executor stops; reprioritized waiter starts first; late artifacts cleaned', async () => {
  const root = await makeTempDir('rq-slots-');
  const workRoot = join(root, 'work');
  const outputDir = join(root, 'out');
  const inputPath = join(root, 'input.mov');
  await fsp.writeFile(inputPath, 'source-footage');

  const driver = new StageDriver();
  const gates = new Map<string, ReturnType<typeof defer>>();
  driver.setDefault(async (call) => {
    const gate = gates.get(call.jobId);
    if (gate) await gate.promise;
    return writeArtifact(call.workDir, `${call.stage}.bin`, `${call.jobId}:${call.stage}`);
  });

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });

  const running: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = queue.submit(inputPath, 'normal');
    running.push(id);
    gates.set(id, defer());
  }
  const starts = await driver.waitForStarts(10);
  assert.equal(starts.length, 10);
  assert.ok(starts.every((c) => c.stage === 'compositing'));

  const waiterA = queue.submit(inputPath, 'normal');
  const waiterB = queue.submit(inputPath, 'normal');
  await flush();
  assert.equal(driver.calls.length, 10, 'no free slot for waiters');

  assert.equal(queue.reprioritize(waiterB, 'high'), true);
  assert.equal(queue.reprioritize(running[1]!, 'high'), false, 'running job cannot be reprioritized');

  const victim = running[0]!;
  assert.equal(queue.cancel(victim), true, 'cancel succeeds without waiting for the stage');
  assert.equal(queue.snapshot(victim).status, 'cancelled', 'cancelled visible immediately');
  assert.equal(queue.cancel(victim), false, 'second cancel fails');

  await flush();
  assert.equal(driver.calls.length, 10, 'slot still held while executor has not stopped');

  gates.get(victim)!.resolve();
  const eleven = await driver.waitForStarts(11);
  assert.equal(eleven[10]!.jobId, waiterB, 'reprioritized waiter starts first');
  assert.equal(eleven[10]!.stage, 'compositing');

  const victimWorkDir = join(workRoot, victim);
  assert.equal(await pathExists(victimWorkDir), false, 'late artifacts cleaned after executor stopped');
  assert.equal(queue.snapshot(victim).status, 'cancelled');
  assert.equal(queue.snapshot(victim).outputPath, undefined);

  const fourteen = await driver.waitForStarts(14);
  assert.equal(fourteen[13]!.jobId, waiterA, 'normal waiter starts after the high one');

  for (const id of running.slice(1)) gates.get(id)!.resolve();
  await queue.drain();

  for (const id of [...running.slice(1), waiterA, waiterB]) {
    const snap = queue.snapshot(id);
    assert.equal(snap.status, 'completed');
    assert.ok(snap.outputPath);
    assert.equal(await fsp.readFile(snap.outputPath!, 'utf8'), `${id}:applyingEffects`);
  }
  assert.equal(queue.snapshot(victim).status, 'cancelled');
  assert.equal(await pathExists(join(outputDir, `${victim}.bin`)), false);

  assert.equal((await listFiles(workRoot)).length, 0, 'no leftover work dirs');
  assert.equal((await listFiles(outputDir)).length, 11, 'exactly the completed jobs published');
});
