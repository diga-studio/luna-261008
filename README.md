# 密码修复挑战模块

供训练平台在进程内调用的 TypeScript 库。题目与作答数据仅保存在内存中，无任何外部服务依赖。

## 能力

- `isCompliant(password, challenge)`：判断练习字符串是否达标。
- `suggestRepair(original, challenge)`：返回达标所需的最少修改次数（插入 / 删除 / 替换各计 1 次，全局最优）以及一个恰好以该次数可达的达标字符串。

## 达标规则

- 长度 12–20；字符仅允许小写字母、数字、`!@#`。
- 至少包含一个数字和一个特殊符号。
- 不得出现连续三个相同字符。
- 不得包含题目给出的任何禁用片段（按连续子串判断，每题 0–8 段，每段 2–6 字符）。

## 使用

```ts
import { isCompliant, suggestRepair } from "password-repair-challenge";

isCompliant("abcde12345!@", { bannedFragments: [] }); // true
suggestRepair("aaaaaaaaaa", { bannedFragments: [] });
// { changes: 4, password: "aa!aa0aababa" }（建议字符串可能为其他同等最优解）
```

## 开发

```sh
npm install
npm test        # 编译并运行全部测试（含最大规格 3 秒 / 128 MiB 约束）
npm run build   # 仅编译到 dist/
```
