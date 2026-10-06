# OKR Health

TypeScript OKR 健康评分库。数据由调用方（看板 / 历史报表）提供，计算状态只保存在内存，支持任意历史时点的健康分回看。

## 使用

```ts
import { OkrHealthEngine } from 'okr-health';

const engine = new OkrHealthEngine(objectives, krs); // 固定元数据：周期、权重、目标值
engine.loadHistory({ checkIns, reviews });           // 只读历史，顺序任意

engine.scoreObjective('obj-1', T);  // { velocity, frequency, trend, health }
engine.scoreKr('kr-1', T);
engine.scoreBatch(queries);         // 批处理
```

- 时间一律为 UTC 秒，一天 86400 秒；查询时点 T 须位于目标开始满 28 天之后、结束之内（含端点）。
- 评分窗口固定为 T 之前 28 天；T 之后的记录永不参与计算。
- 进度：百分比 /100、数值 /固定目标值、二元 0|1，截断到 [0,1]，允许回退。
- 置信度：1–10 整数，保持上次值（无记录时默认 5.5）；趋势分为窗口内保持值曲线的连续时间最小二乘拟合，`0.5 + 28b/18` 截断到 [0,1]。
- KR 健康分 = 速度 40% + 频率 30% + 趋势 30%；目标分为 KR 按权重（合计 100%）加权。

## 开发

```sh
npm install
npm test        # tsc 构建 + node --test，含 100 万记录 / 5 万查询批处理测试
npm run build   # 仅构建到 dist/
```

无运行时依赖；仅 devDependencies（typescript、@types/node）。
