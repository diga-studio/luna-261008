import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BomArchive, runTrial, type BomArchiveData, type TrialResult } from '../src/index.js';

/* ---------- 独立的精确参考实现（分数运算，与主实现无共享代码） ---------- */

interface Frac {
  n: bigint;
  d: bigint;
}

function frac(text: string): Frac {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) throw new Error('bad decimal ' + text);
  const f = m[2] ?? '';
  const d = 10n ** BigInt(f.length);
  return norm({ n: BigInt(m[1]!) * d + BigInt(f === '' ? '0' : f), d });
}

function norm(x: Frac): Frac {
  const g = gcd(x.n, x.d);
  return { n: x.n / g, d: x.d / g };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function add(a: Frac, b: Frac): Frac {
  return norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

function mul(a: Frac, b: Frac): Frac {
  return norm({ n: a.n * b.n, d: a.d * b.d });
}

function ceilFrac(x: Frac): bigint {
  return (x.n + x.d - 1n) / x.d;
}

function lossMul(rate: string | undefined): Frac {
  // 1 + rate/100
  const r = frac(rate ?? '2.5');
  return norm({ n: r.n + 100n * r.d, d: 100n * r.d });
}

function reference(data: BomArchiveData, date: string, roots: Array<{ materialId: string; revisionId: string; quantity: string }>): TrialResult {
  const types = new Map(data.materials.map((m) => [m.materialId, m.type]));
  const revById = new Map(data.revisions.map((r) => [r.revisionId, r]));
  const pick = (materialId: string): string => {
    const hit = data.revisions.find(
      (r) =>
        r.materialId === materialId &&
        r.effectiveFrom <= date &&
        (r.effectiveTo === undefined || date < r.effectiveTo),
    );
    if (hit === undefined) throw new Error('no revision for ' + materialId);
    return hit.revisionId;
  };

  // 节点 = 物料+修订；先沿结构发现图，再按拓扑序（DFS 后序）合并
  const childrenOf = new Map<string, string[]>();
  const demand = new Map<string, Frac>();
  const purchased = new Map<string, Frac>();
  const zero: Frac = { n: 0n, d: 1n };
  const bump = (map: Map<string, Frac>, key: string, v: Frac): void => {
    map.set(key, add(map.get(key) ?? zero, v));
  };

  const discover = (key: string): void => {
    if (childrenOf.has(key)) return;
    const [materialId, revisionId] = key.split('|') as [string, string];
    const rev = revById.get(revisionId)!;
    const kids: string[] = [];
    for (const line of rev.lines) {
      const t = types.get(line.componentId)!;
      if (t === 'purchased') continue;
      const childRev = pick(line.componentId);
      const childKey = line.componentId + '|' + childRev;
      kids.push(childKey);
      discover(childKey);
    }
    childrenOf.set(key, kids);
  };

  const rootKeys: string[] = [];
  for (const r of roots) {
    const key = r.materialId + '|' + r.revisionId;
    rootKeys.push(key);
    discover(key);
    bump(demand, key, frac(r.quantity));
  }

  // 拓扑序：反复取入度 0（Kahn）
  const indeg = new Map<string, number>();
  for (const key of childrenOf.keys()) indeg.set(key, 0);
  for (const kids of childrenOf.values()) for (const k of kids) indeg.set(k, (indeg.get(k) ?? 0) + 1);
  const order: string[] = [];
  const ready = [...childrenOf.keys()].filter((k) => indeg.get(k) === 0);
  while (ready.length > 0) {
    const key = ready.pop()!;
    order.push(key);
    for (const k of childrenOf.get(key)!) {
      const left = indeg.get(k)! - 1;
      indeg.set(k, left);
      if (left === 0) ready.push(k);
    }
  }
  if (order.length !== childrenOf.size) throw new Error('cycle');

  const production = new Map<string, bigint>();
  for (const key of order) {
    const dem = demand.get(key) ?? zero;
    if (dem.n === 0n) continue;
    const [materialId, revisionId] = key.split('|') as [string, string];
    const type = types.get(materialId)!;
    let expand: Frac;
    if (type === 'phantom') {
      expand = dem;
    } else {
      const units = ceilFrac(dem);
      production.set(key, units);
      expand = { n: units, d: 1n };
    }
    const rev = revById.get(revisionId)!;
    for (const line of rev.lines) {
      const need = mul(expand, mul(frac(line.quantity), lossMul(line.lossRate)));
      if (need.n === 0n) continue;
      const t = types.get(line.componentId)!;
      if (t === 'purchased') {
        bump(purchased, line.componentId, need);
      } else {
        bump(demand, line.componentId + '|' + pick(line.componentId), need);
      }
    }
  }

  return {
    production: [...production.entries()]
      .map(([key, units]) => {
        const [materialId, revisionId] = key.split('|') as [string, string];
        return { materialId, revisionId, quantity: units.toString() };
      })
      .sort((a, b) => (a.materialId + a.revisionId < b.materialId + b.revisionId ? -1 : 1)),
    consumption: [...purchased.entries()]
      .map(([materialId, v]) => ({ materialId, quantity: ceilFrac(v).toString() }))
      .sort((a, b) => (a.materialId < b.materialId ? -1 : 1)),
  };
}

/* ---------- 伪随机复杂档案生成（固定种子，层级有向无环） ---------- */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function buildComplexArchive(seed: number): {
  data: BomArchiveData;
  roots: Array<{ materialId: string; revisionId: string; quantity: string }>;
  date: string;
} {
  const rand = lcg(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const dec = (maxInt: number, decimals: number): string => {
    const intPart = ri(maxInt);
    const fracPart = String(ri(10 ** decimals)).padStart(decimals, '0');
    return `${intPart}.${fracPart}`;
  };

  const materials: BomArchiveData['materials'] = [];
  const revisions: BomArchiveData['revisions'] = [];
  const date = '2026-06-15';

  // 12 个外购件
  const purchasedIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    purchasedIds.push(`P${i}`);
    materials.push({ materialId: `P${i}`, type: 'purchased' });
  }

  // 11 层，每层 3~5 个自制/幻影件；边只指向更高层或外购件
  const tiers: string[][] = [];
  for (let tier = 0; tier < 11; tier++) {
    const ids: string[] = [];
    const count = 3 + ri(3);
    for (let i = 0; i < count; i++) {
      const id = `T${tier}M${i}`;
      const type = rand() < 0.25 ? 'phantom' : 'manufactured';
      materials.push({ materialId: id, type });
      ids.push(id);
    }
    tiers.push(ids);
  }

  const windows: Array<[string, string | undefined]> = [
    ['2020-01-01', '2023-01-01'],
    ['2023-01-01', '2026-01-01'],
    ['2026-01-01', '2027-01-01'],
    ['2027-01-01', undefined],
  ];

  for (let tier = 0; tier < 11; tier++) {
    for (const id of tiers[tier]!) {
      // 每个物料 1~3 个不重叠修订，其中 '2026-01-01'~'2027-01-01' 窗口必有（保证试算日期有效）
      const revCount = 1 + ri(3);
      const chosen = [['2026-01-01', '2027-01-01'] as [string, string | undefined]];
      const others = windows.filter((w) => w[0] !== '2026-01-01');
      while (chosen.length < revCount) {
        chosen.push(others.splice(ri(others.length), 1)[0]!);
      }
      chosen.forEach(([from, to], idx) => {
        const lines = [];
        const lineCount = 1 + ri(4);
        for (let li = 0; li < lineCount; li++) {
          if (tier < 10 && rand() < 0.7) {
            const higherTier = tier + 1 + ri(10 - tier);
            const target = tiers[higherTier]![ri(tiers[higherTier]!.length)]!;
            lines.push({
              componentId: target,
              quantity: dec(3, 6),
              ...(rand() < 0.3 ? {} : { lossRate: dec(10, 4) }),
            });
          } else {
            lines.push({
              componentId: purchasedIds[ri(purchasedIds.length)]!,
              quantity: dec(5, 6),
              ...(rand() < 0.3 ? {} : { lossRate: dec(10, 4) }),
            });
          }
        }
        revisions.push({
          revisionId: `${id}-R${idx}`,
          materialId: id,
          effectiveFrom: from,
          ...(to === undefined ? {} : { effectiveTo: to }),
          lines,
        });
      });
    }
  }

  // 根件：第 0、1 层各取 2 个自制件；其中一个显式指定过期修订
  const roots: Array<{ materialId: string; revisionId: string; quantity: string }> = [];
  const rootCandidates = [...tiers[0]!, ...tiers[1]!].filter((id) => {
    const m = materials.find((x) => x.materialId === id)!;
    return m.type === 'manufactured';
  });
  for (let i = 0; i < Math.min(3, rootCandidates.length); i++) {
    const id = rootCandidates[i]!;
    const revs = revisions.filter((r) => r.materialId === id);
    const rev = revs[ri(revs.length)]!;
    roots.push({ materialId: id, revisionId: rev.revisionId, quantity: String(1 + ri(1000)) });
  }

  return { data: { materials, revisions }, roots, date };
}

test('小规模复杂案例：与独立精确计算结果完全一致', () => {
  for (const seed of [1, 7, 42, 2026, 314159]) {
    const { data, roots, date } = buildComplexArchive(seed);
    const archive = new BomArchive(data);
    const actual = runTrial(archive, { productionDate: date, roots });
    const expected = reference(data, date, roots);
    assert.deepEqual(actual, expected, `seed=${seed}`);
  }
});

test('同一物料的不同修订分开核算', () => {
  // 根件显式指定旧修订展开；其子件按日期选新修订
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'B', type: 'manufactured' },
      { materialId: 'P', type: 'purchased' },
    ],
    revisions: [
      {
        revisionId: 'A-OLD',
        materialId: 'A',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2021-01-01',
        lines: [{ componentId: 'B', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'A-NEW',
        materialId: 'A',
        effectiveFrom: '2021-01-01',
        lines: [{ componentId: 'B', quantity: '2', lossRate: '0' }],
      },
      {
        revisionId: 'B-1',
        materialId: 'B',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'P', quantity: '1', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [
      { materialId: 'A', revisionId: 'A-OLD', quantity: '3' },
      { materialId: 'A', revisionId: 'A-NEW', quantity: '3' },
    ],
  });
  // A 按修订分开：各 3 件；B 合并 3×1 + 3×2 = 9 件；P = 9
  assert.deepEqual(result.production, [
    { materialId: 'A', revisionId: 'A-NEW', quantity: '3' },
    { materialId: 'A', revisionId: 'A-OLD', quantity: '3' },
    { materialId: 'B', revisionId: 'B-1', quantity: '9' },
  ]);
  assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '9' }]);
});
