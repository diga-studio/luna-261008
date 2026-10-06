import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BomArchive, runTrial, TrialError } from '../src/index.js';
const simpleData = {
    materials: [
        { materialId: 'A', type: 'manufactured' },
        { materialId: 'P', type: 'purchased' },
    ],
    revisions: [
        {
            revisionId: 'A-1',
            materialId: 'A',
            effectiveFrom: '2026-01-01',
            lines: [{ componentId: 'P', quantity: '1', lossRate: '0' }],
        },
    ],
};
function expectInvalid(fn) {
    assert.throws(fn, (err) => err instanceof TrialError && err.code === 'INVALID_INPUT');
}
test('同一物料的修订有效期重叠：装载失败', () => {
    expectInvalid(() => new BomArchive({
        materials: [{ materialId: 'A', type: 'manufactured' }],
        revisions: [
            { revisionId: 'R1', materialId: 'A', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01', lines: [] },
            { revisionId: 'R2', materialId: 'A', effectiveFrom: '2026-05-01', lines: [] },
        ],
    }));
});
test('外购件不应拥有修订', () => {
    expectInvalid(() => new BomArchive({
        materials: [{ materialId: 'P', type: 'purchased' }],
        revisions: [{ revisionId: 'R1', materialId: 'P', effectiveFrom: '2026-01-01', lines: [] }],
    }));
});
test('明细引用未定义组件：装载失败', () => {
    expectInvalid(() => new BomArchive({
        materials: [{ materialId: 'A', type: 'manufactured' }],
        revisions: [
            {
                revisionId: 'R1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'GHOST', quantity: '1' }],
            },
        ],
    }));
});
test('数量格式非法：超过 6 位小数 / 非十进制文本', () => {
    expectInvalid(() => new BomArchive({
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'R1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: '1.0000001' }],
            },
        ],
    }));
    expectInvalid(() => new BomArchive({
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'R1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: 'abc' }],
            },
        ],
    }));
});
test('损耗率超出 0~100 或超过 4 位小数：装载失败', () => {
    const build = (lossRate) => () => new BomArchive({
        materials: [
            { materialId: 'A', type: 'manufactured' },
            { materialId: 'P', type: 'purchased' },
        ],
        revisions: [
            {
                revisionId: 'R1',
                materialId: 'A',
                effectiveFrom: '2026-01-01',
                lines: [{ componentId: 'P', quantity: '1', lossRate }],
            },
        ],
    });
    expectInvalid(build('100.0001'));
    expectInvalid(build('1.00001'));
});
test('根件校验：超上限 / 非自制件 / 修订不属于该物料 / 非整数', () => {
    const archive = new BomArchive(simpleData);
    const run = (roots) => () => runTrial(archive, { productionDate: '2026-06-01', roots: roots });
    expectInvalid(run([{ materialId: 'A', revisionId: 'A-1', quantity: '1000000000001' }]));
    expectInvalid(run([{ materialId: 'P', revisionId: 'A-1', quantity: '1' }]));
    expectInvalid(run([{ materialId: 'A', revisionId: 'NOPE', quantity: '1' }]));
    expectInvalid(run([{ materialId: 'A', revisionId: 'A-1', quantity: '1.5' }]));
    expectInvalid(run([{ materialId: 'A', revisionId: 'A-1', quantity: '-1' }]));
});
test('生产日期格式非法', () => {
    const archive = new BomArchive(simpleData);
    expectInvalid(() => runTrial(archive, {
        productionDate: '2026/06/01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1' }],
    }));
});
test('根件需求为 0：不产生任何生产与领料', () => {
    const archive = new BomArchive(simpleData);
    const result = runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '0' }],
    });
    assert.deepEqual(result, { production: [], consumption: [] });
});
