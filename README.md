# task26100874

驾校多校区近邻检索库（TypeScript）。数据以不可变快照载入，基于单位球面
三维 k-d 树做 best-first 最近邻扩展，最终距离一律采用半径 6371008.8 米的
haversine 球面弧长判定。

## 使用

```ts
import { buildCatalog } from "./src/index.js";

const catalog = buildCatalog(data, zipCenters);
const { hits, examined } = catalog.search({
  zip: "90001",
  radiusM: 50_000,
  k: 10,
  vehicle: "sedan",      // 可选
  priceMin: 22000,       // 可选，USD 整数分，闭区间
  priceMax: 24000,       // 可选
});
```

- `hits`：至多 `k` 家驾校，每项含 `institutionId`、`branchId`、`distanceM`，
  按距离升序、同距按驾校 id 字典序；每家驾校取其合格校区中的最小距离，
  等距时 `branchId` 取校区 id 字典序最小者。
- `examined`：本次查询实际评估的校区次数（重复评估重复计数）。

## 构建与测试

```sh
npm install
npm test
```
