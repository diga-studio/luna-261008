import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceTrial } from './helpers.js';
import { makeArchive } from './helpers.js';
import { runTrial } from '../src/explode.js';
import type { BomArchiveInput, BomLine, BomRevision, MaterialMaster, MaterialType } from '../src/types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDecimal(rand: () => number, maxInt: number, fracDigits: number): string {
  const intPart = Math.floor(rand() * maxInt);
  if (fracDigits === 0) return String(intPart);
  let frac = '';
  for (let i = 0; i < fracDigits; i++) frac += Math.floor(rand() * 10);
  // 去掉末尾 0 再随机决定是否保留小数（也可能为整数文本）
  frac = frac.replace(/0+$/, '');
  return frac === '' ? String(intPart) : `${intPart}.${frac}`;
}

interface Generated {
  input: BomArchiveInput;
  roots: { materialId: string; revisionId: string; quantity: string }[];
  date: string;
}

/** 生成无环小档案：组件只允许引用下标更大的物料，天然限制深度。 */
function generate(seed: number): Generated {
  const rand = mulberry32(seed);
  const count = 3 + Math.floor(rand() * 6); // 3..8 个物料
  const materials: MaterialMaster[] = [];
  const revisions: BomRevision[] = [];
  const lines: BomLine[] = [];

  for (let i = 0; i < count; i++) {
    const r = rand();
    const type: MaterialType = i === 0 ? 'MANUFACTURED' : r < 0.45 ? 'MANUFACTURED' : r < 0.6 ? 'PHANTOM' : 'PURCHASED';
    materials.push({ id: `M${i}`, type });
    if (type === 'PURCHASED') continue;
    // 1~2 个不重叠修订，覆盖 2026 全年
    const revCount = rand() < 0.5 ? 1 : 2;
    const bounds = revCount === 1 ? ['2026-01-01', '2027-01-01'] : ['2026-01-01', '2026-07-01', '2027-01-01'];
    for (let v = 0; v < revCount; v++) {
      const revId = `R${i}_${v}`;
      revisions.push({ id: revId, materialId: `M${i}`, validFrom: bounds[v]!, validTo: bounds[v + 1]! });
      const lineCount = i + 1 >= count ? 0 : Math.floor(rand() * 3); // 0..2 条明细
      for (let l = 0; l < lineCount; l++) {
        const component = i + 1 + Math.floor(rand() * (count - i - 1));
        const usage = randomDecimal(rand, 4, 6);
        if (usage === '0') continue;
        const lossRate = rand() < 0.7 ? randomDecimal(rand, 30, 4) : undefined;
        lines.push(
          lossRate === undefined
            ? { revisionId: revId, componentId: `M${component}`, usage }
            : { revisionId: revId, componentId: `M${component}`, usage, lossRate },
        );
      }
    }
  }

  const manufactured = materials.filter((m) => m.type === 'MANUFACTURED');
  const rootCount = 1 + Math.floor(rand() * Math.min(2, manufactured.length));
  const roots: Generated['roots'] = [];
  const used = new Set<number>();
  for (let r = 0; r < rootCount; r++) {
    let idx = Math.floor(rand() * manufactured.length);
    while (used.has(idx)) idx = (idx + 1) % manufactured.length;
    used.add(idx);
    const m = manufactured[idx]!;
    const revs = revisions.filter((x) => x.materialId === m.id);
    const chosen = revs[Math.floor(rand() * revs.length)]!;
    roots.push({ materialId: m.id, revisionId: chosen.id, quantity: String(1 + Math.floor(rand() * 1000)) });
  }

  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { input: { materials, revisions, lines }, roots, date };
}

test('随机小档案：与独立分数参照实现完全一致', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { input, roots, date } = generate(seed);
    const archive = makeArchive(input);
    const expected = referenceTrial(input, date, roots);
    const actual = runTrial(archive, { productionDate: date, roots });

    const actualProduction = new Map(actual.production.map((p) => [JSON.stringify([p.materialId, p.revisionId]), p.quantity]));
    const expectedProduction = new Map(
      [...expected.production.entries()].map(([k, v]) => {
        const [, materialId, revisionId] = JSON.parse(k) as [string, string, string];
        return [JSON.stringify([materialId, revisionId]), v.toString()];
      }),
    );
    assert.deepEqual(actualProduction, expectedProduction, `production mismatch at seed ${seed}`);

    const actualIssue = new Map(actual.issue.map((p) => [p.materialId, p.quantity]));
    const expectedIssue = new Map([...expected.issue.entries()].map(([k, v]) => [k, v.toString()]));
    assert.deepEqual(actualIssue, expectedIssue, `issue mismatch at seed ${seed}`);
  }
});
