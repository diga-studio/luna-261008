# bom-trial

多级 BOM 需求试算库（TypeScript）。由生产计划模块直接以库方式调用，无接口层；
BOM 档案与试算输入由调用方提供，运行数据全部保留在内存。

## 安装与测试

```bash
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>= 18）与开发依赖 typescript / @types/node，无运行时依赖。

## 快速上手

```ts
import { BomArchive, runTrial } from 'bom-trial';

// 1. 装载 BOM 档案（装载一次，可反复试算）
const archive = new BomArchive({
  materials: [
    { materialId: 'A', type: 'manufactured' }, // 普通自制件
    { materialId: 'G', type: 'phantom' },      // 幻影件（只展开，不生产）
    { materialId: 'P', type: 'purchased' },    // 外购件
  ],
  revisions: [
    {
      revisionId: 'A-1',
      materialId: 'A',
      effectiveFrom: '2026-01-01',   // 含当日
      effectiveTo: '2027-01-01',     // 不含当日，可缺省表示永久
      lines: [
        { componentId: 'G', quantity: '0.4', lossRate: '0' },
        { componentId: 'P', quantity: '1' }, // 损耗率缺省 2.5%
      ],
    },
    // ...
  ],
});

// 2. 执行试算（多个根件共用一个生产日期）
const result = runTrial(archive, {
  productionDate: '2026-06-01',
  roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '10' }],
});

// result.production: 普通自制件生产数量（按 物料+修订，整件十进制文本）
// result.consumption: 外购件领料数量（按物料合并，整件十进制文本）
```

## 业务规则摘要

- 普通自制件：合并所有来源需求后向上取整到整件，再按整件数展开自己的 BOM。
- 幻影件：合并所有来源需求，不取整，以精确需求继续展开；不出现在生产数量中。
- 外购件：合并所有来源需求，只在最终领料数量上向上取整。
- 组件需求 = 父件用于展开的数量 × 用量 × (1 + 损耗率 ÷ 100)；同一组件多条明细全部累加。
- 根件须为普通自制件，数量为整数（≤ 10^12），显式指定修订且不受有效期限制；
  展开得到的自制/幻影件按生产日期选择有效修订（生效日含当日，失效日不含当日）。
- 同一物料的不同修订分开核算。
- 根件为第 1 层，展开路径最多 12 层。

## 精确性

所有数量以十进制文本输入/输出。内部使用 bigint 定点运算（缩放 10^12），
极大数量（超过 2^53）与极小尾数（6 位用量小数 × 4 位损耗率小数）均为数学精确，
不会多算或少算一件。

## 失败语义

以下情况整次试算失败，抛出 `TrialError`，不返回部分结果：

- `CYCLE`：本次实际使用的修订在可达路径上形成循环（无关/过期修订中的循环不影响）。
- `MAX_DEPTH`：展开路径到达第 13 层（含共享物料同时经短路径与超深路径到达）。
- `NO_VALID_REVISION`：需要展开的物料在生产日期没有有效修订。
- `INVALID_INPUT`：档案或试算输入不合法（格式、重叠有效期、超上限等）。

## 性能

按 物料+修订 聚合展开，与有效路径条数无关。满规格档案
（20000 物料 / 每物料最多 4 修订 / 全档案 100000 条明细、有效路径超 10 亿条）
单次试算毫秒级完成，新增堆内存约 10 MiB，远低于 5 秒 / 128 MiB 的限制。
