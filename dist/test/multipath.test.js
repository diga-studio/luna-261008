"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const index_js_1 = require("../src/index.js");
(0, node_test_1.test)('同一配置经直接绑定与两个组命中，逐条撤销路径', () => {
    const fg = new index_js_1.FleetGuard();
    // strict：最严格来源；mid/base：其余来源，提供回落目标值。
    fg.putProfile('strict', {
        minPinLength: 12,
        maxAutoLockSeconds: 30,
        allowCamera: false,
        allowScreenshots: false,
        allowedSsids: [], // 禁止所有 WiFi
    });
    fg.putProfile('mid', {
        minPinLength: 8,
        maxAutoLockSeconds: 60,
        allowScreenshots: false,
        allowedSsids: ['corp', 'guest'],
    });
    fg.putProfile('base', { minPinLength: 7, maxAutoLockSeconds: 90 });
    const dev = { kind: 'device', id: 'd1' };
    const g1 = { kind: 'group', id: 'g1' };
    const g2 = { kind: 'group', id: 'g2' };
    // strict 经三条路径命中：直接绑定 + g1 + g2；mid 只在 g2；base 直接绑定。
    fg.bindProfiles(dev, ['strict', 'base'], []);
    fg.bindProfiles(g1, ['strict'], []);
    fg.bindProfiles(g2, ['strict', 'mid'], []);
    fg.joinGroups('d1', ['g1', 'g2'], []);
    const expectStrict = fg.resolve('d1');
    (0, strict_1.deepEqual)(expectStrict, {
        minPinLength: 12,
        maxAutoLockSeconds: 30,
        allowCamera: false,
        allowScreenshots: false,
        allowedSsids: [], // strict 的空白名单压制一切
    });
    // 撤销路径 1（直接绑定 strict）：约束不丢失。
    fg.bindProfiles(dev, [], ['strict']);
    (0, strict_1.deepEqual)(fg.resolve('d1'), expectStrict, '撤销直接绑定后仍有两条组路径');
    // 撤销路径 2（g1 解绑 strict）：约束不丢失。
    fg.bindProfiles(g1, [], ['strict']);
    (0, strict_1.deepEqual)(fg.resolve('d1'), expectStrict, '撤销 g1 后仍有 g2 路径');
    // 设备退出 g2 前，先把 g2 里 strict 解绑：strict 的最后一条路径消失。
    fg.bindProfiles(g2, [], ['strict']);
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 8,
        maxAutoLockSeconds: 60,
        allowCamera: true,
        allowScreenshots: false,
        allowedSsids: ['corp', 'guest'], // 从禁止全部恢复为有限集合
    });
    // 退出 g2：mid 也消失，只剩 base。
    fg.joinGroups('d1', [], ['g2']);
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 7,
        maxAutoLockSeconds: 90,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: null, // 恢复为无限制
    });
});
(0, node_test_1.test)('整体替换最严格配置后限制放宽，替换回来重新收紧', () => {
    const fg = new index_js_1.FleetGuard();
    fg.putProfile('p', { minPinLength: 10, allowCamera: false, allowedSsids: ['x'] });
    fg.putProfile('q', { minPinLength: 8, maxAutoLockSeconds: 45 });
    const dev = { kind: 'device', id: 'd1' };
    fg.bindProfiles(dev, ['p', 'q'], []);
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 10,
        maxAutoLockSeconds: 45,
        allowCamera: false,
        allowScreenshots: true,
        allowedSsids: ['x'],
    });
    // 整体替换 p：缺省字段不保留旧值（allowCamera、allowedSsids 消失）。
    fg.putProfile('p', { maxAutoLockSeconds: 20 });
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 8,
        maxAutoLockSeconds: 20,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: null,
    });
    fg.putProfile('p', { minPinLength: 16 });
    (0, strict_1.equal)(fg.resolve('d1').minPinLength, 16, '重新收紧立即生效');
});
(0, node_test_1.test)('重复绑定不增加份数', () => {
    const fg = new index_js_1.FleetGuard();
    fg.putProfile('p', { allowCamera: false, allowedSsids: ['a'] });
    const dev = { kind: 'device', id: 'd1' };
    fg.bindProfiles(dev, ['p', 'p'], []);
    fg.bindProfiles(dev, ['p'], []);
    fg.bindProfiles(dev, [], ['p']); // 一次解绑即完全移除
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 6,
        maxAutoLockSeconds: 120,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: null,
    });
});
(0, node_test_1.test)('先绑定后创建的配置在 putProfile 后立即生效', () => {
    const fg = new index_js_1.FleetGuard();
    const dev = { kind: 'device', id: 'd1' };
    fg.bindProfiles(dev, ['late'], []);
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 6,
        maxAutoLockSeconds: 120,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: null,
    });
    fg.putProfile('late', { minPinLength: 9, allowedSsids: [] });
    (0, strict_1.deepEqual)(fg.resolve('d1'), {
        minPinLength: 9,
        maxAutoLockSeconds: 120,
        allowCamera: true,
        allowScreenshots: true,
        allowedSsids: [],
    });
});
