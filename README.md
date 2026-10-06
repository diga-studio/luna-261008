# SitePlan Studio — 建筑体量挤出组件

将带孔二维多边形（建筑基底）沿正 z 方向挤出为闭合三角网格，供本地设计画布渲染与体积核算。坐标与高度单位为英尺，右手坐标系。

## API

```ts
import { extrude, signedVolume } from "./src";

const mesh = extrude(
  {
    outer: [[0, 0], [12, 0], [12, 8], [0, 8]],
    holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]],
  },
  10, // height，必须为正
);
// mesh = { vertices: [x,y,z][], triangles: [i,j,k][] }
// 底面 z=0，顶面 z=height；外壁朝外，孔壁朝洞内；
// 每条无向索引边恰好被两个方向相反的三角形共享。

const volume = signedVolume(mesh); // 朝外定向闭合网格为正
```

输入环的绕行方向与起点任意，可含连续重复点、末尾闭合重复点与连续共线点（组件内部会清洗）。

## 构建与测试

```sh
npm install
npm test   # 编译 TypeScript 并运行 node:test 测试
```

仅依赖 `typescript`（devDependency），测试使用 Node 内置 `node:test`。
