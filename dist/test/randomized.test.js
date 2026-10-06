"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_js_1 = require("../src/index.js");
const reference_model_js_1 = require("./reference-model.js");
const PROFILE_COUNT = 40;
const DEVICE_COUNT = 30;
const GROUP_COUNT = 12;
const SSID_POOL = Array.from({ length: 30 }, (_, i) => `ssid-${i}`);
const OP_COUNT = 3000;
function randomPolicy(rng) {
    const policy = {};
    if (rng() < 0.6)
        policy.minPinLength = 4 + Math.floor(rng() * 12);
    if (rng() < 0.6)
        policy.maxAutoLockSeconds = 15 + Math.floor(rng() * 300);
    if (rng() < 0.5)
        policy.allowCamera = rng() < 0.5;
    if (rng() < 0.5)
        policy.allowScreenshots = rng() < 0.5;
    const roll = rng();
    if (roll < 0.15) {
        policy.allowedSsids = []; // 空白名单：禁止所有 WiFi
    }
    else if (roll < 0.55) {
        const size = 1 + Math.floor(rng() * 8);
        const ssids = new Set();
        while (ssids.size < size)
            ssids.add((0, reference_model_js_1.pick)(rng, SSID_POOL));
        policy.allowedSsids = [...ssids];
    }
    return policy;
}
function randomIds(rng, count, prefix) {
    const ids = new Set();
    const size = 1 + Math.floor(rng() * 3);
    while (ids.size < size)
        ids.add(`${prefix}${Math.floor(rng() * count)}`);
    return [...ids];
}
(0, node_test_1.test)('随机操作序列与逐份合并参考模型一致', () => {
    const rng = (0, reference_model_js_1.makeRng)(20261006);
    const fg = new index_js_1.FleetGuard();
    const ref = new reference_model_js_1.ReferenceModel();
    // 初始：全部配置先建立（部分后续会被整体替换）。
    for (let i = 0; i < PROFILE_COUNT; i++) {
        const policy = randomPolicy(rng);
        fg.putProfile(`p${i}`, policy);
        ref.putProfile(`p${i}`, policy);
    }
    for (let op = 0; op < OP_COUNT; op++) {
        const kind = rng();
        if (kind < 0.3) {
            // 整体替换一份配置（缺省字段不保留旧值）。
            const id = `p${Math.floor(rng() * PROFILE_COUNT)}`;
            const policy = randomPolicy(rng);
            fg.putProfile(id, policy);
            ref.putProfile(id, policy);
        }
        else if (kind < 0.7) {
            const target = rng() < 0.5
                ? { kind: 'device', id: `d${Math.floor(rng() * DEVICE_COUNT)}` }
                : { kind: 'group', id: `g${Math.floor(rng() * GROUP_COUNT)}` };
            const add = randomIds(rng, PROFILE_COUNT, 'p');
            const remove = randomIds(rng, PROFILE_COUNT, 'p');
            fg.bindProfiles(target, add, remove);
            ref.bindProfiles(target, add, remove);
        }
        else {
            const deviceId = `d${Math.floor(rng() * DEVICE_COUNT)}`;
            const add = randomIds(rng, GROUP_COUNT, 'g');
            const remove = randomIds(rng, GROUP_COUNT, 'g');
            fg.joinGroups(deviceId, add, remove);
            ref.joinGroups(deviceId, add, remove);
        }
        // 每 50 步全量核对所有设备，其余步骤抽查 3 台。
        if (op % 50 === 0) {
            for (let d = 0; d < DEVICE_COUNT; d++) {
                (0, strict_1.deepEqual)(fg.resolve(`d${d}`), ref.resolve(`d${d}`), `op=${op} device=d${d}`);
            }
        }
        else {
            for (let k = 0; k < 3; k++) {
                const d = Math.floor(rng() * DEVICE_COUNT);
                (0, strict_1.deepEqual)(fg.resolve(`d${d}`), ref.resolve(`d${d}`), `op=${op} device=d${d}`);
            }
        }
    }
});
(0, node_test_1.test)('字段缺省、空白名单、交集为空的基础行为', () => {
    const fg = new index_js_1.FleetGuard();
    fg.putProfile('empty', {});
    fg.putProfile('blank-wifi', { allowedSsids: [] });
    fg.putProfile('wifi-a', { allowedSsids: ['a', 'b'] });
    fg.putProfile('wifi-b', { allowedSsids: ['c', 'd'] });
    const dev = { kind: 'device', id: 'd0' };
    fg.bindProfiles(dev, ['empty'], []);
    (0, strict_1.deepEqual)(fg.resolve('d0'), {
        minPinLength: 6,
        maxAutoLockSeconds: 120,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: null,
    });
    fg.bindProfiles(dev, ['blank-wifi'], []);
    (0, strict_1.deepEqual)(fg.resolve('d0').allowedSsids, [], '空白名单禁止所有 WiFi');
    fg.bindProfiles(dev, [], ['blank-wifi']);
    fg.bindProfiles(dev, ['wifi-a', 'wifi-b'], []);
    (0, strict_1.deepEqual)(fg.resolve('d0').allowedSsids, [], '两个不相交白名单交集为空');
    fg.bindProfiles(dev, [], ['wifi-b']);
    (0, strict_1.deepEqual)(fg.resolve('d0').allowedSsids, ['a', 'b']);
    fg.bindProfiles(dev, [], ['wifi-a']);
    (0, strict_1.deepEqual)(fg.resolve('d0').allowedSsids, null, '无白名单声明时返回 null');
});
