import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, compare } from "../src/index.js";
import type { CaseInput, SimInput } from "../src/index.js";

/** 简单可复现的伪随机生成器（测试数据用）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildInput(seed: number): SimInput {
  const rand = lcg(seed);
  const names = ["A", "B", "C", "D"];
  const activities: SimInput["activities"] = {};
  for (const n of names) {
    const samples: number[] = [];
    const m = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < m; i++) samples.push(Math.floor(rand() * 20));
    activities[n] = { samples, capacity: 1 + Math.floor(rand() * 4) };
  }
  const cases: CaseInput[] = [];
  for (let i = 0; i < 40; i++) {
    const path: string[] = [];
    const len = 1 + Math.floor(rand() * 8);
    for (let j = 0; j < len; j++) path.push(names[Math.floor(rand() * names.length)]!);
    cases.push({ id: `case${String(i).padStart(3, "0")}`, arrival: Math.floor(rand() * 500), activities: path });
  }
  return { cases, activities };
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const rand = lcg(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

test("同 seed 重复运行结果一致", () => {
  const input = buildInput(1);
  const scenario = { remove: ["B"], shorten: { A: 30 }, capacity: { C: 5 } };
  const r1 = replay(input, scenario, 123, 4);
  const r2 = replay(input, scenario, 123, 4);
  assert.deepEqual(r1, r2);
});

test("打乱 case 与样本输入顺序后结果一致", () => {
  const input = buildInput(2);
  const shuffled: SimInput = {
    cases: shuffle(input.cases, 11),
    activities: Object.fromEntries(
      shuffle(Object.entries(input.activities), 13).map(([name, def], i) => [
        name,
        { samples: shuffle(def.samples, 17 + i), capacity: def.capacity },
      ]),
    ),
  };
  const scenario = { shorten: { A: 25 }, capacity: { D: 2 } };
  assert.deepEqual(replay(input, scenario, 77, 2), replay(shuffled, scenario, 77, 2));
});

test("删除中间步骤不影响保留步骤的原始抽样", () => {
  const input: SimInput = {
    activities: {
      A: { samples: [3, 9, 4, 4], capacity: 3 },
      B: { samples: [100, 200], capacity: 1 },
      C: { samples: [5, 6, 7], capacity: 2 },
    },
    cases: [
      { id: "x", arrival: 0, activities: ["A", "B", "A", "C"] },
      { id: "y", arrival: 1, activities: ["C", "B", "A"] },
    ],
  };
  const base = replay(input, {}, 555, 0);
  const cut = replay(input, { remove: ["B"] }, 555, 0);
  const dur = new Map(base.steps.map((s) => [`${s.caseId}#${s.index}`, s.end - s.start]));
  assert.ok(cut.steps.length > 0);
  for (const s of cut.steps) {
    assert.equal(s.end - s.start, dur.get(`${s.caseId}#${s.index}`), `step ${s.caseId}#${s.index}`);
  }
  // 保留步骤的原始下标未被重排
  for (const s of cut.steps) {
    assert.notEqual(s.activity, "B");
  }
});

test("无修改方案与基线逐步完全一致", () => {
  const input = buildInput(3);
  const base = replay(input, {}, 888, 1);
  const empty1 = replay(input, {}, 888, 1);
  const empty2 = replay(input, { remove: [], shorten: {}, capacity: {} }, 888, 1);
  assert.deepEqual(empty1, base);
  assert.deepEqual(empty2, base);
  // compare 中空方案的差值必须为 0
  const c = compare(input, {}, 888, 100);
  assert.equal(c.diff.mean, 0);
  assert.equal(c.diff.median, 0);
  assert.equal(c.baseline.mean, c.scenario.mean);
});

test("不同 round 的抽样一般不同（配对仿真共享同一 round 抽样）", () => {
  const input = buildInput(4);
  const r0 = replay(input, {}, 42, 0);
  const r1 = replay(input, {}, 42, 1);
  assert.notDeepEqual(r0, r1);
});
