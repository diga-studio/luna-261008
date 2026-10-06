# credit-scoring

多维信用评分库（TypeScript + SQLite），供商户对客户、客户对商户的双向评级使用，
并据此判断是否限制后续邀评资格。鉴权、评级方向和申诉裁决由调用方完成，
本库接收可信的业务、主体、维度值与撤销指令。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部服务依赖）

## 使用

```bash
npm install
npm test
```

```ts
import { CreditScorer } from './src/index.js';

const scorer = new CreditScorer('credit.db'); // 或 ':memory:'

// 替换该业务的维度权重，标签名表示维度
scorer.configure('shop-1', { service: 1, quality: 2 });

// 追加评级新版本（完整替换此前维度值；整数，0.01 分为单位）
scorer.record('shop-1', 'customer-1', 'rating-1', { service: 5000, quality: 8000 });

// 空映射 = 申诉成功后撤销整条评级（不恢复旧版本）
scorer.record('shop-1', 'customer-1', 'rating-1', {});

// { score, restricted }；未舍入信用分严格小于 40 时 restricted 为 true
const { score, restricted } = scorer.credit('shop-1', 'customer-1');
```

## 评分规则

- 对每个已配置且存在有效观测的维度，先求该主体所有有效逻辑评级在此维度上的
  算术平均，再按配置权重求这些维度平均值的加权平均。
- 没有观测的维度不参与分母；没有任何参与维度时信用分为 100。
- 未配置标签暂不参与评分，但其当前值保留，启用该标签后立即生效。
- 同一逻辑评级只有最新版本贡献分数；所有版本及撤销记录均保留，旧版本不可覆盖。
- 业务之间的评级与配置互不影响；ratingId 在业务内唯一且主体归属不变。
- 计算全程使用精确有理数，保证 39.995 / 40 等边界判断无舍入误差。
