import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BomArchive, runTrial } from '../src/index.js';
function baseArchive(subType) {
    return {
        materials: [
            { materialId: 'R1', type: 'manufactured' },
            { materialId: 'R2', type: 'manufactured' },
            { materialId: 'S', type: subType },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'R1-A',
                materialId: 'R1',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.4', lossRate: '0' }],
            },
            {
                revisionId: 'R2-A',
                materialId: 'R2',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.4', lossRate: '0' }],
            },
            {
                revisionId: 'S-A',
                materialId: 'S',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: '2.5', lossRate: '0' }],
            },
        ],
    };
}
test('两个根件各需0.4件同一普通子装配：合并取整为1件，原料3件', () => {
    const archive = new BomArchive(baseArchive('manufactured'));
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'R1', revisionId: 'R1-A', quantity: '1' },
            { materialId: 'R2', revisionId: 'R2-A', quantity: '1' },
        ],
    });
    assert.deepEqual(result.production, [
        { materialId: 'R1', revisionId: 'R1-A', quantity: '1' },
        { materialId: 'R2', revisionId: 'R2-A', quantity: '1' },
        { materialId: 'S', revisionId: 'S-A', quantity: '1' },
    ]);
    assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '3' }]);
});
test('子装配改为幻影件：不取整、无生产数量，原料2件', () => {
    const archive = new BomArchive(baseArchive('phantom'));
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'R1', revisionId: 'R1-A', quantity: '1' },
            { materialId: 'R2', revisionId: 'R2-A', quantity: '1' },
        ],
    });
    assert.deepEqual(result.production, [
        { materialId: 'R1', revisionId: 'R1-A', quantity: '1' },
        { materialId: 'R2', revisionId: 'R2-A', quantity: '1' },
    ]);
    assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '2' }]);
});
test('极小尾数：恰好整件不多算，超出一点点必须多算一件', () => {
    const data = {
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'B', type: 'manufactured' },
            { materialId: 'C', type: 'manufactured' },
            { materialId: 'S', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'A-1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.333333', lossRate: '0' }],
            },
            {
                revisionId: 'B-1',
                materialId: 'B',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.333333', lossRate: '0' }],
            },
            {
                revisionId: 'C-1',
                materialId: 'C',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'S', quantity: '0.333334', lossRate: '0' }],
            },
            {
                revisionId: 'S-1',
                materialId: 'S',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: '1', lossRate: '0' }],
            },
        ],
    };
    const archive = new BomArchive(data);
    // 0.333333 × 3 = 0.999999 → 1 件
    const r1 = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'A', revisionId: 'A-1', quantity: '1' },
            { materialId: 'B', revisionId: 'B-1', quantity: '1' },
            { materialId: 'A', revisionId: 'A-1', quantity: '1' },
        ],
    });
    assert.equal(r1.production.find((p) => p.materialId === 'S')?.quantity, '1');
    // 0.333333 × 2 + 0.333334 = 1.000000 → 恰好 1 件，不得多算
    const r2 = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'A', revisionId: 'A-1', quantity: '1' },
            { materialId: 'B', revisionId: 'B-1', quantity: '1' },
            { materialId: 'C', revisionId: 'C-1', quantity: '1' },
        ],
    });
    assert.equal(r2.production.find((p) => p.materialId === 'S')?.quantity, '1');
    assert.equal(r2.consumption.find((c) => c.materialId === 'P')?.quantity, '1');
    // 再加 0.000001 → 1.000001 → 2 件
    const r3 = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'A', revisionId: 'A-1', quantity: '1' },
            { materialId: 'B', revisionId: 'B-1', quantity: '1' },
            { materialId: 'C', revisionId: 'C-1', quantity: '1' },
            { materialId: 'A', revisionId: 'A-1', quantity: '1' },
        ],
    });
    assert.equal(r3.production.find((p) => p.materialId === 'S')?.quantity, '2');
});
test('超越安全整数范围：1e12 根件 × 极小用量尾数精确取整', () => {
    const data = {
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'S', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'A-1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [
                    { componentId: 'S', quantity: '0.000001', lossRate: '0' },
                    { componentId: 'P', quantity: '0.000001', lossRate: '0' },
                ],
            },
            {
                revisionId: 'S-1',
                materialId: 'S',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: '1.000001', lossRate: '0' }],
            },
        ],
    };
    const archive = new BomArchive(data);
    // S 需求 = 1e12 × 0.000001 = 1000000 恰好 → 1000000 件
    // P = 1e12 × 0.000001 + 1000000 × 1.000001 = 1000000 + 1000001 = 2000001 恰好，不得多算
    const r1 = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1000000000000' }],
    });
    assert.equal(r1.production.find((p) => p.materialId === 'S')?.quantity, '1000000');
    assert.equal(r1.consumption.find((c) => c.materialId === 'P')?.quantity, '2000001');
    // 两个根件 999999999999 + 2 → S 需求 1000000.000001 → 1000001 件
    // P = 1000000.000001 + 1000001 × 1.000001 = 2000002.000002 → 2000003
    const r2 = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [
            { materialId: 'A', revisionId: 'A-1', quantity: '999999999999' },
            { materialId: 'A', revisionId: 'A-1', quantity: '2' },
        ],
    });
    assert.equal(r2.production.find((p) => p.materialId === 'S')?.quantity, '1000001');
    assert.equal(r2.consumption.find((c) => c.materialId === 'P')?.quantity, '2000003');
});
test('损耗率缺省为 2.5%，同组件多明细累加', () => {
    const data = {
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'A-1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [
                    { componentId: 'P', quantity: '2' },
                    { componentId: 'P', quantity: '2', lossRate: '2.5' },
                    { componentId: 'P', quantity: '1', lossRate: '0' },
                ],
            },
        ],
    };
    const archive = new BomArchive(data);
    // 2×1.025 + 2×1.025 + 1 = 5.1 → 6
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1' }],
    });
    assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '6' }]);
});
