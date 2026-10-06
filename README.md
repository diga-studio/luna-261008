# config-drift

配置漂移核算库：比较已批准基线与当前快照（均为 UTF-8 JSON 文本），在内存中返回差异报告与合规分数。不做版本管理。

## 使用

```ts
import { compareConfigs, key, index } from 'config-drift';

const report = compareConfigs(
  '{"perm": 9007199254740992, "limit": 100}',   // 基线 JSON 文本
  '{"perm": 9007199254740993, "limit": 10e1}',  // 当前快照 JSON 文本
  [[key('perm')]],                              // 关键字段登记表（路径语义与差异路径相同）
);
// report.entries: 差异条目（路径、added/removed/modified、严重级别、两侧原始值）
// report.counts:  { critical, medium, low }
// report.score:   100 - 15*critical - 5*medium - 2*low，最低 0
```

## 比较语义

- 数字按精确十进制值比较：`1`、`1.0`、`10e-1` 相等，`-0` 等于 `0`；超出浮点精度的相邻整数仍可区分；尾数至多 4096 位、指数绝对值至多 10^9 也不会物化大数。
- 对象键顺序无关；键与字符串按 JSON 转义解码后的 UTF-16 代码单元比较，不做 Unicode 归一化；数组按下标对齐，顺序变化即漂移。
- 一侧缺失记 `added`/`removed`，类型不同或标量不同记 `modified`，均不展开子树；缺失与 `null` 严格区分。
- 路径段区分对象键（`key('0')`）与数组下标（`index(0)`）；空键、含句点或斜杠的键均可准确定位。
- 报告中的数字保留原始字面量，不舍入。

## 关键字段登记

差异路径与某登记路径存在祖先、后代或相等关系，且该登记路径的值确实变化（两侧都缺失不算变化）时，该差异定为 `critical`；其余 `modified` 为 `medium`，`added`/`removed` 为 `low`。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js 与 TypeScript（devDependency），无运行时依赖。
