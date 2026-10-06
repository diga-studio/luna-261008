# PipeForge Local Delivery Library

TypeScript library that publishes immutable source files as numbered versions
of logical outputs on the local filesystem.

## Features

- `publish(output, requestId, sourcePath)` — publish a source file as the next
  version of an output; returns the version number (starts at 1, increments).
- `rollback(output, requestId, version)` — republish the content of a retained
  historical version as a new version; the original version is untouched.
- `inspect(output)` — view the current version and all retained versions
  (number, SHA-256, size) plus the stable delivery path.
- Only the most recent 20 versions are retained; the current version is always
  among them. The delivery path (`outputs/<output>/current`) is a stable,
  atomically replaced regular file whose bytes equal the current version.
- `requestId` is permanently idempotent per output: retrying a committed
  request with the same parameters returns the original version number without
  appending versions or touching the delivery file — even if the original
  version has since been evicted. Retrying an uncommitted request executes
  normally. Reusing a committed requestId with different parameters throws.
- Metadata is persisted in `outputs/<output>/meta.json` (atomic writes), so
  state survives restarts. All writes go through temp-file + rename.

## Layout

```
<root>/outputs/<output>/current      stable delivery file
<root>/outputs/<output>/versions/N   retained version N bytes
<root>/outputs/<output>/meta.json    versions, requests, current pointer
```

## Build & test

Requires only Node.js. All tooling is in `package.json` devDependencies.

```sh
npm install
npm test        # compiles TypeScript and runs node:test suites
npm run build   # emit library to dist/
```

## Usage

```ts
import { PipeForge } from "pipeforge-local-delivery";

const forge = new PipeForge("/var/delivery");
const v1 = await forge.publish("app", "req-1", "/tmp/app-v1.bin");
const v2 = await forge.rollback("app", "req-2", v1);
const state = await forge.inspect("app");
```
