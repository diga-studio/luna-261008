/** 资源域：教师、场地、学员三个独立域。 */
export type ResourceKind = 'instructor' | 'venue' | 'trainee';
export interface ResourceRef {
    kind: ResourceKind;
    id: string;
}
/** 场次输入（创建或替换）。时间为整数分钟，区间左闭右开 [start, end)。 */
export interface SessionInput {
    id: string;
    instructorId: string;
    venueId: string;
    start: number;
    end: number;
    capacity: number;
}
/** 场次当前状态（含已确认学员）。 */
export interface SessionView {
    id: string;
    instructorId: string;
    venueId: string;
    start: number;
    end: number;
    capacity: number;
    trainees: string[];
}
/** 一对时间重叠且共享资源的场次。每个共享资源只报告一次。 */
export interface ConflictPair {
    /** 两个场次 id，按字典序排列。 */
    sessionIds: [string, string];
    /** 共享的冲突资源，按 (kind, id) 排序，每个资源恰好一次。 */
    resources: ResourceRef[];
}
/** 报名人数超过容量。 */
export interface CapacityViolation {
    sessionId: string;
    capacity: number;
    enrolled: number;
}
export interface BatchSuccess {
    ok: true;
}
export interface BatchFailure {
    ok: false;
    /** 最终课表中至少一端属于本批次的所有重叠场次对，按 sessionIds 排序。 */
    conflicts: ConflictPair[];
    /** 批次内容量不足的场次，按 sessionId 排序。 */
    capacityViolations: CapacityViolation[];
}
export type BatchResult = BatchSuccess | BatchFailure;
export interface EnrollmentSuccess {
    ok: true;
}
export interface EnrollmentFailure {
    ok: false;
    /** 该学员时间冲突的全部其他场次，按 sessionId 排序。 */
    conflicts: {
        sessionId: string;
        start: number;
        end: number;
    }[];
    /** 若目标场次容量不足则给出。 */
    capacityViolation?: CapacityViolation;
}
export type EnrollmentResult = EnrollmentSuccess | EnrollmentFailure;
