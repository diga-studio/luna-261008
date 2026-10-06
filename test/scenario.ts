import { BackupRepairStore, type CorruptionReport, type Manifest } from '../src/index.js';
import { makeBlock, makeData } from './helpers.js';

/**
 * 崩溃恢复测试共用的场景：父进程和子进程用同样的种子重建同样的数据。
 * X 为 4 MiB 满块，初始为同长度的错误数据；Y 为小缺失块；Z 健康；
 * M1..M4 为 4 MiB 块，初始均为同长度错误数据。
 * 若恢复时重读全部损坏块需 20 MiB 以上，超过 16 MiB 限制；
 * 只按日志恢复单个被中断修复时只需读 4 MiB。
 */
export const X = makeBlock('crash-X', 4 * 1024 * 1024);
export const Y = makeBlock('crash-Y', 1000);
export const Z = makeBlock('crash-Z', 500);
export const M1 = makeBlock('crash-M1', 4 * 1024 * 1024);
export const M2 = makeBlock('crash-M2', 4 * 1024 * 1024);
export const M3 = makeBlock('crash-M3', 4 * 1024 * 1024);
export const M4 = makeBlock('crash-M4', 4 * 1024 * 1024);
export const corruptX = makeData('corrupt-X', X.data.length);
export const corruptM1 = makeData('corrupt-M1', M1.data.length);
export const corruptM2 = makeData('corrupt-M2', M2.data.length);
export const corruptM3 = makeData('corrupt-M3', M3.data.length);
export const corruptM4 = makeData('corrupt-M4', M4.data.length);

function ref(block: { hash: string; data: Uint8Array }) {
  return { hash: block.hash, length: block.data.length };
}

export const manifest: Manifest = {
  versions: [
    { id: 'v1', files: [{ path: 'v1/f', blocks: [ref(X), ref(X), ref(Y)] }] },
    { id: 'v2', files: [{ path: 'v2/f', blocks: [ref(X), ref(Z), ref(M1), ref(M2), ref(M3), ref(M4)] }] },
  ],
};

/** 导入初始数据（X/M1..M4 损坏、Y 缺失、Z 正确）并完成一次完整校验。 */
export async function setupRepo(dir: string): Promise<CorruptionReport> {
  const store = await BackupRepairStore.open(dir);
  await store.import(manifest, [
    { hash: X.hash, data: corruptX },
    { hash: Z.hash, data: Z.data },
    { hash: M1.hash, data: corruptM1 },
    { hash: M2.hash, data: corruptM2 },
    { hash: M3.hash, data: corruptM3 },
    { hash: M4.hash, data: corruptM4 },
  ]);
  const report = await store.validate();
  await store.close();
  return report;
}
