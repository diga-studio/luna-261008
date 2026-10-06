# task26100851

替代件库存汇总库（TypeScript，纯进程内，无接口层），供上层销售模块直接调用。

## 使用

```ts
import { InventoryAggregator } from "./src/index";

const agg = new InventoryAggregator();
agg.link("sku-a", "sku-b");          // 建立直接引用（双向、可传递）
agg.setStock("sku-a", "wh-1", 10);   // 覆盖设置某仓库可用量（非负整数）
agg.query("sku-b");                  // => { skuCount, totals: Map<仓库, 总量> }
agg.unlink("sku-a", "sku-b");        // 撤销直接引用（仅撤销指定的一条）
```

- 等价组按交叉引用的连通分量维护；撤销引用后若仍连通则分组不变，否则拆成各自的分量。
- 查询返回组内不同 SKU 数量及各仓库可用量总和；任一成员查询结果相同，每个 SKU 只计入一次。
- 重复 `link` / 撤销不存在的 `unlink` 为无操作；`setStock` 覆盖旧值，非法数量抛 `RangeError`。

## 实现要点

- SKU / 仓库标识在内部映射为连续整数，邻接表、库存、组归属都按整数索引存放。
- `link`：把较小的组合并进较大的组（按成员数），库存总和按仓库相加。
- `unlink`：删除边后从两端做双向 BFS，每轮扩展较小的一侧；相遇则仍连通，
  某一侧先遍历完则该侧构成新组并相应扣减原组的库存总和。
  因此“大组与小组之间唯一连接”的拆合代价与小组规模成正比。
- 库存按 SKU 稀疏记账（只存非零），组内各仓库总量随 `setStock` 增量维护。

## 构建与测试

```sh
npm install
npm test        # 正确性测试 + 随机差分测试（对照独立重算实现）
npm run test:load  # 负载测试：50 万 SKU / 约 100 万引用 / 25 仓库 / 30 万大组
```

只依赖 Node.js 内置模块与 `typescript` 开发依赖，不需要 Docker、数据库或任何监听端口的服务。
