import { ChallengeQuestion, DayChallenge, JOURNEY_DAYS } from "../src";

export interface JourneyOptions {
  questionsPerDay?: number;
  /** 每题正确选项下标，缺省为 0 */
  correctIndex?: number;
  optionCount?: number;
}

/** 生成覆盖第 1-90 天的完整旅程 */
export function makeJourney(options: JourneyOptions = {}): DayChallenge[] {
  const questionsPerDay = options.questionsPerDay ?? 3;
  const correctIndex = options.correctIndex ?? 0;
  const optionCount = options.optionCount ?? 4;
  const days: DayChallenge[] = [];
  for (let day = 1; day <= JOURNEY_DAYS; day += 1) {
    const questions: ChallengeQuestion[] = [];
    for (let q = 0; q < questionsPerDay; q += 1) {
      questions.push({
        id: `d${day}q${q}`,
        prompt: `Day ${day} question ${q}`,
        options: Array.from({ length: optionCount }, (_, i) => `option-${i}`),
        correctIndex,
      });
    }
    days.push({ day, questions });
  }
  return days;
}

/** 全部答对的答案 */
export function allCorrect(journey: DayChallenge[], day: number): number[] {
  return journey[day - 1].questions.map((q) => q.correctIndex);
}

/** 全部答错的答案（选正确选项之外的第一个选项） */
export function allWrong(journey: DayChallenge[], day: number): number[] {
  return journey[day - 1].questions.map((q) => (q.correctIndex + 1) % q.options.length);
}

/** 由 UTC 日期字符串（YYYY-MM-DD）构造当天中午的时间，避免时区边界 */
export function atDay(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}
