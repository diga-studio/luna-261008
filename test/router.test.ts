import { test } from "node:test";
import assert from "node:assert/strict";
import { LeadRouter } from "../src/index.ts";
import type { Lead, SalesRepState, TeamSnapshot } from "../src/index.ts";

function rep(partial: Partial<SalesRepState> & { id: string }): SalesRepState {
  return { available: true, skills: [], assignedCount: 0, ...partial };
}

function snapshot(reps: SalesRepState[], rotationStart = 0): TeamSnapshot {
  return { reps, rotationStart };
}

function lead(id: string, industry: string, budget: number): Lead {
  return { id, industry, budget };
}

const techAll = { industry: "tech", minBudget: 0, maxBudget: Number.MAX_SAFE_INTEGER };

test("整批均衡值最小：L1 甲乙均可、L2 仅甲可选，必须先给乙再给甲", () => {
  const router = new LeadRouter(
    snapshot(
      [
        rep({ id: "甲", skills: [techAll] }),
        rep({ id: "乙", skills: [{ industry: "tech", minBudget: 0, maxBudget: 100 }] }),
      ],
      0,
    ),
  );
  // L1 预算 50：甲乙均可；L2 预算 150：仅甲（乙的区间上界 100 不包含）。
  const result = router.routeBatch([lead("L1", "tech", 50), lead("L2", "tech", 150)]);
  assert.deepEqual(
    result.assignments.map((a) => a.assignee),
    ["乙", "甲"],
  );
  const state = router.getState();
  assert.equal(state.reps[0].assignedCount, 1);
  assert.equal(state.reps[1].assignedCount, 1);
  assert.equal(state.rotationStart, 1); // 甲是下标 0，下一位是乙
});

test("技能匹配：行业相同且预算落在 [min, max) 区间", () => {
  const router = new LeadRouter(
    snapshot(
      [
        rep({ id: "A", skills: [{ industry: "tech", minBudget: 100, maxBudget: 200 }] }),
        rep({ id: "B", skills: [{ industry: "finance", minBudget: 100, maxBudget: 200 }] }),
        rep({ id: "C", skills: [{ industry: "tech", minBudget: 200, maxBudget: 300 }] }),
      ],
      0,
    ),
  );
  const r1 = router.routeBatch([lead("L1", "tech", 100)]); // 下界包含 → A
  assert.equal(r1.assignments[0].assignee, "A");
  const r2 = router.routeBatch([lead("L2", "tech", 200)]); // 上界不包含 → C
  assert.equal(r2.assignments[0].assignee, "C");
  const r3 = router.routeBatch([lead("L3", "finance", 150)]); // 行业不同 → B
  assert.equal(r3.assignments[0].assignee, "B");
});

test("均衡值相同：轮转前进步数更少者优先，起点移到被选者下一位", () => {
  // 只有一条线索，候选 B、C 之外的方案均衡值相同；从 A 出发 B 需 1 步、C 需 2 步。
  const onlyBC = new LeadRouter(
    snapshot(
      [
        rep({ id: "A", skills: [{ industry: "other", minBudget: 0, maxBudget: 1 }] }),
        rep({ id: "B", skills: [techAll] }),
        rep({ id: "C", skills: [techAll] }),
      ],
      0,
    ),
  );
  const r = onlyBC.routeBatch([lead("L1", "tech", 100)]);
  assert.equal(r.assignments[0].assignee, "B");
  assert.equal(onlyBC.getState().rotationStart, 2); // B 的下一位是 C
});

test("轮转裁决逐条比较：第一条相同才比较第二条", () => {
  // 甲乙丙丁，起点甲。L1 候选 {乙,丁}，L2 候选 {丙,丁}。
  // 方案 X：L1→乙(1步), L2 起点丙→丙(0步)；方案 Y：L1→丁(3步), L2 起点甲→丙(2步)。
  // 两方案均衡值相同（各两人各得 1 条），X 在第一条步数更少，应选 X。
  const reps = [
    rep({ id: "甲", skills: [{ industry: "none", minBudget: 0, maxBudget: 1 }] }),
    rep({ id: "乙", skills: [techAll] }),
    rep({ id: "丙", skills: [techAll] }),
    rep({ id: "丁", skills: [techAll] }),
  ];
  const router = new LeadRouter(snapshot(reps, 0));
  const r = router.routeBatch([
    lead("L1", "tech", 100), // 候选 乙丙丁 → 最近是乙
    lead("L2", "tech", 100),
  ]);
  assert.deepEqual(
    r.assignments.map((a) => a.assignee),
    ["乙", "丙"],
  );
  assert.equal(router.getState().rotationStart, 3); // 丙的下一位是丁
});

test("无候选人的线索保持未分配，不改变计数与起点", () => {
  const router = new LeadRouter(
    snapshot([rep({ id: "A", skills: [techAll], assignedCount: 5 })], 0),
  );
  const r = router.routeBatch([lead("L1", "unknown", 100), lead("L2", "tech", 100)]);
  assert.equal(r.assignments[0].assignee, null);
  assert.equal(r.assignments[1].assignee, "A");
  const state = router.getState();
  assert.equal(state.reps[0].assignedCount, 6);
  assert.equal(state.rotationStart, 0); // A 是名单末尾，下一位回绕到首位
});

test("暂时不可用成员不参与分配，恢复后历史累计数保留", () => {
  const reps = [
    rep({ id: "A", skills: [techAll], assignedCount: 3 }),
    rep({ id: "B", skills: [techAll], assignedCount: 3, available: false }),
  ];
  const router = new LeadRouter(snapshot(reps, 0));
  const r1 = router.routeBatch([lead("L1", "tech", 100)]);
  assert.equal(r1.assignments[0].assignee, "A"); // B 不可用，只能给 A
  assert.equal(router.getState().reps[1].assignedCount, 3); // 累计数不清零

  // B 恢复可用（通过重新载入状态模拟调用方更新可用性）
  const restored = router.getState();
  restored.reps[1].available = true;
  const router2 = new LeadRouter(restored);
  const r2 = router2.routeBatch([lead("L2", "tech", 100)]);
  assert.equal(r2.assignments[0].assignee, "B"); // A=4、B=3，均衡应选 B
  assert.equal(router2.getState().reps[1].assignedCount, 4);
});

test("多批连续分配与状态读出重载结果一致", () => {
  const initial = snapshot(
    [
      rep({ id: "A", skills: [techAll] }),
      rep({ id: "B", skills: [techAll] }),
      rep({ id: "C", skills: [techAll] }),
    ],
    0,
  );
  const batch1 = [lead("L1", "tech", 100), lead("L2", "tech", 100)];
  const batch2 = [lead("L3", "tech", 100), lead("L4", "tech", 100), lead("L5", "other", 1)];

  // 连续调用
  const continuous = new LeadRouter(initial);
  const c1 = continuous.routeBatch(batch1);
  const c2 = continuous.routeBatch(batch2);
  const continuousState = continuous.getState();

  // 第一批后读出状态，重新载入再跑第二批
  const reloaded = new LeadRouter(initial);
  const r1 = reloaded.routeBatch(batch1);
  const restored = new LeadRouter(reloaded.getState());
  const r2 = restored.routeBatch(batch2);
  const restoredState = restored.getState();

  assert.deepEqual(r1, c1);
  assert.deepEqual(r2, c2);
  assert.deepEqual(restoredState, continuousState);
  assert.deepEqual(
    continuousState.reps.map((r) => r.assignedCount),
    [2, 1, 1],
  );
});

test("相同快照和输入产生相同结果", () => {
  const make = () =>
    new LeadRouter(
      snapshot(
        [
          rep({ id: "A", skills: [techAll], assignedCount: 2 }),
          rep({ id: "B", skills: [techAll], assignedCount: 1 }),
        ],
        1,
      ),
    );
  const leads = [lead("L1", "tech", 10), lead("L2", "tech", 20), lead("L3", "tech", 30)];
  const r1 = make().routeBatch(leads);
  const r2 = make().routeBatch(leads);
  assert.deepEqual(r1, r2);
});

test("末尾成员被选中后起点回绕到首位", () => {
  const router = new LeadRouter(
    snapshot(
      [
        rep({ id: "A", skills: [{ industry: "none", minBudget: 0, maxBudget: 1 }] }),
        rep({ id: "B", skills: [techAll] }),
      ],
      0,
    ),
  );
  const r = router.routeBatch([lead("L1", "tech", 100)]);
  assert.equal(r.assignments[0].assignee, "B");
  assert.equal(router.getState().rotationStart, 0);
});
