# password-repair-challenge

密码修复挑战模块：由训练平台调用的进程内 TypeScript 库。题目与作答数据
仅保存在内存中，模块不读写磁盘、不监听端口、不保留任何求解状态。

## 能力

- `checkCompliance(candidate, challenge)`：判断练习字符串是否达标。
- `suggestRepair(source, challenge)`：返回达标所需的最少修改次数
  （全局最优编辑距离）及一个恰好以该次数可达的达标字符串。

## 规则

- 允许字符：小写字母、数字、`!@#`。
- 达标串长度 12 至 20，至少含一个数字和一个特殊符号，无连续三个相同
  字符，不包含题目的任何禁用片段（按连续子串判断）。
- 一次修改为插入 / 删除 / 替换一个字符，代价均为 1。
- 原字符串可为空，最长 32 字符；禁用片段 0 至 8 个，每段 2 至 6 字符。
- 非法输入抛出 `Error`；练习串含非法字符时 `checkCompliance` 返回
  `false`。

## 用法

```ts
import { checkCompliance, suggestRepair } from "password-repair-challenge";

const challenge = { forbiddenFragments: ["aa"] };

checkCompliance("abc1!defghij", challenge);
// => true

suggestRepair("aaaaaaaaaaaa", challenge);
// => { minEdits: 6, suggestion: "!a0ababababa" }（多个最优解时任选其一）
```

## 实现要点

最少修改次数通过对“编辑过程 × 达标约束”的乘积状态空间做一次 DAG
动态规划求得：状态为（已消费原串长度、已生成长度、字符类型标志、
Aho-Corasick 自动机节点），其中禁用片段与“连续三个相同字符”统一编入
自动机。所有转移使已消费与已生成之和恰好多 1，因此按该和递增顺序
递推即得全局最优，并沿父指针回溯出一个最优达标串。全部状态为函数
局部变量，求解结束即释放。

## 开发

```sh
npm install   # 仅需 Node.js，安装 typescript 与 @types/node
npm test      # 编译并运行全部测试（含性能与内存用例）
npm run build # 仅编译到 dist/
```
