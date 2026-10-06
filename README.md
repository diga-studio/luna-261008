# config-drift

配置漂移核算库：比较已批准基线与当前快照（均为 UTF-8 JSON 文本），在内存中返回差异报告与合规分数。不做版本管理，不写盘。

## 使用

```ts
import { compareConfigs } from 'config-drift';

const report = compareConfigs(baselineText, currentText, [
  ['services', 'auth', 'permissionId'], // 关键字段登记路径：字符串键与整数下标逐段表示，根为 []
  ['limits', 0],
]);

// report.diffs:  { path, kind: 'added'|'removed'|'modified', severity, baseline?, current? }
// report.counts: { critical, medium, low }
// report.score:  100 起扣，Critical -15 / Medium -5 / Low -2，最低 0
```

## 语义要点

- 数字按精确十进制值比较：`1`、`1.0`、`10e-1` 相等，`-0` 与 `0` 相等；超出浮点精度的相邻整数仍可区分；尾数最长 4096 位、指数绝对值最大 10^9 均为线性时间处理。
- 键与字符串按 JSON 转义解码后的 UTF-16 代码单元序列比较，不做 Unicode 归一化；对象键顺序无关，数组按下标对齐。
- 一侧缺失或类型不同只记录一条差异，不展开子树；缺失与 `null` 严格区分。
- 报告保留两侧原始值，数字保留原始字面量，不舍入。
- 差异与某登记路径存在祖先/后代/相等关系、且该登记路径的值确实变化（两侧都缺失不算变化）时定为 Critical；其余 modified 为 Medium，added/removed 为 Low。

## 开发

```sh
npm install
npm test        # 先 tsc 构建，再跑 node:test 测试
npm run build   # 仅构建到 dist/
```

仅依赖 devDependencies 中的 `typescript` 与 `@types/node`，测试使用 Node 内置 `node:test`，无需任何外部服务。
