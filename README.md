# refund-ledger

支付退款与分账账本库（TypeScript + SQLite），供上层支付平台直接调用。

## 能力

仅提供四类能力，全部通过 `Ledger` 类暴露：

- `recordSettledPayment(input)` — 记录已结算支付。调用方提供可信的商户身份、支付标识、币种（USD/EUR/GBP）、总金额（整数分，≤ 5,000,000）及三方（商户/平台/合作方）原始入账金额，三方之和必须等于总金额。资金从收款清算账户转入三方账户。
- `requestRefund(request)` — 申请部分退款。携带商户内唯一幂等键；重复申请返回原退款、不重复占额；换支付或换金额复用同一键会被拒绝。未收到结果的申请只占自己的额度，不阻塞剩余额度。
- `receiveRefundResult(result)` — 接收渠道回执（`processing` / `succeeded` / `failed`）。重复与乱序回执安全：明确失败释放占额，成功将占额转为已退金额且只记账一次，终态后的 `processing` 不回退状态。
- `getLedger(merchantId, paymentId)` — 查看账本：已退、占额、三方累计应退与净入账、退款清算账户累计收款、全部资金流水，同一快照返回。

## 分摊规则

成功退款按**累计成功退款总额**分摊：各方累计应退 = 累计成功退款额 × 该方原始入账 ÷ 支付总额，先取整，剩余分按小数余数从大到小各补 1 分，余数相同按商户 → 平台 → 合作方排序。每次流水记录新旧累计应退之差；差额可为负（反向分账调整），旧流水永不改写。

## 运行要求

- Node.js ≥ 22.18（使用内置 `node:sqlite` 与 TypeScript 类型擦除，无原生扩展、无外部服务）
- `npm install` 仅安装开发依赖（TypeScript，用于 `npm run typecheck`）

```bash
npm install
npm test        # node --test，直接运行 .ts 测试
npm run typecheck
```

## 持久化与并发

- 数据持久化到 SQLite 文件（`new Ledger('path/to/ledger.db')`），`:memory:` 可用于临时实例；正常关闭重开后幂等结果、占额与流水保持不变。
- 每个写操作在 `BEGIN IMMEDIATE` 事务内完成，退款状态、占额、累计分摊与流水同时生效；多连接并发（如 64 个退款同时提交）由 WAL + busy_timeout + 重试保证不超占额度。
- 资金流水逐币种借贷平衡：结算时收款清算账户出账、三方入账；退款成功时三方出账、退款清算账户入账。

## 目录结构

- `src/types.ts` — 公开类型
- `src/errors.ts` — 错误类型
- `src/db.ts` — SQLite 连接与 schema
- `src/allocation.ts` — 累计分摊（最大余数法）
- `src/ledger.ts` — `Ledger` 主类
- `test/` — 自动化测试（额度竞争、重复/乱序回执、分摊验收、持久化）
- `workers/` — 并发测试用的 worker 线程脚本
