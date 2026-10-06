import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArchive, mat, rev, line } from './helpers.js';
import { runTrial } from '../src/explode.js';
import type { BomLine, BomRevision, MaterialMaster } from '../src/types.js';

// 全规模：20000 个物料、每个 4 个修订、约 10 万条明细，12 层共享结构
function buildFullScaleArchive() {
  const LEVELS = 12;
  const PER_LEVEL = 1818; // 1 + 10*1818 + 1819 = 20000
  const FAN_OUT = 5;
  const materials: MaterialMaster[] = [];
  const revisions: BomRevision[] = [];
  const lines: BomLine[] = [];

  const idOf = (level: number, j: number) => `L${level}M${j}`;
  const countAt = (level: number) => (level === 1 ? 1 : level === LEVELS ? PER_LEVEL + 1 : PER_LEVEL);

  for (let level = 1; level <= LEVELS; level++) {
    for (let j = 0; j < countAt(level); j++) {
      const id = idOf(level, j);
      const type = level === LEVELS ? 'PURCHASED' : 'MANUFACTURED';
      materials.push(mat(id, type));
      if (type === 'PURCHASED') continue;
      // 每个物料 4 个不重叠修订；明细挂在 2026 年有效的修订上
      for (let v = 0; v < 4; v++) {
        const from = v < 3 ? `202${v}-01-01` : '2026-01-01';
        const to = v < 3 ? `202${v + 1}-01-01` : '2027-01-01';
        revisions.push(rev(`R${id}#${v}`, id, from, to));
      }
    }
  }
  for (let level = 1; level < LEVELS; level++) {
    for (let j = 0; j < countAt(level); j++) {
      const revId = `R${idOf(level, j)}#3`;
      for (let k = 0; k < FAN_OUT; k++) {
        const target = (j * FAN_OUT + k * 7 + level) % countAt(level + 1);
        lines.push(line(revId, idOf(level + 1, target), '1', '0'));
      }
    }
  }
  assert.ok(materials.length === 20000, `materials: ${materials.length}`);
  assert.ok(lines.length <= 100000, `lines: ${lines.length}`);
  return makeArchive({ materials, revisions, lines });
}

test('全规模档案：单次试算 < 5s，新增堆内存 < 128MiB，总量可核对', () => {
  const archive = buildFullScaleArchive();
  // 预热一次（排除首次 JIT 影响），再正式计时
  runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'L1M0', revisionId: 'RL1M0#3', quantity: '1' }],
  });

  const memBefore = process.memoryUsage().heapUsed;
  const start = Date.now();
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'L1M0', revisionId: 'RL1M0#3', quantity: '1' }],
  });
  const elapsed = Date.now() - start;
  const memDelta = process.memoryUsage().heapUsed - memBefore;

  assert.ok(elapsed < 5000, `trial took ${elapsed}ms`);
  assert.ok(memDelta < 128 * 1024 * 1024, `heap delta ${memDelta} bytes`);

  // 用量 1、损耗 0、每层扇出 5：全部整件，外购件领料总量 = 5^11 = 48828125
  let total = 0n;
  for (const issue of result.issue) {
    total += BigInt(issue.quantity);
  }
  assert.equal(total, 5n ** 11n);

  // 生产总量同样守恒：每层需求合计 = 5^(level-1)
  let productionTotal = 0n;
  for (const p of result.production) {
    productionTotal += BigInt(p.quantity);
  }
  let expectedProduction = 0n;
  for (let level = 1; level <= 11; level++) {
    expectedProduction += 5n ** BigInt(level - 1);
  }
  assert.equal(productionTotal, expectedProduction);

  console.log(`    full-scale trial: ${elapsed}ms, heap delta ${(memDelta / 1048576).toFixed(1)} MiB`);
});
