/** 单选题 */
export interface ChallengeQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** 正确选项在 options 中的下标 */
  correctIndex: number;
}

/** 某一天的挑战内容 */
export interface DayChallenge {
  /** 日序，1-90 */
  day: number;
  questions: ChallengeQuestion[];
}

/** 发布挑战版本的入参：完整的 90 天挑战内容 */
export interface PublishChallengeInput {
  days: DayChallenge[];
}

/** 发布结果 */
export interface PublishResult {
  versionId: number;
}

/** 读取到的挑战内容（携带版本标识） */
export interface ChallengeView {
  versionId: number;
  day: number;
  questions: ChallengeQuestion[];
}

/** 提交答题的入参 */
export interface SubmitInput {
  learnerId: string;
  /** 日序，1-90 */
  day: number;
  /** 明确引用的已发布版本 */
  versionId: number;
  /** 与题目一一对应的选项下标 */
  answers: number[];
  /** 答题发生时间（可能乱序到达） */
  occurredAt: Date;
}

/** 一条完成记录 */
export interface CompletionRecord {
  learnerId: string;
  day: number;
  versionId: number;
  /** 答对题数 */
  score: number;
  /** 基础 XP：答对题数*10 + 25 */
  baseXp: number;
  /** 活跃日期（UTC 自然日，YYYY-MM-DD） */
  activeDate: string;
  occurredAt: string;
}

/** 提交答题的返回 */
export interface SubmitResult {
  completion: CompletionRecord;
  /** 本次提交新增的 XP（首次完成为基础 XP + 连续日奖励差额，重复提交为 0） */
  xpGained: number;
  /** 本次新增 XP 中的连续日奖励部分 */
  streakXpGained: number;
  /** 是否为首次完成（false 表示命中已有完成记录） */
  firstCompletion: boolean;
}

/** 学员进度 */
export interface LearnerProgress {
  learnerId: string;
  completions: CompletionRecord[];
  /** 累计 XP = 全部基础 XP + 全部连续日奖励 */
  totalXp: number;
  /** 累计 XP 中的连续日奖励部分 */
  streakXp: number;
  /** 活跃日期列表（UTC 自然日，升序） */
  activeDates: string[];
}
