# cart-offer-quote

餐厅购物车优惠试算库（TypeScript，纯内存，无外部服务依赖）。

## 使用

```ts
import { bestQuote } from './src/index.js';

const result = bestQuote({
  cart: [{ sku: 'A', unitPriceCents: 1000, quantity: 1 }],
  activities: [
    { kind: 'buyXGetY', id: 'g1', thresholdSkus: ['A'], giftSkus: ['B'], x: 1, y: 1 },
    { kind: 'percentOff', id: 'p10', percentOff: 10 },
    { kind: 'fixedOff', id: 'f100', amountOffCents: 100 },
  ],
  stackablePairs: [['g1', 'p10']],
});
// result.payableCents        最低应付金额（整数美分）
// result.selectedActivityIds 选中的活动 id（0~2 个）
// result.allocations         每个买赠活动按 SKU 的门槛品/赠品分配
```

## 规则

- 一次报价最多选两个活动；只有 `stackablePairs` 中明确列出的活动对可叠加。
- 买 X 赠 Y：从购物车分配恰好 X 份门槛品、Y 份赠品；赠品按原价免单；
  每份餐品在所有选中买赠活动中最多承担一个角色。
- 计价顺序：原价总额 − 赠品原价 → 叠乘百分比折后比例（仅最后向下取整到美分，
  内部用 BigInt 精确计算）→ 减固定减免 → 最低为 0。
- 枚举所有合法活动组合与餐品分配，返回最低应付方案。

## 开发

```sh
npm install
npm test        # 构建并运行 node:test 测试
npm run build   # 仅编译到 dist/
```
