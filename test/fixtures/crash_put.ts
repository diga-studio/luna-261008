/**
 * Crash fixture: starts a put, writes part of the content, then dies
 * without any cleanup (simulating a power loss mid-put).
 * Usage: node crash_put.js <rootDir>
 */
import * as path from "node:path";
import { ArchiveStore } from "../../src/index";

const root = process.argv[2];
const store = ArchiveStore.open({
  dbPath: path.join(root, "meta.sqlite"),
  tiers: {
    hot: { dir: path.join(root, "hot"), capacityBytes: 100 },
    warm: { dir: path.join(root, "warm"), capacityBytes: 100 },
    cold: { dir: path.join(root, "cold"), capacityBytes: 100 },
  },
});

async function* partial(): AsyncGenerator<Buffer> {
  yield Buffer.alloc(40, 1);
  // Hang forever: the process is killed before the stream completes.
  await new Promise<void>(() => undefined);
}

void store.put("hot", partial(), 100).catch(() => undefined);
setTimeout(() => (process as NodeJS.Process & { _exit(code: number): never })._exit(1), 300);
