"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const engine_1 = require("../src/engine");
function session(partial) {
    return {
        instructorId: 'I1',
        venueId: 'V1',
        start: 0,
        end: 60,
        capacity: 2,
        ...partial,
    };
}
(0, node_test_1.default)('batch swap of two sessions succeeds despite intermediate conflicts', () => {
    const engine = new engine_1.ScheduleEngine();
    strict_1.default.ok(engine.applyScheduleBatch([
        session({ id: 's1', start: 0, end: 60 }),
        session({ id: 's2', start: 100, end: 160 }),
    ]).ok);
    strict_1.default.ok(engine.setEnrollment('s1', 'T1', true).ok);
    strict_1.default.ok(engine.setEnrollment('s1', 'T3', true).ok);
    strict_1.default.ok(engine.setEnrollment('s2', 'T2', true).ok);
    // 交换时间：同一教师，逐场保存必然冲突，整批判定必须成功。
    const swapped = engine.applyScheduleBatch([
        session({ id: 's1', start: 100, end: 160 }),
        session({ id: 's2', start: 0, end: 60 }),
    ]);
    strict_1.default.deepEqual(swapped, { ok: true });
    strict_1.default.equal(engine.getSession('s1')?.start, 100);
    strict_1.default.equal(engine.getSession('s2')?.start, 0);
    // 替换保留已确认学员。
    strict_1.default.deepEqual(engine.getSession('s1')?.trainees, ['T1', 'T3']);
    strict_1.default.deepEqual(engine.getSession('s2')?.trainees, ['T2']);
});
(0, node_test_1.default)('failed batch (capacity violation) leaves sessions, enrollments and indexes untouched', () => {
    const engine = new engine_1.ScheduleEngine();
    engine.applyScheduleBatch([
        session({ id: 's1', start: 0, end: 60 }),
        session({ id: 's2', start: 100, end: 160 }),
    ]);
    engine.setEnrollment('s1', 'T1', true);
    engine.setEnrollment('s1', 'T3', true);
    engine.setEnrollment('s2', 'T2', true);
    engine.applyScheduleBatch([
        session({ id: 's1', start: 100, end: 160 }),
        session({ id: 's2', start: 0, end: 60 }),
    ]);
    // 交换回去 + 把 s1 容量改为 1（已有 2 名学员）=> 整批失败。
    const failed = engine.applyScheduleBatch([
        session({ id: 's1', start: 0, end: 60, capacity: 1 }),
        session({ id: 's2', start: 100, end: 160 }),
    ]);
    strict_1.default.equal(failed.ok, false);
    strict_1.default.deepEqual(failed.capacityViolations, [
        { sessionId: 's1', capacity: 1, enrolled: 2 },
    ]);
    strict_1.default.deepEqual(failed.conflicts, []);
    // 状态保持交换后的样子，未被失败批次改动。
    strict_1.default.deepEqual(engine.getSession('s1'), {
        id: 's1', instructorId: 'I1', venueId: 'V1', start: 100, end: 160,
        capacity: 2, trainees: ['T1', 'T3'],
    });
    strict_1.default.deepEqual(engine.getSession('s2'), {
        id: 's2', instructorId: 'I1', venueId: 'V1', start: 0, end: 60,
        capacity: 2, trainees: ['T2'],
    });
    // 后续报名证明索引无残留：s2 在 [0,60)，s1 在 [100,160)。
    strict_1.default.ok(engine.setEnrollment('s2', 'T4', true).ok);
    // 新场次占用 [100,160) 必须与 s1 冲突（证明 s1 新区间在索引中）。
    const clash = engine.applyScheduleBatch([
        session({ id: 's3', start: 120, end: 180 }),
    ]);
    strict_1.default.equal(clash.ok, false);
    strict_1.default.deepEqual(clash.conflicts, [
        { sessionIds: ['s1', 's3'], resources: [{ kind: 'instructor', id: 'I1' }, { kind: 'venue', id: 'V1' }] },
    ]);
    // [0,60) 与 s2 冲突、[60,100) 空闲：旧区间没有残留。
    strict_1.default.ok(engine.applyScheduleBatch([session({ id: 's4', start: 60, end: 100 })]).ok);
});
(0, node_test_1.default)('long interval over short ones: full diagnostics, shared resources, adjacency', () => {
    const engine = new engine_1.ScheduleEngine();
    engine.applyScheduleBatch([
        session({ id: 'x1', instructorId: 'I1', venueId: 'V1', start: 400, end: 460, capacity: 5 }),
        session({ id: 'e1', instructorId: 'I1', venueId: 'V1', start: 100, end: 160, capacity: 5 }),
        session({ id: 'e2', instructorId: 'I2', venueId: 'V1', start: 200, end: 260 }),
        session({ id: 'x2', instructorId: 'I3', venueId: 'V3', start: 500, end: 560 }),
        // 与 x1 新区间首尾相接：不算重叠。
        session({ id: 'e3', instructorId: 'I1', venueId: 'V1', start: 300, end: 360 }),
        session({ id: 'e4', instructorId: 'I1', venueId: 'V1', start: 40, end: 50 }),
    ]);
    engine.setEnrollment('x1', 'T1', true);
    engine.setEnrollment('x1', 'T2', true);
    engine.setEnrollment('e1', 'T1', true);
    engine.setEnrollment('e1', 'T2', true);
    const failed = engine.applyScheduleBatch([
        session({ id: 'x1', instructorId: 'I1', venueId: 'V1', start: 50, end: 300, capacity: 5 }),
        session({ id: 'x2', instructorId: 'I1', venueId: 'V2', start: 150, end: 250 }),
    ]);
    strict_1.default.equal(failed.ok, false);
    strict_1.default.deepEqual(failed.capacityViolations, []);
    strict_1.default.deepEqual(failed.conflicts, [
        {
            sessionIds: ['e1', 'x1'],
            resources: [
                { kind: 'instructor', id: 'I1' },
                { kind: 'trainee', id: 'T1' },
                { kind: 'trainee', id: 'T2' },
                { kind: 'venue', id: 'V1' },
            ],
        },
        { sessionIds: ['e1', 'x2'], resources: [{ kind: 'instructor', id: 'I1' }] },
        { sessionIds: ['e2', 'x1'], resources: [{ kind: 'venue', id: 'V1' }] },
        { sessionIds: ['x1', 'x2'], resources: [{ kind: 'instructor', id: 'I1' }] },
    ]);
    // 失败后原状态不变。
    strict_1.default.equal(engine.getSession('x1')?.start, 400);
    strict_1.default.equal(engine.getSession('x2')?.start, 500);
    // 首尾相接可以成功：x1 改为 [360,400) 与 e3 [300,360) 相邻、与自身旧区间相邻。
    strict_1.default.ok(engine.applyScheduleBatch([
        session({ id: 'x1', instructorId: 'I1', venueId: 'V1', start: 360, end: 400, capacity: 5 }),
    ]).ok);
});
(0, node_test_1.default)('enrollment: no-ops, conflicts, capacity, failure atomicity', () => {
    const engine = new engine_1.ScheduleEngine();
    engine.applyScheduleBatch([
        session({ id: 's1', instructorId: 'I1', venueId: 'V1', start: 0, end: 40, capacity: 1 }),
        session({ id: 's4', instructorId: 'I4', venueId: 'V4', start: 40, end: 80, capacity: 1 }),
        session({ id: 's2', instructorId: 'I2', venueId: 'V2', start: 30, end: 50, capacity: 2 }),
        session({ id: 's3', instructorId: 'I3', venueId: 'V3', start: 80, end: 120, capacity: 1 }),
    ]);
    strict_1.default.ok(engine.setEnrollment('s1', 'T1', true).ok);
    // 重复加入是空操作。
    strict_1.default.deepEqual(engine.setEnrollment('s1', 'T1', true), { ok: true });
    // 相邻区间 [40,80) 不与 [0,40) 冲突。
    strict_1.default.ok(engine.setEnrollment('s4', 'T1', true).ok);
    // [80,120) 与 [40,80) 相邻，也不冲突。
    strict_1.default.ok(engine.setEnrollment('s3', 'T1', true).ok);
    // 时间冲突：报告该学员的全部冲突场次（s1 与 s4 都与 s2 重叠）。
    const conflict = engine.setEnrollment('s2', 'T1', true);
    strict_1.default.equal(conflict.ok, false);
    strict_1.default.deepEqual(conflict.conflicts, [
        { sessionId: 's1', start: 0, end: 40 },
        { sessionId: 's4', start: 40, end: 80 },
    ]);
    strict_1.default.equal(conflict.capacityViolation, undefined);
    // 失败的加入不产生任何状态变化。
    strict_1.default.deepEqual(engine.getSession('s2')?.trainees, []);
    // 容量不足。
    const full = engine.setEnrollment('s1', 'T2', true);
    strict_1.default.equal(full.ok, false);
    strict_1.default.deepEqual(full.conflicts, []);
    strict_1.default.deepEqual(full.capacityViolation, { sessionId: 's1', capacity: 1, enrolled: 1 });
    // 同时存在冲突与容量问题时两者都报告：s4 容量 1 已有 T1；
    // 先让 T5 进入与 s4 重叠的 s2，再加入 s4 时既冲突又超容。
    strict_1.default.ok(engine.setEnrollment('s2', 'T5', true).ok);
    const both = engine.setEnrollment('s4', 'T5', true);
    strict_1.default.equal(both.ok, false);
    strict_1.default.deepEqual(both.conflicts, [{ sessionId: 's2', start: 30, end: 50 }]);
    strict_1.default.deepEqual(both.capacityViolation, { sessionId: 's4', capacity: 1, enrolled: 1 });
    // 重复退出是空操作；退出后可再加入。
    strict_1.default.deepEqual(engine.setEnrollment('s1', 'T9', false), { ok: true });
    strict_1.default.ok(engine.setEnrollment('s1', 'T1', false).ok);
    strict_1.default.deepEqual(engine.getSession('s1')?.trainees, []);
    strict_1.default.ok(engine.setEnrollment('s1', 'T2', true).ok);
});
(0, node_test_1.default)('input validation throws on malformed usage', () => {
    const engine = new engine_1.ScheduleEngine();
    strict_1.default.throws(() => engine.applyScheduleBatch([session({ id: 'a', capacity: 0 })]));
    strict_1.default.throws(() => engine.applyScheduleBatch([session({ id: 'a', capacity: 51 })]));
    strict_1.default.throws(() => engine.applyScheduleBatch([session({ id: 'a', start: 60, end: 60 })]));
    strict_1.default.throws(() => engine.applyScheduleBatch([session({ id: 'a', start: 0.5, end: 60 })]));
    strict_1.default.throws(() => engine.applyScheduleBatch([session({ id: 'a' }), session({ id: 'a', start: 100, end: 200 })]));
    strict_1.default.throws(() => engine.applyScheduleBatch(Array.from({ length: 201 }, (_, i) => session({ id: `s${i}`, start: i * 60, end: i * 60 + 30 }))));
    strict_1.default.throws(() => engine.setEnrollment('missing', 'T1', true));
    strict_1.default.equal(engine.getSession('missing'), undefined);
});
(0, node_test_1.default)('getSession returns a defensive copy', () => {
    const engine = new engine_1.ScheduleEngine();
    engine.applyScheduleBatch([session({ id: 's1' })]);
    engine.setEnrollment('s1', 'T1', true);
    const view = engine.getSession('s1');
    strict_1.default.ok(view !== undefined);
    view.trainees.push('hacker');
    strict_1.default.deepEqual(engine.getSession('s1')?.trainees, ['T1']);
});
