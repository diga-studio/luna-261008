# bom-trial

多级 BOM 需求试算库（TypeScript）。由生产计划模块直接以库方式调用，无接口层；
BOM 档案与试算输入由调用方提供，运行数据全部保留在内存。

## 特性

- 三类物料：外购件 `PURCHASED`、普通自制件 `MANUFACTURED`、幻影件 `PHANTOM`
- BOM 修订按日生效：`[validFrom, validTo)`，生效日含当日、失效日不含当日；同物料修订不重叠（装载时校验）
- 普通自制件合并全部来源需求后向上取整再展开；幻影件合并且不取整精确展开；外购件合并后仅在最终领料取整
- 精确十进制运算（BigInt 定点数）：1e12 级数量与 6 位小数尾数在数学上精确，超出 JS 安全整数范围也不差一件
- 共享子装配按节点聚合（而非逐路径枚举），十亿级有效路径也能在毫秒级完成
- 有效路径循环、到达第 13 层、缺失有效修订均使整次试算失败（抛 `TrialError`），不返回部分需求

## 安装与测试

```sh
npm install
npm test        # 编译 src 与 test 后运行 node:test
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与开发依赖 `typescript`、`@types/node`，无运行时依赖。

## 使用

```ts
import { BomArchive, runTrial } from './src/index.js';

// 1. 装载档案（一次装载，可反复试算；装载时完成全部校验与索引）
const archive = new BomArchive({
  materials: [
    { id: 'A', type: 'MANUFACTURED' },
    { id: 'S', type: 'MANUFACTURED' },
    { id: 'M', type: 'PURCHASED' },
  ],
  revisions: [
    { id: 'RA', materialId: 'A', validFrom: '2026-01-01', validTo: '2027-01-01' },
    { id: 'RS', materialId: 'S', validFrom: '2026-01-01', validTo: '2027-01-01' },
  ],
  lines: [
    { revisionId: 'RA', componentId: 'S', usage: '0.4', lossRate: '0' },
    { revisionId: 'RS', componentId: 'M', usage: '2.5', lossRate: '0' },
  ],
});

// 2. 试算（纯函数，失败抛 TrialError）
const result = runTrial(archive, {
  productionDate: '2026-06-01',
  roots: [
    { materialId: 'A', revisionId: 'RA', quantity: '1' },
    { materialId: 'A', revisionId: 'RA', quantity: '1' },
  ],
});
// result.production: [{ materialId: 'A', revisionId: 'RA', quantity: '2' },
//                     { materialId: 'S', revisionId: 'RS', quantity: '1' }]  (0.8 取整为 1)
// result.issue:     [{ materialId: 'M', quantity: '3' }]                     (2.5 取整为 3)
```

## 规则摘要

- 根件必须是普通自制件，需求为 1 ~ 1000000000000 的整数十进制文本，显式指定修订且不受有效期限制；
  相同物料+修订的多个根件自动合并
- 展开得到的自制件/幻影件按生产日期选择有效修订；同一物料的不同修订分开核算
- 明细组件需求 = 父件展开数量 × 用量 × (1 + 损耗率 ÷ 100)；损耗率缺省 2.5；同组件多条明细全部累加
- 根件为第 1 层，任一展开路径最多 12 层；只判断本次实际使用的修订与可达路径
- 输出数量均为整件十进制文本；不返回幻影件生产数量

## 错误码（`TrialError.code`）

| 代码 | 含义 |
| --- | --- |
| `INVALID_INPUT` | 输入格式/范围非法（数量、日期、用量、损耗率、重叠修订等） |
| `UNKNOWN_MATERIAL` / `UNKNOWN_REVISION` | 引用了不存在的物料/修订 |
| `REVISION_MATERIAL_MISMATCH` | 根件修订不属于该物料 |
| `ROOT_NOT_MANUFACTURED` | 根件不是普通自制件 |
| `NO_EFFECTIVE_REVISION` | 需展开的物料在生产日期下无有效修订 |
| `CYCLE_DETECTED` | 实际使用的有效图存在循环 |
| `DEPTH_EXCEEDED` | 有效展开路径到达第 13 层 |

## 规模与性能

- 支持 20000 个物料、每物料最多 4 个修订、全档案 100000 条明细
- 全规模档案单次试算实测约 55ms（限额 5s），新增堆内存约 2~3 MiB（限额 128 MiB）
- 连续多次试算互不影响（每次试算使用独立的运行上下文）

## 目录结构

- `src/types.ts` — 公开类型与 `TrialError`
- `src/decimal.ts` — BigInt 精确十进制定点数
- `src/archive.ts` — 档案装载、校验与索引（`BomArchive`）
- `src/explode.ts` — 试算引擎（`runTrial`）：图发现、循环/深度检测、拓扑序需求传播
- `test/` — node:test 自动化测试，含与独立分数参照实现的随机对拍
