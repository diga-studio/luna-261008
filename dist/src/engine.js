"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduleEngine = exports.MAX_CAPACITY = exports.MIN_CAPACITY = exports.MAX_BATCH_SIZE = void 0;
const interval_index_1 = require("./interval-index");
exports.MAX_BATCH_SIZE = 200;
exports.MIN_CAPACITY = 1;
exports.MAX_CAPACITY = 50;
function requireCondition(condition, message) {
    if (!condition) {
        throw new Error(`SkillPulse: invalid input — ${message}`);
    }
}
function requireId(value, field) {
    requireCondition(typeof value === 'string' && value.length > 0, `${field} must be a non-empty string`);
}
function validateSessionInput(input, context) {
    requireCondition(typeof input === 'object' && input !== null, `${context}: must be an object`);
    requireId(input.id, `${context}.id`);
    requireId(input.instructorId, `${context}.instructorId`);
    requireId(input.venueId, `${context}.venueId`);
    requireCondition(Number.isInteger(input.start) && Number.isInteger(input.end), `${context}: start/end must be integer minutes`);
    requireCondition(input.start < input.end, `${context}: start must be < end`);
    requireCondition(Number.isInteger(input.capacity) &&
        input.capacity >= exports.MIN_CAPACITY &&
        input.capacity <= exports.MAX_CAPACITY, `${context}.capacity must be an integer in [${exports.MIN_CAPACITY}, ${exports.MAX_CAPACITY}]`);
}
function resourceKey(kind, id) {
    return `${kind}${id}`;
}
function compareResource(a, b) {
    if (a.kind !== b.kind)
        return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * SkillPulse 课表冲突引擎。串行调用、状态驻留内存，无持久化。
 *
 * 状态：
 *  - sessions：场次 id -> 场次记录（含已确认学员集合）；
 *  - instructorIndex / venueIndex / traineeIndex：资源 id -> 该资源的场次区间索引。
 *
 * 所有操作先算完整诊断再提交；失败时不触碰任何状态，天然原子。
 */
class ScheduleEngine {
    constructor() {
        this.sessions = new Map();
        this.instructorIndex = new Map();
        this.venueIndex = new Map();
        this.traineeIndex = new Map();
    }
    /**
     * 一次创建或替换最多 200 个场次，整批原子生效。
     * 替换保留该场次已确认学员；按批次全部生效后的最终课表判定冲突。
     */
    applyScheduleBatch(changes) {
        requireCondition(Array.isArray(changes), 'changes must be an array');
        requireCondition(changes.length <= exports.MAX_BATCH_SIZE, `batch size ${changes.length} exceeds ${exports.MAX_BATCH_SIZE}`);
        const batchIds = new Set();
        for (let i = 0; i < changes.length; i += 1) {
            const change = changes[i];
            validateSessionInput(change, `changes[${i}]`);
            requireCondition(!batchIds.has(change.id), `duplicate session id in batch: ${change.id}`);
            batchIds.add(change.id);
        }
        // 批次内每个场次的最终形态（替换保留已确认学员）。
        const finals = changes.map((change) => {
            const existing = this.sessions.get(change.id);
            return { ...change, trainees: existing !== undefined ? existing.trainees : new Set() };
        });
        // 容量检查：保留的学员数不得超过新容量。
        const capacityViolations = [];
        for (const record of finals) {
            if (record.trainees.size > record.capacity) {
                capacityViolations.push({
                    sessionId: record.id,
                    capacity: record.capacity,
                    enrolled: record.trainees.size,
                });
            }
        }
        const pairs = new Map();
        const addPair = (idA, idB, kind, resourceId) => {
            const lo = idA < idB ? idA : idB;
            const hi = idA < idB ? idB : idA;
            const key = `${lo} ${hi}`;
            let pair = pairs.get(key);
            if (pair === undefined) {
                pair = { sessionIds: [lo, hi], resources: new Map() };
                pairs.set(key, pair);
            }
            pair.resources.set(resourceKey(kind, resourceId), { kind, id: resourceId });
        };
        // 批次内场次两两判定（B <= 200，O(B^2) = O(B)）。
        for (let i = 0; i < finals.length; i += 1) {
            const a = finals[i];
            for (let j = i + 1; j < finals.length; j += 1) {
                const b = finals[j];
                if (a.start >= b.end || b.start >= a.end)
                    continue;
                if (a.instructorId === b.instructorId)
                    addPair(a.id, b.id, 'instructor', a.instructorId);
                if (a.venueId === b.venueId)
                    addPair(a.id, b.id, 'venue', a.venueId);
                const [small, large] = a.trainees.size <= b.trainees.size ? [a, b] : [b, a];
                for (const trainee of small.trainees) {
                    if (large.trainees.has(trainee))
                        addPair(a.id, b.id, 'trainee', trainee);
                }
            }
        }
        // 批次内场次（新区间）对既有课表的判定。索引中批次内场次的旧区间一律跳过，
        // 它们之间的最终冲突已在上面的批内两两判定中覆盖。
        const visit = (sessionId, otherId, kind, resourceId) => addPair(sessionId, otherId, kind, resourceId);
        for (const record of finals) {
            this.instructorIndex
                .get(record.instructorId)
                ?.forEachOverlap(record.start, record.end, batchIds, (otherId) => visit(record.id, otherId, 'instructor', record.instructorId));
            this.venueIndex
                .get(record.venueId)
                ?.forEachOverlap(record.start, record.end, batchIds, (otherId) => visit(record.id, otherId, 'venue', record.venueId));
            for (const trainee of record.trainees) {
                this.traineeIndex
                    .get(trainee)
                    ?.forEachOverlap(record.start, record.end, batchIds, (otherId) => visit(record.id, otherId, 'trainee', trainee));
            }
        }
        if (pairs.size > 0 || capacityViolations.length > 0) {
            const conflicts = [...pairs.values()]
                .map((pair) => ({
                sessionIds: pair.sessionIds,
                resources: [...pair.resources.values()].sort(compareResource),
            }))
                .sort((x, y) => x.sessionIds[0] !== y.sessionIds[0]
                ? x.sessionIds[0] < y.sessionIds[0]
                    ? -1
                    : 1
                : x.sessionIds[1] < y.sessionIds[1]
                    ? -1
                    : x.sessionIds[1] > y.sessionIds[1]
                        ? 1
                        : 0);
            capacityViolations.sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1));
            return { ok: false, conflicts, capacityViolations };
        }
        // 提交：先撤旧区间，再写新区间。
        for (const record of finals) {
            const old = this.sessions.get(record.id);
            if (old !== undefined)
                this.removeFromIndexes(old);
            this.sessions.set(record.id, record);
            this.addToIndexes(record);
        }
        return { ok: true };
    }
    /** 加入或退出指定场次。重复加入/退出为空操作。 */
    setEnrollment(sessionId, traineeId, enrolled) {
        requireId(sessionId, 'sessionId');
        requireId(traineeId, 'traineeId');
        requireCondition(typeof enrolled === 'boolean', 'enrolled must be a boolean');
        const record = this.sessions.get(sessionId);
        requireCondition(record !== undefined, `unknown session: ${sessionId}`);
        if (!enrolled) {
            if (!record.trainees.delete(traineeId))
                return { ok: true };
            this.traineeIndex.get(traineeId)?.remove(sessionId, record.start);
            return { ok: true };
        }
        if (record.trainees.has(traineeId))
            return { ok: true };
        const conflicts = [];
        this.traineeIndex.get(traineeId)?.forEachOverlap(record.start, record.end, null, (otherId, start, end) => {
            conflicts.push({ sessionId: otherId, start, end });
        });
        conflicts.sort((x, y) => (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0));
        let capacityViolation;
        if (record.trainees.size >= record.capacity) {
            capacityViolation = {
                sessionId: record.id,
                capacity: record.capacity,
                enrolled: record.trainees.size,
            };
        }
        if (conflicts.length > 0 || capacityViolation !== undefined) {
            return { ok: false, conflicts, capacityViolation };
        }
        record.trainees.add(traineeId);
        this.indexOf(this.traineeIndex, traineeId).insert(sessionId, record.start, record.end);
        return { ok: true };
    }
    /** 读取当前场次及其已确认学员（学员按字典序）。 */
    getSession(sessionId) {
        requireId(sessionId, 'sessionId');
        const record = this.sessions.get(sessionId);
        if (record === undefined)
            return undefined;
        return {
            id: record.id,
            instructorId: record.instructorId,
            venueId: record.venueId,
            start: record.start,
            end: record.end,
            capacity: record.capacity,
            trainees: [...record.trainees].sort(),
        };
    }
    indexOf(map, resourceId) {
        let index = map.get(resourceId);
        if (index === undefined) {
            index = new interval_index_1.IntervalIndex();
            map.set(resourceId, index);
        }
        return index;
    }
    addToIndexes(record) {
        this.indexOf(this.instructorIndex, record.instructorId).insert(record.id, record.start, record.end);
        this.indexOf(this.venueIndex, record.venueId).insert(record.id, record.start, record.end);
        for (const trainee of record.trainees) {
            this.indexOf(this.traineeIndex, trainee).insert(record.id, record.start, record.end);
        }
    }
    removeFromIndexes(record) {
        this.instructorIndex.get(record.instructorId)?.remove(record.id, record.start);
        this.venueIndex.get(record.venueId)?.remove(record.id, record.start);
        for (const trainee of record.trainees) {
            this.traineeIndex.get(trainee)?.remove(record.id, record.start);
        }
    }
}
exports.ScheduleEngine = ScheduleEngine;
