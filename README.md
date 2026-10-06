# parts-inventory

替代件库存汇总库（TypeScript）。供上层销售模块在进程内直接调用，无接口层、无外部服务。
初始目录、交叉引用和库存全部由调用方通过 API 提供，数据保存在进程内。

## 使用

```ts
import { PartsInventory } from 'parts-inventory';

const inv = new PartsInventory();

// 建立 / 撤销两个 SKU 之间的直接交叉引用（双向、等价关系可传递）
inv.link('SKU-A', 'SKU-B');
inv.unlink('SKU-A', 'SKU-B');

// 设置一个 SKU 在一个仓库的可用量（覆盖旧值，必须是非负整数）
inv.setStock('SKU-A', 'warehouse-1', 100);

// 查询 SKU 所属等价组的汇总：组内 SKU 数量 + 各仓库可用量总和
const summary = inv.query('SKU-A');
// => { skuCount: 3, stock: { 'warehouse-1': 240, 'warehouse-2': 15 } }
```

行为约定：

- 交叉引用是双向等价关系且具有传递性；无引用的 SKU 自成一组。
- 重复建立已有引用、撤销不存在的引用均为空操作；`link`/`unlink` 的端点顺序无关。
- 撤销只移除指定的直接引用：两端仍连通则分组不变，否则拆成各自所在的组。
- 库存按 SKU 独立记账，`setStock` 覆盖旧值；传入负数或非整数会抛出 `RangeError`。
- 查询返回新对象，组内任一成员查询结果相同，每个 SKU 只计算一次。

## 实现要点

- 每个 SKU 映射为连续整数节点；邻接表 + 每节点所属等价组编号。
- 组合并时把较小的组重新编号进较大的组（均摊 O(n log n)）。
- 撤销边时用双向 BFS（总是扩展较小 frontier）判断连通性：相遇则分组不变；
  一侧先耗尽则该侧为较小连通块，整体切分为新组并同步组级库存汇总。
- 组级库存汇总随 `setStock` 增量维护，查询为 O(仓库数)。

## 构建与测试

要求 Node.js >= 22.18（测试直接用 Node 内置 test runner 运行 TypeScript）。

```sh
npm install
npm test          # 先 tsc 构建到 dist/，再运行 test/ 下全部测试
```

测试包括：

- `test/correctness.test.ts` — 带环与多路径引用：删边仍连通时汇总不变、真正拆组时各组数量与库存正确、再次合并不重复累计、端点顺序无关等。
- `test/random.test.ts` — 小规模随机增删引用与库存（含归零），与按当前全部关系重新展开逐 SKU 求和的独立实现逐步比对。
- `test/load.test.ts` — 50 万 SKU / 100 万直接引用 / 25 仓库、含 30 万 SKU 大组的负载测试：
  2000 次关系变更（大组与 1~100 SKU 小组反复建立/解除唯一连接）、20000 次库存设置、
  50000 次查询（90% 指向大组），断言组件操作总耗时 ≤ 30s、峰值 RSS ≤ 768 MiB，
  并最终与独立计算结果全量抽样比对。本机参考结果：组件操作约 120ms，峰值 RSS 约 514 MiB。
