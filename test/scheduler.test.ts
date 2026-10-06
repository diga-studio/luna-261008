import test from "node:test";
import assert from "node:assert/strict";
import { SkillPulseScheduler } from "../src/scheduler";
import { BatchChange, SchedulerConfig, Session } from "../src/types";

const T0 = 1_000_000;

function makeConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    instructors: [
      { id: "instructor-a", availability: [{ start: T0, end: T0 + 10_000 }] },
      { id: "instructor-b", availability: [{ start: T0, end: T0 + 10_000 }] },
    ],
    venues: [{ id: "venue-1", capacity: 100 }],
    sessions: [],
    ...overrides,
  };
}

test("互换教员和时段：单项替换冲突，整批成功", () => {
  // session-1: instructor-a [0,100)；session-2: instructor-b [200,300)
  // 目标：session-1 换成 instructor-b [200,300)，session-2 换成 instructor-a [0,100)
  // 任意一项单独替换都会与另一场冲突（教员容量为 1），整批同时替换则合法。
  const session1: Session = {
    id: "session-1",
    start: T0,
    end: T0 + 100,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["trainee-1"],
  };
  const session2: Session = {
    id: "session-2",
    start: T0 + 200,
    end: T0 + 300,
    instructorId: "instructor-b",
    venueId: "venue-1",
    traineeIds: ["trainee-2"],
  };
  const scheduler = new SkillPulseScheduler(
    makeConfig({ sessions: [session1, session2] }),
  );

  const swapped1: Session = { ...session1, start: T0 + 200, end: T0 + 300, instructorId: "instructor-b" };
  const swapped2: Session = { ...session2, start: T0, end: T0 + 100, instructorId: "instructor-a" };

  // 单项替换：与未替换的另一场冲突
  const singleReport = scheduler.checkBatch([{ kind: "replace", session: swapped1 }]);
  assert.ok(singleReport.conflicts.length > 0);
  assert.ok(
    singleReport.conflicts.some(
      (c) => c.type === "overbooked" && c.resourceKind === "instructor" && c.resourceId === "instructor-b",
    ),
  );

  // 整批互换：无冲突，且与输入顺序无关
  const batch: BatchChange[] = [
    { kind: "replace", session: swapped1 },
    { kind: "replace", session: swapped2 },
  ];
  const reversed: BatchChange[] = [...batch].reverse();
  assert.deepEqual(scheduler.checkBatch(batch), { conflicts: [] });
  assert.deepEqual(scheduler.checkBatch(reversed), { conflicts: [] });

  const result = scheduler.applyBatch(batch);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(scheduler.getSession("session-1"), swapped1);
  assert.deepEqual(scheduler.getSession("session-2"), swapped2);
});

test("末项制造冲突：整批不落地，checkBatch 无副作用", () => {
  const existing: Session = {
    id: "existing",
    start: T0,
    end: T0 + 100,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["trainee-1"],
  };
  const scheduler = new SkillPulseScheduler(makeConfig({ sessions: [existing] }));

  const added: Session = {
    id: "added",
    start: T0 + 500,
    end: T0 + 600,
    instructorId: "instructor-b",
    venueId: "venue-1",
    traineeIds: ["trainee-2"],
  };
  const replaced: Session = { ...existing, end: T0 + 50 };
  // 末项：与 existing（替换后为 [T0, T0+50)）重叠且同学员 → overbooked
  const conflicting: Session = {
    id: "conflicting",
    start: T0 + 10,
    end: T0 + 20,
    instructorId: "instructor-b",
    venueId: "venue-1",
    traineeIds: ["trainee-1"],
  };

  const batch: BatchChange[] = [
    { kind: "add", session: added },
    { kind: "replace", session: replaced },
    { kind: "add", session: conflicting },
  ];

  const report = scheduler.checkBatch(batch);
  assert.ok(report.conflicts.length > 0);
  // checkBatch 不改变当前日程
  assert.deepEqual(scheduler.getSession("existing"), existing);
  assert.equal(scheduler.getSession("added"), undefined);

  // 判定结果不受批次输入顺序影响
  const shuffled = scheduler.checkBatch([batch[2], batch[0], batch[1]]);
  assert.deepEqual(shuffled, report);

  const result = scheduler.applyBatch(batch);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.report, report);
  }
  // 前面的修改均未落地
  assert.deepEqual(scheduler.getSession("existing"), existing);
  assert.equal(scheduler.getSession("added"), undefined);
  assert.equal(scheduler.getSession("conflicting"), undefined);
});

test("三场叠加才超容 + 首尾相接 + 1ms 间隙 + 相邻可用时段", () => {
  // 场地容量 10：三场课学员数为 6、6、6，任意两场之和 12 > 10？
  // 需要任意两场不超容、三场才超容：6+6=12 超了。
  // 取 4、4、4：两两之和 8 ≤ 10，三场之和 12 > 10。
  const config = makeConfig({
    instructors: [
      // 相邻可用时段：[T0, T0+100) 与 [T0+100, T0+300)，并集覆盖 [T0, T0+300)
      {
        id: "instructor-a",
        availability: [
          { start: T0, end: T0 + 100 },
          { start: T0 + 100, end: T0 + 300 },
        ],
      },
      { id: "instructor-b", availability: [{ start: T0, end: T0 + 10_000 }] },
      { id: "instructor-c", availability: [{ start: T0, end: T0 + 10_000 }] },
    ],
    venues: [{ id: "venue-1", capacity: 10 }],
  });
  const scheduler = new SkillPulseScheduler(config);

  // s1 [0,100) 与 s2 [100,200) 首尾相接（不重叠），s3 [201,300) 与 s2 间隔 1ms（不重叠）
  // 但三者都覆盖不到同一时刻……需要三场同时段叠加才超容：
  // 改为：s1 [0,200)，s2 [100,300)，s3 [150,250)，两两重叠处负载 8 ≤ 10，三者交集 [150,200) 负载 12 > 10
  const s1: Session = {
    id: "s1",
    start: T0,
    end: T0 + 200,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t1", "t2", "t3", "t4"],
  };
  const s2: Session = {
    id: "s2",
    start: T0 + 100,
    end: T0 + 300,
    instructorId: "instructor-b",
    venueId: "venue-1",
    traineeIds: ["t5", "t6", "t7", "t8"],
  };
  const s3: Session = {
    id: "s3",
    start: T0 + 150,
    end: T0 + 250,
    instructorId: "instructor-c",
    venueId: "venue-1",
    traineeIds: ["t9", "t10", "t11", "t12"],
  };

  // 任意两场叠加不超容
  assert.deepEqual(scheduler.checkBatch([{ kind: "add", session: s1 }, { kind: "add", session: s2 }]), { conflicts: [] });
  assert.deepEqual(scheduler.checkBatch([{ kind: "add", session: s1 }, { kind: "add", session: s3 }]), { conflicts: [] });
  assert.deepEqual(scheduler.checkBatch([{ kind: "add", session: s2 }, { kind: "add", session: s3 }]), { conflicts: [] });

  // 三场叠加：[T0+150, T0+200) 负载 12 > 10
  const report = scheduler.checkBatch([
    { kind: "add", session: s1 },
    { kind: "add", session: s2 },
    { kind: "add", session: s3 },
  ]);
  assert.deepEqual(report.conflicts, [
    {
      type: "overbooked",
      resourceKind: "venue",
      resourceId: "venue-1",
      start: T0 + 150,
      end: T0 + 200,
      load: 12,
      capacity: 10,
      sessionIds: ["s1", "s2", "s3"],
    },
  ]);

  // 首尾相接不算重叠：s1 [0,200) 与 tail [200,300) 共占 instructor-a 不冲突
  const tail: Session = {
    id: "tail",
    start: T0 + 200,
    end: T0 + 300,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t13"],
  };
  assert.deepEqual(
    scheduler.checkBatch([{ kind: "add", session: s1 }, { kind: "add", session: tail }]),
    { conflicts: [] },
  );

  // 1ms 间隙不算重叠：s1 [0,200) 与 gap [201,300) 共占 instructor-a 不冲突
  const gap: Session = {
    id: "gap",
    start: T0 + 201,
    end: T0 + 300,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t13"],
  };
  assert.deepEqual(
    scheduler.checkBatch([{ kind: "add", session: s1 }, { kind: "add", session: gap }]),
    { conflicts: [] },
  );

  // 相邻可用时段按并集判断：instructor-a 的 [0,100)+[100,300) 覆盖 s1 [0,200)，无 unavailable
  // 超出并集的部分才报 unavailable：s4 [250,400) 在 [300,400) 不可用
  const s4: Session = {
    id: "s4",
    start: T0 + 250,
    end: T0 + 400,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t14"],
  };
  const unavailableReport = scheduler.checkBatch([{ kind: "add", session: s4 }]);
  assert.deepEqual(unavailableReport.conflicts, [
    {
      type: "unavailable",
      resourceKind: "instructor",
      resourceId: "instructor-a",
      start: T0 + 300,
      end: T0 + 400,
      sessionIds: ["s4"],
    },
  ]);
});

test("删除释放全部占用；同一教员同时违反两类规则时两类都报告", () => {
  const config = makeConfig({
    instructors: [
      // instructor-a 仅在 [T0, T0+50) 可用
      { id: "instructor-a", availability: [{ start: T0, end: T0 + 50 }] },
      { id: "instructor-b", availability: [{ start: T0, end: T0 + 10_000 }] },
    ],
  });
  const scheduler = new SkillPulseScheduler(config);

  // 两场同时段课都占 instructor-a，且时段超出其可用范围：
  // 同时触发 overbooked（负载 2 > 1）与 unavailable（[50,100) 不可用）
  const s1: Session = {
    id: "s1",
    start: T0,
    end: T0 + 100,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t1"],
  };
  const s2: Session = {
    id: "s2",
    start: T0,
    end: T0 + 100,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t2"],
  };
  const batch: BatchChange[] = [
    { kind: "add", session: s1 },
    { kind: "add", session: s2 },
  ];
  const report = scheduler.checkBatch(batch);
  assert.deepEqual(report.conflicts, [
    {
      type: "overbooked",
      resourceKind: "instructor",
      resourceId: "instructor-a",
      start: T0,
      end: T0 + 100,
      load: 2,
      capacity: 1,
      sessionIds: ["s1", "s2"],
    },
    {
      type: "unavailable",
      resourceKind: "instructor",
      resourceId: "instructor-a",
      start: T0 + 50,
      end: T0 + 100,
      sessionIds: ["s1"],
    },
    {
      type: "unavailable",
      resourceKind: "instructor",
      resourceId: "instructor-a",
      start: T0 + 50,
      end: T0 + 100,
      sessionIds: ["s2"],
    },
  ]);

  // 删除其中一场后，另一场只剩 unavailable，不再 overbooked
  const afterDelete = scheduler.checkBatch([
    { kind: "add", session: s1 },
    { kind: "add", session: s2 },
    // 同批中 id 唯一，先加后删同 id 不允许；改为验证已提交后的删除
  ]);
  assert.deepEqual(afterDelete, report);

  // 提交 s1（单独提交有 unavailable 冲突，故用无冲突场景验证删除释放）
  const okScheduler = new SkillPulseScheduler(makeConfig());
  const keep: Session = {
    id: "keep",
    start: T0,
    end: T0 + 100,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t1"],
  };
  const gone: Session = {
    id: "gone",
    start: T0 + 200,
    end: T0 + 300,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t2"],
  };
  assert.deepEqual(okScheduler.applyBatch([
    { kind: "add", session: keep },
    { kind: "add", session: gone },
  ]), { ok: true });

  // 删除 gone 后，新场次复用其教员与时段不再冲突
  const reuse: Session = {
    id: "reuse",
    start: T0 + 200,
    end: T0 + 300,
    instructorId: "instructor-a",
    venueId: "venue-1",
    traineeIds: ["t2"],
  };
  assert.deepEqual(
    okScheduler.applyBatch([
      { kind: "delete", sessionId: "gone" },
      { kind: "add", session: reuse },
    ]),
    { ok: true },
  );
  assert.equal(okScheduler.getSession("gone"), undefined);
  assert.deepEqual(okScheduler.getSession("reuse"), reuse);
});
