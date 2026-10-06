# driving-school-locator

驾校多校区近邻检索库（TypeScript）。数据以不可变快照载入，不支持并发写入与持久化。

## 使用

```ts
import { buildCatalog } from "./src/index.js";

const catalog = buildCatalog(institutions, zipCenters);
const { results, examined } = catalog.search({
  zip: "80301",
  radiusM: 50000,
  k: 10,
  vehicle: "sedan",      // 可选
  priceMin: 20000,       // 可选，USD 整数分，闭区间
  priceMax: 30000,       // 可选
});
// results: [{ institutionId, branchId, distanceM }, ...]
// examined: 本次查询实际评估的校区次数
```

- `buildCatalog(data, zipCenters)`：载入快照，构建索引，返回可复用目录。
- `search(query)`：返回至多 k 家驾校。车辆类别与闭区间价格条件在同一校区上同时成立；
  每家驾校只出现一次，距离取合格校区最小值，等距时校区 id 字典序小者优先；
  结果按距离升序、同距按驾校 id 字典序。
- 距离为半径 6371008.8 米的球面最短弧长（haversine），半径边界包含在内，
  跨 180 度经线走短弧。

## 设计

- 构建期将全部校区扁平化，按三维单位球坐标建立 k-d 树（叶子容量 8，
  每个内部节点记录三维轴对齐包围盒）。
- 查询期用最小堆做最佳优先遍历：节点到查询点的弦长下界换算为弧长下界用于剪枝
  （只读汇总信息，不计入 examined）；叶子内逐校区评估筛选与精确球面距离，
  每个被评估的校区计入 examined。阈值随已发现的第 k 好驾校距离动态收紧，
  不会先截取固定数量最近校区再筛选。
- 最终入选与排序均使用未舍入的精确距离。

## 开发

```sh
npm install
npm test        # tsc 编译 + node --test
npm run build   # 仅编译到 dist/
```

测试包含独立穷举参考实现对照：跨校区筛选不可拼接、同校远近校区、去重取前 k、
高纬度、跨 180 度经线、零半径、等距、半径边界，以及 160000 校区网格上
100 次查询的结果一致性与 examined ≤ 2000 的实际访问量约束。
