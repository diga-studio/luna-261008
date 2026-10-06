# FencePost 围栏匹配库

内存驻留的地理围栏匹配库，供设备签到流程直接以库形式调用（无接口层）。
支持圆形与多边形围栏，正确处理跨 180 度经线与极点场景，边界计入围栏。

## 构建与测试

```bash
npm install
npm test
```

`npm test` 会先执行 `tsc` 构建（输出到 `dist/`），再用 Node 内置测试运行器跑全部测试。
仅依赖 Node.js 与 `devDependencies` 中的 TypeScript，无其他服务要求。

## API

```ts
import { FenceStore } from './src/index.js';

const store = new FenceStore();

// 整体装载（替换现有全部数据；标识在集合内必须唯一）
store.loadAll([
  { kind: 'circle', id: 'store-001', center: { lat: 31.2, lng: 121.5 }, radiusMeters: 500 },
  {
    kind: 'polygon',
    id: 'store-002',
    vertices: [
      { lat: 0, lng: 179.8 },
      { lat: 0, lng: -179.8 },
      { lat: 1, lng: -179.8 },
      { lat: 1, lng: 179.8 },
    ],
  },
]);

// 按标识替换（形状和位置都可以改变）/ 删除
store.replace({ kind: 'circle', id: 'store-001', center: { lat: 0, lng: 180 }, radiusMeters: 1000 });
store.remove('store-002');

// 查询命中的全部围栏标识（完整、无重复；多个重叠时全部返回）
const hits: string[] = store.query({ lat: 0, lng: 179.99 });
```

## 业务规则

- **圆形围栏**：中心 + 半径（50~5000 米）。距离按半径 6371008.8 米的球面最短距离
  （haversine）计算，允许覆盖极点；180 与 -180 经线视为同一条经线。
- **多边形围栏**：3~20 个顶点，无自交、无孔，允许凹多边形。顶点纬度 ±85 以内；
  相邻顶点经度沿较短方向连续展开，展开后总跨度严格小于 180 度；
  边界是展开后经纬度平面上的直线段（非球面弧线），跨经线多边形覆盖短跨度区域。
- **边界计入**：多边形顶点、边上的点与圆边界上的点均算命中。
- **一致性**：`loadAll` / `replace` / `remove` 返回后，下一次 `query` 立即反映新状态。

非法输入（半径越界、顶点数越界、纬度越界、经度跨度 ≥180、标识为空、
装载时标识重复等）会抛出异常且不会写入集合。

## 代码结构

- `src/types.ts` — 围栏与坐标类型定义
- `src/geo.ts` — 球面距离、圆/多边形包含判定（经度展开、射线法、边界容差）
- `src/fence-store.ts` — 内存集合：装载、替换、删除、查询与输入校验
- `test/helpers.ts` — 独立基准实现（转角和法 + 点到线段距离），与库实现路径不同
- `test/geo.test.ts` — 跨经线圆/凹多边形、极点圆、顶点与边界点等定向场景
- `test/store.test.ts` — 集合操作语义、替换/移动/删除后无旧位置残留、非法输入
- `test/fuzz.test.ts` — 随机围栏（含跨经线、近极点、凹多边形）与基准的交叉验证，
  以及随机替换/删除序列的逐步一致性检查
