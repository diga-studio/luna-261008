# render-queue

In-memory render queue with cancellation, staged execution, and product delivery.

## Usage

```ts
import { RenderQueue } from './src/index.ts';

const queue = new RenderQueue({
  outputDir: '/path/to/products',
  workRoot: '/path/to/scratch',
  runStage: async (jobId, stage, inputPath, workDir, signal, onProgress) => {
    // do real work, write the artifact into workDir, return its path
    onProgress(0.5);
    return artifactPath;
  },
});

const id = queue.submit('/path/to/input.mov', 'high'); // 'high' | 'normal' | 'low'
queue.reprioritize(id, 'low');   // queued jobs only
queue.cancel(id);                // non-terminal jobs only, returns success
const snap = queue.snapshot(id); // { status, stage, stageProgress, outputPath? }
await queue.drain();             // resolves when the queue is idle
```

Jobs flow `queued -> compositing -> encoding -> applyingEffects -> completed`;
uncaught stage failures lead to `failed`. `completed` / `failed` / `cancelled`
are terminal. Only `completed` snapshots expose `outputPath`.

Guarantees:

- 10 fixed slots (configurable via `slots`); a slot is held from job start
  until execution and cleanup I/O finish — a publicly `cancelled` job may
  still hold its slot until the executor's promise settles.
- A successful `cancel` is visible immediately; late results, errors, and
  progress from the executor can never mutate a terminal state, and stale
  progress never leaks into the next stage.
- Cancellation wins against an in-flight publish; the half-published product
  is removed. If `completed` becomes visible first, `cancel` fails and the
  product stays readable.
- Work directories of cancelled/failed jobs are removed automatically once
  the executor stops; the original input is never touched.

## Develop

```sh
npm install
npm test        # runs the TypeScript tests directly (Node >= 22.18 type stripping)
npm run build   # type-check only
```
