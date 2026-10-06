import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  allocate,
  ReconciliationLibrary,
  type EngineInvoice,
  type EngineLine,
  type InvoiceInput,
  type Snapshot,
} from '../src/index.js';

const PO_LINES = [
  { lineId: 'L1', orderedQty: 1000000n, unitPrice: 100n },
  { lineId: 'L2', orderedQty: 1000000n, unitPrice: 100n },
  { lineId: 'L3', orderedQty: 1000000n, unitPrice: 100n },
];

function makeInvoice(i: number): InvoiceInput {
  const poLineId = PO_LINES[i % 3]!.lineId;
  return {
    invoiceId: `INV-${i}`,
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId, qty: 10000n, amount: 1000n }],
  };
}

/** 依据优先级规则，从当前有效数据独立计算期望快照并与实际快照比对。 */
function assertSnapshotMatchesIndependentRun(
  snap: Snapshot,
  invoices: InvoiceInput[],
  voidedIds: Set<string>,
): void {
  const engineLines: EngineLine[] = PO_LINES.map((l) => ({
    poId: 'PO1',
    poLineId: l.lineId,
    orderedQty: l.orderedQty,
    unitPrice: l.unitPrice,
    qualifiedQty: 1000000n,
  }));
  const seqById = new Map(snap.invoices.map((i) => [i.invoiceId, i.seq]));
  const engineInvoices: EngineInvoice[] = invoices.map((inv) => ({
    invoiceId: inv.invoiceId,
    seq: seqById.get(inv.invoiceId)!,
    voided: voidedIds.has(inv.invoiceId),
    lines: inv.lines.map((l) => ({ ...l })),
  }));
  const result = allocate(engineLines, engineInvoices);
  for (const inv of snap.invoices) {
    assert.equal(
      inv.state,
      result.invoiceState.get(inv.invoiceId),
      `发票 ${inv.invoiceId} 状态与独立重算不一致`,
    );
  }
  for (const l of snap.lines) {
    const k = `${l.poId}/${l.poLineId}`;
    assert.equal(l.matchedQty, result.matchedQty.get(k) ?? 0n, `${k} 核销票量不一致`);
    assert.equal(l.matchedAmount, result.matchedAmount.get(k) ?? 0n, `${k} 核销票额不一致`);
  }
}

test('并发登记/撤票/旧操作重试：结果等价于串行执行，快照与独立重算一致，重开后不变', async () => {
  const path = join(tmpdir(), `recon-test-${process.pid}-${Date.now()}.sqlite`);
  const invoices: InvoiceInput[] = [];
  const voidedIds = new Set<string>();
  try {
    const lib = ReconciliationLibrary.open(path);
    await lib.registerPurchaseOrder('op-po', { poId: 'PO1', currency: 'CNY', lines: PO_LINES });
    await lib.recordReceipt('op-r1', {
      receiptId: 'R1',
      lines: PO_LINES.map((l) => ({
        poId: 'PO1',
        poLineId: l.lineId,
        qtyQualified: 1000000n,
        qtyPending: 0n,
        qtyRejected: 0n,
      })),
    });

    // 20 个并发登记
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const inv = makeInvoice(i);
        invoices.push(inv);
        return lib.registerInvoice(`op-i-${i}`, inv);
      }),
    );
    assert.ok(results.every((r) => r.status === 'applied'));
    // 序号可查询且为 1..N 的排列
    const seqs = lib.getSnapshot().invoices.map((i) => i.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));

    // 并发撤票 + 旧操作重试 + 同号不同内容
    const before = lib.getSnapshot();
    const wave = await Promise.all([
      ...[0, 1, 2, 3].map((i) => lib.voidInvoice(`op-void-${i}`, `INV-${i}`)),
      lib.registerInvoice('op-i-5', makeInvoice(5)), // 同号同内容重试
      lib.recordReceipt('op-r1', {
        receiptId: 'R1',
        lines: PO_LINES.map((l) => ({
          poId: 'PO1',
          poLineId: l.lineId,
          qtyQualified: 1000000n,
          qtyPending: 0n,
          qtyRejected: 0n,
        })),
      }), // 旧收货重放
      lib.registerInvoice('op-i-6', { ...makeInvoice(6), invoiceId: 'INV-OTHER' }), // 同号不同内容
    ]);
    assert.equal(wave[4]!.status, 'duplicate');
    assert.equal(wave[5]!.status, 'duplicate');
    assert.equal(wave[6]!.status, 'conflict');
    for (let i = 0; i < 4; i++) voidedIds.add(`INV-${i}`);

    const snap = lib.getSnapshot();
    // 同号不同内容未改变数据：除撤票外快照与之前一致
    assert.equal(snap.invoices.length, before.invoices.length);
    assert.ok(!snap.invoices.some((i) => i.invoiceId === 'INV-OTHER'));
    for (let i = 0; i < 4; i++) {
      assert.equal(snap.invoices.find((v) => v.invoiceId === `INV-${i}`)!.state, 'voided');
    }

    // 撤票后重试原登记操作：不复活撤销票
    const retry = await lib.registerInvoice('op-i-0', makeInvoice(0));
    assert.equal(retry.status, 'duplicate');
    assert.equal(
      lib.getSnapshot().invoices.find((v) => v.invoiceId === 'INV-0')!.state,
      'voided',
    );

    // 最终快照与独立重算一致
    const finalSnap = lib.getSnapshot();
    assertSnapshotMatchesIndependentRun(finalSnap, invoices, voidedIds);
    lib.close();

    // 正常关闭再打开：结果不变
    const lib2 = ReconciliationLibrary.open(path);
    const reopened = lib2.getSnapshot();
    assert.deepEqual(reopened, finalSnap);
    assertSnapshotMatchesIndependentRun(reopened, invoices, voidedIds);
    lib2.close();
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});

test('撤票释放额度后，更晚候选按序补上', async () => {
  const lib = ReconciliationLibrary.open(':memory:');
  await lib.registerPurchaseOrder('op-po', {
    poId: 'PO1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', orderedQty: 10000n, unitPrice: 100n }],
  });
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n }],
  });
  // INV1 占满 105%（10500），INV2 只能排队
  await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 10500n, amount: 1050n }],
  });
  await lib.registerInvoice('op-i2', {
    invoiceId: 'INV2',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 10000n, amount: 1000n }],
  });
  let snap = lib.getSnapshot();
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV2')!.state, 'pending');
  // 撤销 INV1 后 INV2 补上
  await lib.voidInvoice('op-v1', 'INV1');
  snap = lib.getSnapshot();
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV1')!.state, 'voided');
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV2')!.state, 'settleable');
  assert.equal(snap.lines[0]!.matchedQty, 10000n);
  lib.close();
});
