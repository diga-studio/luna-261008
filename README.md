# FencePost

围栏匹配库（TypeScript），供上层设备签到流程调用。围栏数据驻留内存，不包含接口层。

## 功能

- 整体装载一份围栏集合（`loadAll`）
- 按标识替换一个围栏，可改变形状和位置（`replace`）
- 删除一个围栏（`remove`）
- 查询一个坐标命中的全部围栏标识（`query`），结果完整、无重复

## 围栏模型

- **圆形围栏**：中心 + 半径（50 ~ 5000 米）。距离按半径 6371008.8 米的球面最短距离（haversine）计算，支持跨 180 度经线、覆盖极点。
- **多边形围栏**：3 ~ 20 个顶点，无自交、无孔，允许凹多边形。顶点纬度 [-85, 85]，相邻顶点经度沿较短方向连续展开，展开后总跨度严格小于 180 度；边界为展开经纬度平面上的直线段。
- 边界（含顶点和边上的点）计入围栏。

## 用法

```ts
import { FenceStore } from "fencepost";

const store = new FenceStore();
store.loadAll([
  { kind: "circle", id: "store-1", center: { lat: 31.2, lon: 121.5 }, radiusMeters: 500 },
  {
    kind: "polygon",
    id: "store-2",
    vertices: [
      { lat: 10, lon: 179 },
      { lat: 10, lon: -179 },
      { lat: 0, lon: -179 },
      { lat: 0, lon: 179 },
    ],
  },
]);

store.query({ lat: 31.2, lon: 121.5 }); // => ["store-1"]
store.replace({ kind: "circle", id: "store-1", center: { lat: 0, lon: 0 }, radiusMeters: 1000 });
store.remove("store-2");
```

## 构建与测试

```sh
npm install
npm test
```

`npm test` 会先执行 `tsc` 构建，再用 Node.js 内置测试运行器跑 `dist/test` 下的全部用例。
