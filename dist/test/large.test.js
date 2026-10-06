import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BomArchive, runTrial } from '../src/index.js';
/**
 * 满规格档案：20000 个物料、每个物料 2 个修订（1 个历史 + 1 个现行）、
 * 全档案 100000 条 BOM 明细。验证装载与单次试算的资源消耗。
 */
function buildFullScaleArchive() {
    const TIERS = 12;
    const PER_TIER = 1666; // 12 × 1666 = 19992 个自制件 + 8 个外购件 = 20000 个物料
    const materials = [];
    const revisions = [];
    const purchasedIds = [];
    for (let i = 0; i < 8; i++) {
        purchasedIds.push(`P${i}`);
        materials.push({ materialId: `P${i}`, type: 'purchased' });
    }
    const nodeId = (tier, index) => `T${tier}N${index}`;
    let lineCount = 0;
    for (let tier = 0; tier < TIERS; tier++) {
        for (let i = 0; i < PER_TIER; i++) {
            const id = nodeId(tier, i);
            materials.push({ materialId: id, type: 'manufactured' });
            const lines = [];
            if (tier < TIERS - 1) {
                // 每个节点 4 条到下一层的明细 + 1 条外购明细，共 11 × 1666 × 5 = 91630 条
                for (let k = 0; k < 4; k++) {
                    lines.push({
                        componentId: nodeId(tier + 1, (i * 4 + k) % PER_TIER),
                        quantity: '1.000001',
                        lossRate: '0.0001',
                    });
                    lineCount++;
                }
                lines.push({ componentId: purchasedIds[i % 8], quantity: '0.25' });
                lineCount++;
            }
            // 历史修订（已过期，含一个自循环，不应影响试算）
            revisions.push({
                revisionId: id + '-HIST',
                materialId: id,
                effectiveFrom: '2020-01-01',
                effectiveTo: '2021-01-01',
                lines: [{ componentId: id, quantity: '1' }],
            });
            revisions.push({
                revisionId: id + '-CUR',
                materialId: id,
                effectiveFrom: '2021-01-01',
                lines,
            });
        }
    }
    void lineCount;
    return { materials, revisions };
}
test('满规格档案：20000 物料 / 10 万明细，单次试算 5 秒与 128 MiB 以内', () => {
    const data = buildFullScaleArchive();
    const archive = new BomArchive(data);
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = performance.now();
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'T0N0', revisionId: 'T0N0-CUR', quantity: '1000' }],
    });
    const elapsed = performance.now() - start;
    globalThis.gc?.();
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    assert.ok(elapsed < 5000, `试算耗时 ${elapsed.toFixed(0)}ms，超过 5 秒`);
    assert.ok(heapDelta < 128 * 1024 * 1024, `新增堆内存 ${(heapDelta / 1024 / 1024).toFixed(1)} MiB，超过 128 MiB`);
    // 数量独立核对：T1N0 仅由 T0N0 的一条明细到达
    // 需求 = 1000 × 1.000001 × 1.000001 = 1000.002000001 → 1001 件
    const byMaterial = new Map(result.production.map((p) => [p.materialId, p.quantity]));
    assert.equal(byMaterial.get('T1N0'), '1001');
    assert.ok(result.consumption.length === 8, '8 个外购件都应有领料数量');
    for (const c of result.consumption) {
        assert.ok(BigInt(c.quantity) > 0n);
    }
});
