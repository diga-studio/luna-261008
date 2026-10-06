import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BomArchive, runTrial } from '../src/index.js';
/**
 * 12 层全连接分层网络：第 1 层 1 个根件，第 2~12 层各 8 个自制件，
 * 相邻层全连接；第 11 层每个节点另有一条到外购件 P 的明细。
 * 根到叶子的有效路径数 = 8^11 ≈ 86 亿 > 10 亿。
 */
function buildWideArchive() {
    const WIDTH = 8;
    const LAYERS = 12;
    const materials = [{ materialId: 'P', type: 'purchased' }];
    const revisions = [];
    const nodeId = (layer, index) => `L${layer}N${index}`;
    for (let layer = 1; layer <= LAYERS; layer++) {
        const count = layer === 1 ? 1 : WIDTH;
        for (let i = 0; i < count; i++) {
            const id = nodeId(layer, i);
            materials.push({ materialId: id, type: 'manufactured' });
            const lines = [];
            if (layer < LAYERS) {
                for (let j = 0; j < WIDTH; j++) {
                    lines.push({ componentId: nodeId(layer + 1, j), quantity: '1', lossRate: '0' });
                }
            }
            if (layer === LAYERS - 1) {
                lines.push({ componentId: 'P', quantity: '0.5', lossRate: '0' });
            }
            revisions.push({ revisionId: id + '-R', materialId: id, effectiveFrom: '2026-01-01', lines });
        }
    }
    return { materials, revisions };
}
test('十亿级有效路径的共享结构：聚合展开，数量可独立核对', () => {
    const archive = new BomArchive(buildWideArchive());
    const start = performance.now();
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'L1N0', revisionId: 'L1N0-R', quantity: '1000000000000' }],
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5000, `试算耗时 ${elapsed.toFixed(0)}ms，超过 5 秒`);
    // 独立核对：第 k 层每个节点的需求 = 1e12 × 8^(k-2)（k >= 2），根件为 1e12
    const WIDTH = 8n;
    const qty = 1000000000000n;
    const byMaterial = new Map(result.production.map((p) => [p.materialId, p.quantity]));
    assert.equal(byMaterial.get('L1N0'), qty.toString());
    for (let layer = 2; layer <= 12; layer++) {
        const expected = qty * WIDTH ** BigInt(layer - 2);
        for (let i = 0; i < 8; i++) {
            assert.equal(byMaterial.get(`L${layer}N${i}`), expected.toString(), `L${layer}N${i}`);
        }
    }
    // P = 第 11 层 8 个节点 × 每个 1e12 × 8^9 × 0.5 = 4 × 1e12 × 8^9
    const expectedP = 4n * qty * WIDTH ** 9n;
    assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: expectedP.toString() }]);
});
test('同一档案连续试算不同日期与数量，结果各自正确', () => {
    const data = {
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'S', type: 'manufactured' },
            { materialId: 'P1', type: 'purchased' },
            { materialId: 'P2', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'A-1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.5', lossRate: '0' }],
            },
            {
                revisionId: 'S-1',
                materialId: 'S',
                effectiveFrom: '2026-01-01',
                effectiveTo: '2026-06-01',
                lines: [{ componentId: 'P1', quantity: '1', lossRate: '0' }],
            },
            {
                revisionId: 'S-2',
                materialId: 'S',
                effectiveFrom: '2026-06-01',
                lines: [{ componentId: 'P2', quantity: '2', lossRate: '0' }],
            },
        ],
    };
    const archive = new BomArchive(data);
    const r1 = runTrial(archive, {
        productionDate: '2026-03-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '3' }],
    });
    // S 需求 1.5 → 2 件；P1 = 2
    assert.deepEqual(r1.production, [
        { materialId: 'A', revisionId: 'A-1', quantity: '3' },
        { materialId: 'S', revisionId: 'S-1', quantity: '2' },
    ]);
    assert.deepEqual(r1.consumption, [{ materialId: 'P1', quantity: '2' }]);
    const r2 = runTrial(archive, {
        productionDate: '2026-07-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '5' }],
    });
    // S 需求 2.5 → 3 件；P2 = 3 × 2 = 6
    assert.deepEqual(r2.production, [
        { materialId: 'A', revisionId: 'A-1', quantity: '5' },
        { materialId: 'S', revisionId: 'S-2', quantity: '3' },
    ]);
    assert.deepEqual(r2.consumption, [{ materialId: 'P2', quantity: '6' }]);
    // 再次以第一次的参数试算，结果不得受上一次影响
    const r3 = runTrial(archive, {
        productionDate: '2026-03-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '3' }],
    });
    assert.deepEqual(r3, r1);
});
