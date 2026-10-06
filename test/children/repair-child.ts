/**
 * 崩溃测试子进程：在真实独立进程里执行操作，配合
 * BACKUP_REPAIR_CRASH_AT（库内崩溃点）或自我 SIGKILL 模拟进程被强制终止。
 *
 * 环境变量：
 *   REPO_DIR  仓库目录（必填）
 *   ACTION    repair | repair-partial | repair-then-die | validate
 */
import { BackupRepairStore } from '../../src/index.js';
import { chunkEvery } from '../helpers.js';
import { X } from '../scenario.js';

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

async function* partialChunks(): AsyncGenerator<Uint8Array> {
  // 只交付出 4 MiB 块的前 1 MiB，然后进程被杀。
  yield X.data.subarray(0, 1024 * 1024);
  die();
}

async function main(): Promise<void> {
  const dir = process.env.REPO_DIR;
  const action = process.env.ACTION;
  if (!dir || !action) throw new Error('REPO_DIR and ACTION are required');

  const store = await BackupRepairStore.open(dir);
  switch (action) {
    case 'repair': {
      const result = await store.submitRepair(X.hash, chunkEvery(X.data, 1024 * 1024));
      console.log(`REPAIR_RESULT ${result.status}`);
      break;
    }
    case 'repair-partial': {
      await store.submitRepair(X.hash, partialChunks());
      console.log('REPAIR_RESULT unexpected-success');
      break;
    }
    case 'repair-then-die': {
      const result = await store.submitRepair(X.hash, chunkEvery(X.data, 1024 * 1024));
      await store.close();
      console.log(`REPAIR_RESULT ${result.status}`);
      die();
      break;
    }
    case 'validate': {
      await store.validate();
      console.log('VALIDATE_DONE');
      break;
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
  await store.close();
  console.log('CHILD_DONE');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
