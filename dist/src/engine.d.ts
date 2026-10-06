import { BatchResult, EnrollmentResult, SessionInput, SessionView } from './types';
export declare const MAX_BATCH_SIZE = 200;
export declare const MIN_CAPACITY = 1;
export declare const MAX_CAPACITY = 50;
/**
 * SkillPulse 课表冲突引擎。串行调用、状态驻留内存，无持久化。
 *
 * 状态：
 *  - sessions：场次 id -> 场次记录（含已确认学员集合）；
 *  - instructorIndex / venueIndex / traineeIndex：资源 id -> 该资源的场次区间索引。
 *
 * 所有操作先算完整诊断再提交；失败时不触碰任何状态，天然原子。
 */
export declare class ScheduleEngine {
    private readonly sessions;
    private readonly instructorIndex;
    private readonly venueIndex;
    private readonly traineeIndex;
    /**
     * 一次创建或替换最多 200 个场次，整批原子生效。
     * 替换保留该场次已确认学员；按批次全部生效后的最终课表判定冲突。
     */
    applyScheduleBatch(changes: SessionInput[]): BatchResult;
    /** 加入或退出指定场次。重复加入/退出为空操作。 */
    setEnrollment(sessionId: string, traineeId: string, enrolled: boolean): EnrollmentResult;
    /** 读取当前场次及其已确认学员（学员按字典序）。 */
    getSession(sessionId: string): SessionView | undefined;
    private indexOf;
    private addToIndexes;
    private removeFromIndexes;
}
