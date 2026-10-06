# restaurant-cart-pricing

餐厅购物车优惠试算库（TypeScript，纯内存，无外部服务依赖）。给定购物车、
当前可用的活动及活动间的可叠加关系，枚举所有合法活动组合（最多两个活动）
与餐品分配，返回真实可兑现的最低应付价方案。

## 使用

```bash
npm install
npm test
```

```ts
import { recommendLowestPrice } from "restaurant-cart-pricing";

const result = recommendLowestPrice(
  [
    { sku: "A", unitPriceCents: 1000, quantity: 1 },
    { sku: "B", unitPriceCents: 900, quantity: 1 },
  ],
  [
    {
      type: "buyXGetY",
      id: "act1",
      thresholdSkus: ["A"],
      giftSkus: ["B"],
      x: 1,
      y: 1,
    },
    { type: "percentOff", id: "act2", percent: 10 },
  ],
  [{ activityIdA: "act1", activityIdB: "act2" }]
);
// result.payableCents        最低应付美分（整数）
// result.selectedActivityIds 选中的活动 id
// result.allocations         每个买赠活动按 SKU 的门槛品/赠品分配
```

## 规则

- 一次报价最多选两个不同活动；两个活动只有在 `stackablePairs` 中明确
  列出时才能同时使用；每个活动每单最多用一次。
- 买 X 赠 Y：必须从购物车分配恰好 X 份门槛品与 Y 份赠品；赠品按原价免单；
  每份餐品在所有选中买赠活动中最多承担一个角色。
- 计价顺序：原价总额 − 全部赠品原价 → 叠乘所有百分比活动的折后比例
  （仅最后向下取整到美分，全程整数运算）→ 减去全部固定减免 → 最低为 0。
