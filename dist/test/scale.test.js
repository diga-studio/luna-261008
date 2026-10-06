"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_js_1 = require("../src/index.js");
const reference_model_js_1 = require("./reference-model.js");
const PROFILE_COUNT = 20000;
const DEVICE_COUNT = 10000;
function buildWorld() {
    const rng = (0, reference_model_js_1.makeRng)(42);
    const fg = new index_js_1.FleetGuard();
    const ref = new reference_model_js_1.ReferenceModel();
    const group = { kind: 'group', id: 'shared' };
    // 2 万份配置，各自持有大量不同 SSID 的白名单。
    for (let i = 0; i < PROFILE_COUNT; i++) {
        const ssids = [];
        const size = 8 + Math.floor(rng() * 24);
        for (let s = 0; s < size; s++) {
            ssids.push(`ssid-${Math.floor(rng() * 200000)}`);
        }
        // 所有配置共享一小撮公共 SSID，保证交集非空、可观察。
        ssids.push('common-a', 'common-b');
        const policy = {
            minPinLength: 4 + Math.floor(rng() * 10),
            maxAutoLockSeconds: 30 + Math.floor(rng() * 600),
            allowCamera: rng() < 0.9,
            allowScreenshots: rng() < 0.9,
            allowedSsids: ssids,
        };
        fg.putProfile(`p${i}`, policy);
        ref.putProfile(`p${i}`, policy);
    }
    const allIds = Array.from({ length: PROFILE_COUNT }, (_, i) => `p${i}`);
    fg.bindProfiles(group, allIds, []);
    ref.bindProfiles(group, allIds, []);
    // 1 万台设备全部加入共享组，另有少量直接绑定。
    for (let d = 0; d < DEVICE_COUNT; d++) {
        const id = `d${d}`;
        fg.joinGroups(id, ['shared'], []);
        ref.joinGroups(id, ['shared'], []);
        if (d % 1000 === 0) {
            fg.bindProfiles({ kind: 'device', id }, ['p0', 'p1'], []);
            ref.bindProfiles({ kind: 'device', id }, ['p0', 'p1'], []);
        }
    }
    return { fg, ref };
}
(0, node_test_1.test)('2 万配置共享组 + 1 万设备：更新与读取的访问计数与规模无关', () => {
    const { fg, ref } = buildWorld();
    // 抽查若干设备与参考模型一致（参考模型全量核对 1 万台太慢）。
    for (const d of ['d0', 'd1234', 'd9999']) {
        (0, strict_1.deepEqual)(fg.resolve(d), ref.resolve(d), `初始 resolve ${d}`);
    }
    const before = fg.getStats().profileReads;
    // 1) 整体替换其中一份配置：只允许折叠该配置本身（出 1 次 + 入 1 次）。
    fg.putProfile('p777', { minPinLength: 14, allowedSsids: ['common-a', 'only-777'] });
    ref.putProfile('p777', { minPinLength: 14, allowedSsids: ['common-a', 'only-777'] });
    const afterReplace = fg.getStats().profileReads;
    (0, strict_1.equal)(afterReplace - before, 2, '替换单份配置只触及该配置，不随设备/绑定/SSID 总数增长');
    // 2) 撤销该配置的绑定：折叠 1 次。
    fg.bindProfiles({ kind: 'group', id: 'shared' }, [], ['p777']);
    ref.bindProfiles({ kind: 'group', id: 'shared' }, [], ['p777']);
    (0, strict_1.equal)(fg.getStats().profileReads - afterReplace, 1, '单条解绑只折叠一次');
    // 3) 重新绑定：折叠 1 次。
    fg.bindProfiles({ kind: 'group', id: 'shared' }, ['p777'], []);
    ref.bindProfiles({ kind: 'group', id: 'shared' }, ['p777'], []);
    (0, strict_1.equal)(fg.getStats().profileReads - afterReplace, 2, '单条绑定只折叠一次');
    // 4) 读取全部 1 万台设备：不得读取任何原始配置。
    const beforeResolveAll = fg.getStats().profileReads;
    let checksum = 0;
    for (let d = 0; d < DEVICE_COUNT; d++) {
        const policy = fg.resolve(`d${d}`);
        checksum += policy.minPinLength + (policy.allowedSsids?.length ?? -1);
    }
    (0, strict_1.equal)(fg.getStats().profileReads - beforeResolveAll, 0, 'resolve 不重扫任何原始配置（也不逐台刷新组成员）');
    (0, strict_1.equal)(typeof checksum, 'number');
    // 更新后抽查正确性。
    for (const d of ['d0', 'd5555', 'd9999']) {
        (0, strict_1.deepEqual)(fg.resolve(d), ref.resolve(d), `更新后 resolve ${d}`);
    }
});
(0, node_test_1.test)('单设备直接绑定大配置集合的增删同样为 O(变动量)', () => {
    const rng = (0, reference_model_js_1.makeRng)(7);
    const fg = new index_js_1.FleetGuard();
    const dev = { kind: 'device', id: 'd0' };
    const ids = [];
    for (let i = 0; i < 5000; i++) {
        const id = `p${i}`;
        ids.push(id);
        fg.putProfile(id, {
            minPinLength: 4 + Math.floor(rng() * 10),
            allowedSsids: [`s${i}`, 'shared'],
        });
    }
    fg.bindProfiles(dev, ids, []);
    const before = fg.getStats().profileReads;
    fg.bindProfiles(dev, [], ['p2500']);
    (0, strict_1.equal)(fg.getStats().profileReads - before, 1, '从 5000 条绑定中删 1 条只折叠 1 次');
    (0, strict_1.equal)(fg.resolve('d0').allowedSsids?.includes('s2500'), false);
    (0, strict_1.equal)(fg.resolve('d0').allowedSsids?.includes('shared'), true);
});
