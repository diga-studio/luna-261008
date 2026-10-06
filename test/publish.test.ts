import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RenderQueue } from '../src/queue.ts';
import { StageDriver, listFiles, makeTempDir, pathExists, writeArtifact } from './helpers.ts';

const execFileP = promisify(execFile);

async function setup() {
  const root = await makeTempDir('rq-publish-');
  const workRoot = join(root, 'work');
  const outputDir = join(root, 'out');
  const inputPath = join(root, 'input.mov');
  await fsp.writeFile(inputPath, 'source-footage');
  return { root, workRoot, outputDir, inputPath };
}

test('cancel while final publish is in flight succeeds and the product is never exposed', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();

  driver.setDefault(async (call) => {
    if (call.stage === 'applyingEffects') {
      const fifoPath = join(call.workDir, 'final.mov');
      await execFileP('mkfifo', [fifoPath]);
      return fifoPath;
    }
    return writeArtifact(call.workDir, `${call.stage}.bin`, `${call.stage}`);
  });

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });
  const id = queue.submit(inputPath, 'normal');
  const calls = await driver.waitForStarts(3);
  const fifoPath = join(calls[2]!.workDir, 'final.mov');

  // Opening the FIFO for writing resolves exactly when the engine's publish
  // stream opens it for reading: publish has started but cannot finish yet.
  const writer = await fsp.open(fifoPath, 'w');

  assert.equal(queue.cancel(id), true, 'cancel wins while publish is in flight');
  assert.equal(queue.snapshot(id).status, 'cancelled');

  await writer.writeFile('finished-product');
  await writer.close();
  await queue.drain();

  const snap = queue.snapshot(id);
  assert.equal(snap.status, 'cancelled', 'late publish result must not resurrect the job');
  assert.equal(snap.outputPath, undefined, 'cancelled job never exposes a product path');
  assert.equal(await pathExists(join(outputDir, `${id}.mov`)), false, 'published file removed');
  assert.equal((await listFiles(outputDir)).length, 0);
  assert.equal((await listFiles(workRoot)).length, 0, 'work dir including the fifo cleaned');
});

test('when completion becomes visible first, cancel fails and the product stays readable', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();
  driver.setDefault((call) => writeArtifact(call.workDir, `${call.stage}.mov`, `${call.stage}-data`));

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot });
  const id = queue.submit(inputPath, 'normal');
  await queue.drain();

  const snap = queue.snapshot(id);
  assert.equal(snap.status, 'completed');
  assert.ok(snap.outputPath, 'completed job exposes the product path');

  assert.equal(queue.cancel(id), false, 'cancel loses once completed is visible');
  assert.equal(await fsp.readFile(snap.outputPath!, 'utf8'), 'applyingEffects-data');
  assert.equal(queue.snapshot(id).status, 'completed');

  assert.equal((await listFiles(outputDir)).length, 1);
  assert.equal((await listFiles(workRoot)).length, 0, 'intermediate files cleaned after completion');
});

test('queued job can be cancelled and reprioritized; unknown ids are rejected', async () => {
  const { workRoot, outputDir, inputPath } = await setup();
  const driver = new StageDriver();
  const never = new Promise<string>(() => {});
  driver.setDefault(() => never);

  const queue = new RenderQueue({ runStage: driver.runStage, outputDir, workRoot, slots: 1 });
  const blocker = queue.submit(inputPath, 'normal');
  const queued = queue.submit(inputPath, 'low');
  await driver.waitForStarts(1);

  assert.equal(queue.reprioritize(queued, 'high'), true);
  assert.equal(queue.cancel(queued), true, 'queued job cancelled without touching the running one');
  assert.equal(queue.snapshot(queued).status, 'cancelled');
  assert.equal(queue.snapshot(blocker).status, 'running', 'running job undisturbed');

  assert.equal(queue.cancel('no-such-job'), false);
  assert.equal(queue.reprioritize('no-such-job', 'high'), false);
  assert.throws(() => queue.snapshot('no-such-job'), /unknown job/);
});
