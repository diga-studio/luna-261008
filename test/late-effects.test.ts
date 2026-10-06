import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { RenderQueue } from '../src/queue.ts';
import type { ProgressCallback } from '../src/types.ts';
import {
  StageDriver,
  defer,
  listFiles,
  makeTempDir,
  pathExists,
  writeArtifact,
} from './helpers.ts';

async function setup() {
  const root = await makeTempDir('rq-late-');
  const workRoot = join(root, 'work');
  const outputDir = join(root, 'out');
  const inputPath = join(root, 'input.mov');
  await fsp.writeFile(inputPath, 'source-footage');
  return { root, workRoot, outputDir, inputPath };
}

test('late progress from a finished stage does not pollute the current stage', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();
  const encodingGate = defer();
  let compositingProgress: ProgressCallback | null = null;

  driver.setDefault(async (call) => {
    if (call.stage === 'compositing') {
      compositingProgress = call.progress;
      return writeArtifact(call.workDir, 'comp.bin', 'comp');
    }
    if (call.stage === 'encoding') {
      await encodingGate.promise;
      return writeArtifact(call.workDir, 'enc.bin', 'enc');
    }
    return writeArtifact(call.workDir, 'fx.bin', 'fx');
  });

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });
  const id = queue.submit(inputPath, 'normal');

  await driver.waitForStarts(2);
  assert.deepEqual(
    { stage: queue.snapshot(id).stage, progress: queue.snapshot(id).stageProgress },
    { stage: 'encoding', progress: null },
  );

  compositingProgress!(0.95);
  assert.equal(queue.snapshot(id).stageProgress, null, 'stale progress ignored');

  const encodingCall = driver.calls[1]!;
  encodingCall.progress(0.4);
  assert.equal(queue.snapshot(id).stageProgress, 0.4);

  compositingProgress!(0.99);
  assert.equal(queue.snapshot(id).stageProgress, 0.4, 'stale progress still ignored');

  encodingGate.resolve();
  await driver.waitForStarts(3);
  assert.deepEqual(
    { stage: queue.snapshot(id).stage, progress: queue.snapshot(id).stageProgress },
    { stage: 'applyingEffects', progress: null },
    'previous stage progress does not leak into the next stage',
  );

  await queue.drain();
  const snap = queue.snapshot(id);
  assert.equal(snap.status, 'completed');
  assert.equal(await fsp.readFile(snap.outputPath!, 'utf8'), 'fx');
});

test('stage error arriving after cancel keeps cancelled state and cleans up', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();
  const gate = defer();

  driver.setDefault(async (call) => {
    await gate.promise;
    throw new Error('executor exploded after cancel');
  });

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });
  const id = queue.submit(inputPath, 'normal');
  await driver.waitForStarts(1);

  assert.equal(queue.cancel(id), true);
  assert.equal(queue.snapshot(id).status, 'cancelled');

  gate.resolve();
  await queue.drain();

  assert.equal(queue.snapshot(id).status, 'cancelled', 'late error must not flip cancelled to failed');
  assert.equal(queue.snapshot(id).outputPath, undefined);
  assert.equal(await pathExists(join(workRoot, id)), false, 'work dir cleaned after executor stopped');
  assert.equal((await listFiles(outputDir)).length, 0);
});

test('failed jobs are terminal and cleaned up automatically', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();
  driver.setDefault(async () => {
    throw new Error('render failed');
  });

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });
  const id = queue.submit(inputPath, 'normal');
  await queue.drain();

  const snap = queue.snapshot(id);
  assert.equal(snap.status, 'failed');
  assert.equal(snap.stage, null);
  assert.equal(snap.stageProgress, null);
  assert.equal(snap.outputPath, undefined);
  assert.equal(queue.cancel(id), false, 'failed is terminal');
  assert.equal(queue.reprioritize(id, 'high'), false);
  assert.equal((await listFiles(workRoot)).length, 0, 'failed job work dir cleaned');
  assert.equal((await listFiles(outputDir)).length, 0);
});
