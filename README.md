# refund-split-ledger

支付退款与分账账本库（TypeScript + SQLite），供上层支付平台直接调用。

## 能力

- `recordSettledPayment`：记录已结算支付（商户身份、支付标识、币种、总金额、三方入账金额）。支持
  USD / EUR / GBP，金额以整数分计，单笔不超过 5,000,000 分，三方之和须等于总金额。
- `requestRefund`：申请部分退款。同一支付可多次申请；累计成功金额与未终结申请占额之和不超过总金额。
  幂等键在商户内唯一：同支付同金额重复申请返回原退款；换支付或换金额复用该键会被拒绝；
  失败后以原键重试仍返回原失败结果。
- `receiveRefundResult`：投递渠道结果（`processing` / `succeeded` / `failed`）。结果可重复、可乱序；
  处理中不释放占额，明确失败释放占额，成功将占额转为已退金额且只记账一次；终态后的处理中结果不回退状态。
- `getPaymentView`：查看账本（已退、占额、三方累计应退 / 净入账、不可变资金流水），同一视图属于同一时刻。

## 分账规则

成功退款按**累计成功退款总额**分摊：各方累计应退 = 累计成功退款额 × 该方原始入账 ÷ 支付总额，
先取整数分，剩余分按小数余数从大到小各补 1 分，余数相同按商户、平台、合作方排序。
每次流水记录新旧累计应退之差；差额为负时记为 `refund_reversal` 反向分账调整，不改写旧流水。
资金流水逐币种借贷平衡：结算时从收款清算账户转入三方，成功退款时从三方转入退款清算账户。

## 使用

```ts
import { Ledger } from "refund-split-ledger";

const ledger = new Ledger("./ledger.db");
await ledger.recordSettledPayment({
  merchantId: "m1",
  paymentId: "p1",
  currency: "USD",
  totalAmount: 9,
  splits: { merchant: 5, platform: 3, partner: 1 },
});
const r = await ledger.requestRefund("m1", "p1", "idempotency-key", 4);
if (r.ok) await ledger.receiveRefundResult(r.refund.refundId, "succeeded");
const view = await ledger.getPaymentView("p1");
await ledger.close();
```

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 TypeScript，无原生模块、无外部服务。
