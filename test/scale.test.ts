import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, compare } from "../src/index.js";
import type { CaseInput, SimInput } from "../src/index.js";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 单轮规模：20 活动、20000 case、200000 步骤、1e12 毫秒到达跨度。 */
function buildLargeInput(): SimInput {
  const rand = lcg(2026);
  const activities: SimInput["activities"] = {};
  const names: string[] = [];
  for (let a = 0; a < 20; a++) {
    const name = `act${a}`;
    names.push(name);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) samples.push(Math.floor(rand() * 1000));
    activities[name] = { samples, capacity: 1 + Math.floor(rand() * 50) };
  }
  const cases: CaseInput[] = [];
  for (let i = 0; i < 20000; i++) {
    const path: string[] = [];
    for (let j = 0; j < 10; j++) path.push(names[Math.floor(rand() * 20)]!);
    cases.push({
      id: `c${i}`,
      arrival: Math.floor(rand() * 1e12),
      activities: path,
    });
  }
  return { cases, activities };
}

test("单轮大规模仿真：不变量与容量约束", () => {
  const input = buildLargeInput();
  const scenario = {
    remove: ["act0", "act7"],
    shorten: { act1: 50, act2: 99 },
    capacity: { act3: 1, act4: 50 },
  };
  const t0 = Date.now();
  const r = replay(input, scenario, 99, 0);
  const elapsed = Date.now() - t0;

  // 步骤数 = 各 case 保留步骤数之和
  const removed = new Set(scenario.remove);
  let expected = 0;
  for (const c of input.cases) {
    for (const a of c.activities) if (!removed.has(a)) expected++;
  }
  assert.equal(r.steps.length, expected);
  assert.equal(r.completions.length, input.cases.length);

  // 基本时序不变量
  const arrivals = new Map(input.cases.map((c) => [c.id, c.arrival]));
  for (const s of r.steps) {
    assert.ok(s.start >= s.ready, `start>=ready: ${JSON.stringify(s)}`);
    assert.ok(s.end >= s.start, `end>=start: ${JSON.stringify(s)}`);
    assert.ok(s.ready >= arrivals.get(s.caseId)!, `ready>=arrival: ${JSON.stringify(s)}`);
  }
  // 每个 case 的步骤链：后继就绪不早于前驱完成
  const byCase = new Map<string, typeof r.steps>();
  for (const s of r.steps) {
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  for (const [caseId, list] of byCase) {
    list.sort((a, b) => a.index - b.index);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i]!.ready >= list[i - 1]!.end, `chain ${caseId}#${i}`);
    }
    const completion = r.completions.find((c) => c.caseId === caseId)!.completion;
    assert.ok(completion >= list[list.length - 1]!.end);
  }
  // 容量约束：每活动任意时刻重叠服务数不超过生效容量
  const capOf = (name: string) =>
    scenario.capacity[name as keyof typeof scenario.capacity] ??
    input.activities[name]!.capacity;
  const byAct = new Map<string, Array<[number, number]>>();
  for (const s of r.steps) {
    if (s.end === s.start) continue; // 零时长不占工位跨度
    const list = byAct.get(s.activity) ?? [];
    list.push([s.start, s.end]);
    byAct.set(s.activity, list);
  }
  for (const [act, intervals] of byAct) {
    const events: Array<[number, number]> = [];
    for (const [s, e] of intervals) {
      events.push([s, 1], [e, -1]);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    for (const [, d] of events) {
      cur += d;
      assert.ok(cur <= capOf(act), `capacity ${act}: ${cur} > ${capOf(act)}`);
    }
  }
  console.log(`    large single round: ${r.steps.length} steps in ${elapsed}ms`);
});

test("小输入 10000 轮比较", () => {
  const input: SimInput = {
    activities: {
      A: { samples: [1, 2, 3, 10, 10], capacity: 1 },
      B: { samples: [4, 4, 5], capacity: 2 },
    },
    cases: [
      { id: "a", arrival: 0, activities: ["A", "B"] },
      { id: "b", arrival: 3, activities: ["B", "A", "B"] },
      { id: "c", arrival: 3, activities: ["A"] },
      { id: "d", arrival: 9, activities: ["A", "A", "B"] },
      { id: "e", arrival: 20, activities: ["B"] },
    ],
  };
  const t0 = Date.now();
  const c = compare(input, { shorten: { A: 50 }, capacity: { A: 3 } }, 7, 10000);
  const elapsed = Date.now() - t0;
  assert.ok(Number.isFinite(c.baseline.mean));
  assert.ok(Number.isFinite(c.scenario.median));
  // 缩短+扩容只会降低耗时
  assert.ok(c.diff.mean <= 0, `diff.mean=${c.diff.mean}`);
  assert.ok(c.diff.median <= 0, `diff.median=${c.diff.median}`);
  assert.ok(c.scenario.mean <= c.baseline.mean);
  console.log(
    `    10000 rounds in ${elapsed}ms; baseline.mean=${c.baseline.mean.toFixed(3)} scenario.mean=${c.scenario.mean.toFixed(3)}`,
  );
});

test("compare 参数校验", () => {
  const input: SimInput = { cases: [], activities: {} };
  assert.throws(() => compare(input, {}, 1, 99), RangeError);
  assert.throws(() => compare(input, {}, 1, 10001), RangeError);
});
