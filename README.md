# 90 天入职挑战结算库

TypeScript + SQLite（Node.js 内置 `node:sqlite`，无原生依赖、无外部服务）。
由上层实例化 `OnboardingChallenge` 并调用；挑战版本、完成记录与 XP 全部持久化到 SQLite 文件。

## 要求

- Node.js >= 22.5（`node:sqlite` 内置模块）

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再运行 node:test 测试
```

## API

```ts
import { OnboardingChallenge } from "onboarding-challenge";

const lib = new OnboardingChallenge("data/challenge.db");

// 1. 发布挑战版本（固定 90 天，单选题），返回版本标识
const versionId = lib.publishChallengeVersion({ days: [...] });

// 2. 读取当前挑战（带回 versionId，不含正确答案）
const current = lib.getCurrentChallenge();

// 3. 提交答题（明确引用某个已发布版本，按该版本计分）
const result = lib.submitAnswers({
  learnerId: "u123",
  day: 5,
  versionId,
  answers: [0, 2],
  occurredAt: new Date(), // 可信的答题发生时间，允许乱序到达
});
// result.completion — 首次结算的完成记录（版本/得分/基础XP/活跃日期）
// result.xpAwarded — 本次调用新增 XP（重复提交恒为 0）
// result.alreadyCompleted — 是否命中已有完成记录

// 4. 查看学员进度（完成记录 + 累计 XP）
const progress = lib.getProgress("u123");
```

## 结算规则

- 每答对一题 10 XP，完整提交另奖 25 XP（全错也算完成）；仅首次完成产生基础 XP。
- 同一学员同一天挑战只结算一次；之后换答案/换版本/换时间均返回原结果，新增 XP 为 0。
- 活跃日期 = 首次完成所携带时间的 UTC 自然日；同一天多个挑战只算一个活跃日。
- 全部活跃日期划分为最大连续段，每段每满 7 天奖 50 XP（余数不跨段累计）；
  迟到记录补齐断档后按合并后的连续段重算，只补尚未获得的差额。
- 累计 XP 恒等于全部基础 XP + 全部连续日奖励（`xp_events` 流水求和）。
