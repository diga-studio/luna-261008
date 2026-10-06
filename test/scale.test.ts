import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArchive, mat, rev, line } from './helpers.js';
import { runTrial } from '../src/explode.js';
import type { BomLine, BomRevision, MaterialMaster } from '../src/types.js';

// 十亿级有效路径：根 + 10 层 × 7 个自制件（层内全连接到下一层）+ 第 12 层 7 个外购件
// 路径数 = 7^11 = 1977326743 > 1e9，但节点仅 78 个、明细 497 条
function buildWideArchive() {
  const materials: MaterialMaster[] = [mat('R', 'MANUFACTURED')];
  const revisions: BomRevision[] = [rev('RR', 'R', '2026-01-01', '2027-01-01')];
  const lines: BomLine[] = [];
  for (let level = 2; level <= 11; level++) {
    for (let j = 0; j < 7; j++) {
      const id = `L${level}N${j}`;
      materials.push(mat(id, 'MANUFACTURED'));
      revisions.push(rev(`R${id}`, id, '2026-01-01', '2027-01-01'));
    }
  }
  for (let j = 0; j < 7; j++) {
    materials.push(mat(`P${j}`, 'PURCHASED'));
  }
  for (let j = 0; j < 7; j++) {
    lines.push(line('RR', `L2N${j}`, '1', '0'));
  }
  for (let level = 2; level <= 11; level++) {
    for (let j = 0; j < 7; j++) {
      for (let k = 0; k < 7; k++) {
        const target = level === 11 ? `P${k}` : `L${level + 1}N${k}`;
        lines.push(line(`RL${level}N${j}`, target, '1', '0'));
      }
    }
  }
  return makeArchive({ materials, revisions, lines });
}

test('十亿级有效路径的共享结构：聚合计算，数量可独立核对', () => {
  const archive = buildWideArchive();
  const start = Date.now();
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'R', revisionId: 'RR', quantity: '1' }],
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `trial took ${elapsed}ms`);

  // 第 k 层（k=2..11）每个节点需求 = 7^(k-2)
  for (let level = 2; level <= 11; level++) {
    const expected = (7n ** BigInt(level - 2)).toString();
    for (let j = 0; j < 7; j++) {
      const p = result.production.find((x) => x.materialId === `L${level}N${j}`);
      assert.ok(p !== undefined, `missing L${level}N${j}`);
      assert.equal(p.quantity, expected, `L${level}N${j}`);
    }
  }
  // 每个外购件需求 = 7^10 = 282475249；总计 7^11 = 1977326743
  assert.equal(result.issue.length, 7);
  let total = 0n;
  for (const issue of result.issue) {
    assert.equal(issue.quantity, '282475249');
    total += BigInt(issue.quantity);
  }
  assert.equal(total, 1977326743n);
});

test('极大数量与极小尾数：1e12 根件 × 6 位小数用量 × 4 位小数损耗，数学精确', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01'), rev('RS', 'S', '2026-01-01', '2027-01-01')],
    lines: [line('RA', 'S', '999999.999999', '99.9999'), line('RS', 'M', '0.000001', '0.0001')],
  });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '1000000000000' }],
  });
  // S 需求 = 1e12 * 999999.999999 * 1.999999
  //        = 999999999999 * 1999999 = 1999998999998000001（恰好整数）
  const sDemandNum = 10n ** 12n * 999999999999n * 1999999n; // / 1e12
  const sQty = sDemandNum / 10n ** 12n + (sDemandNum % 10n ** 12n !== 0n ? 1n : 0n);
  assert.equal(sQty, 1999998999998000001n);
  const s = result.production.find((p) => p.materialId === 'S')!;
  assert.equal(s.quantity, sQty.toString());

  // M 需求 = sQty * 0.000001 * 1.000001 = sQty * 1000001 / 1e12
  const mNum = sQty * 1000001n;
  const mQty = mNum / 1000000000000n + (mNum % 1000000000000n !== 0n ? 1n : 0n);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: mQty.toString() }]);
});

test('12 层链式精度：每层 1.000001 用量 + 0.0001 损耗，与 BigInt 手算一致', () => {
  const depth = 11; // 11 个自制件 + 第 12 层外购件
  const materials: MaterialMaster[] = [mat('N1', 'MANUFACTURED'), mat('M', 'PURCHASED')];
  const revisions: BomRevision[] = [rev('R1', 'N1', '2026-01-01', '2027-01-01')];
  const lines: BomLine[] = [];
  for (let i = 2; i <= depth; i++) {
    materials.push(mat(`N${i}`, 'MANUFACTURED'));
    revisions.push(rev(`R${i}`, `N${i}`, '2026-01-01', '2027-01-01'));
  }
  for (let i = 1; i <= depth; i++) {
    lines.push(line(`R${i}`, i === depth ? 'M' : `N${i + 1}`, '1.000001', '0.0001'));
  }
  const archive = makeArchive({ materials, revisions, lines });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'N1', revisionId: 'R1', quantity: '1000000000000' }],
  });

  // 每层因子 = 1.000001 * 1.000001 = 1000001^2 / 1e12（用量 1.000001，损耗 0.0001% -> 因子 1.000001）
  // 注意：损耗率 0.0001 表示 0.0001%，因子 = 1 + 0.0001/100 = 1.000001
  const UNIT = 1000000n; // 用量与损耗因子均放大 1e6
  const FACTOR = 1000001n; // 1.000001 * 1e6
  let demand = 1000000000000n; // 根件整数
  const ceilDiv = (num: bigint, den: bigint) => num / den + (num % den !== 0n ? 1n : 0n);
  for (let level = 1; level <= depth; level++) {
    const id = `N${level}`;
    const p = result.production.find((x) => x.materialId === id)!;
    if (level === 1) {
      assert.equal(p.quantity, '1000000000000');
    } else {
      // 父件整件数 * FACTOR^2 / UNIT^2 后向上取整
      const num = demand * FACTOR * FACTOR;
      demand = ceilDiv(num, UNIT * UNIT);
      assert.equal(p.quantity, demand.toString(), `level ${level}`);
    }
  }
  const mNum = demand * FACTOR * FACTOR;
  const mQty = ceilDiv(mNum, UNIT * UNIT);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: mQty.toString() }]);
});

test('连续多次试算不同日期与数量，结果各自正确', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M1', 'PURCHASED'), mat('M2', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('R1', 'S', '2026-01-01', '2026-06-01'),
      rev('R2', 'S', '2026-06-01', '2027-01-01'),
    ],
    lines: [line('RA', 'S', '0.4', '0'), line('R1', 'M1', '1', '0'), line('R2', 'M2', '2', '0')],
  });
  const r1 = runTrial(archive, {
    productionDate: '2026-03-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '2' }],
  });
  assert.deepEqual(r1.production.find((p) => p.materialId === 'S'), { materialId: 'S', revisionId: 'R1', quantity: '1' });
  assert.deepEqual(r1.issue, [{ materialId: 'M1', quantity: '1' }]);

  const r2 = runTrial(archive, {
    productionDate: '2026-09-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '10' }],
  });
  assert.deepEqual(r2.production.find((p) => p.materialId === 'S'), { materialId: 'S', revisionId: 'R2', quantity: '4' });
  assert.deepEqual(r2.issue, [{ materialId: 'M2', quantity: '8' }]);

  const r3 = runTrial(archive, {
    productionDate: '2026-03-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '100' }],
  });
  assert.deepEqual(r3.issue, [{ materialId: 'M1', quantity: '40' }]);
});
