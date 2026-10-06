/** 单选题定义（发布新版本时传入） */
export interface QuestionInput {
  text: string;
  options: string[];
  correctIndex: number;
}

/** 某一天的挑战内容 */
export interface DayChallenge {
  day: number; // 1..90
  questions: QuestionInput[];
}

/** 发布挑战版本的入参：固定覆盖第 1 至 90 天 */
export interface PublishInput {
  days: DayChallenge[];
}

/** 读取挑战时返回的题目（不含正确答案） */
export interface PublicQuestion {
  text: string;
  options: string[];
}

export interface PublicDayChallenge {
  day: number;
  questions: PublicQuestion[];
}

/** 读取当前挑战的结果，必须带回版本标识 */
export interface CurrentChallenge {
  versionId: number;
  days: PublicDayChallenge[];
}

/** 提交答题的入参 */
export interface SubmitInput {
  learnerId: string;
  day: number; // 1..90
  versionId: number;
  answers: number[]; // 每题所选选项下标
  occurredAt: Date; // 答题发生时间，可能乱序到达
}

/** 一条完成记录 */
export interface CompletionRecord {
  learnerId: string;
  day: number;
  versionId: number;
  score: number; // 答对题数
  totalQuestions: number;
  baseXp: number;
  occurredAt: string; // ISO
  activeDate: string; // UTC 自然日 YYYY-MM-DD
}

/** 提交答题的返回 */
export interface SubmitResult {
  completion: CompletionRecord;
  xpAwarded: number; // 本次调用新增的 XP（基础 XP + 连续日奖励差额）
  alreadyCompleted: boolean; // 是否命中已有完成记录
}

/** 学员进度 */
export interface Progress {
  learnerId: string;
  completions: CompletionRecord[];
  totalXp: number; // 全部基础 XP + 全部连续日奖励
}
