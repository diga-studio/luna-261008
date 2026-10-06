"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pick = exports.makeRng = exports.ReferenceModel = void 0;
const index_js_1 = require("../src/index.js");
/**
 * 参考模型：每次 resolve 都逐份扫描该设备命中的全部原始配置并合并。
 * 只追求显然正确，不追求效率，用于对照验证增量实现。
 */
class ReferenceModel {
    profiles = new Map();
    deviceBindings = new Map();
    groupBindings = new Map();
    deviceGroups = new Map();
    putProfile(id, policy) {
        this.profiles.set(id, policy);
    }
    bindProfiles(target, addIds, removeIds) {
        const map = target.kind === 'device' ? this.deviceBindings : this.groupBindings;
        let set = map.get(target.id);
        if (set === undefined) {
            set = new Set();
            map.set(target.id, set);
        }
        for (const id of removeIds)
            set.delete(id);
        for (const id of addIds)
            set.add(id);
    }
    joinGroups(deviceId, addGroupIds, removeGroupIds) {
        let set = this.deviceGroups.get(deviceId);
        if (set === undefined) {
            set = new Set();
            this.deviceGroups.set(deviceId, set);
        }
        for (const id of removeGroupIds)
            set.delete(id);
        for (const id of addGroupIds)
            set.add(id);
    }
    resolve(deviceId) {
        let minPinLength = index_js_1.BASE_MIN_PIN_LENGTH;
        let maxAutoLockSeconds = index_js_1.BASE_MAX_AUTO_LOCK_SECONDS;
        let allowCamera = true;
        let allowScreenshots = true;
        const whitelists = [];
        const apply = (policy) => {
            if (policy.minPinLength !== undefined && policy.minPinLength > minPinLength) {
                minPinLength = policy.minPinLength;
            }
            if (policy.maxAutoLockSeconds !== undefined &&
                policy.maxAutoLockSeconds < maxAutoLockSeconds) {
                maxAutoLockSeconds = policy.maxAutoLockSeconds;
            }
            if (policy.allowCamera === false)
                allowCamera = false;
            if (policy.allowScreenshots === false)
                allowScreenshots = false;
            if (policy.allowedSsids !== undefined) {
                whitelists.push([...new Set(policy.allowedSsids)]);
            }
        };
        for (const id of this.deviceBindings.get(deviceId) ?? []) {
            const policy = this.profiles.get(id);
            if (policy !== undefined)
                apply(policy);
        }
        for (const groupId of this.deviceGroups.get(deviceId) ?? []) {
            for (const id of this.groupBindings.get(groupId) ?? []) {
                const policy = this.profiles.get(id);
                if (policy !== undefined)
                    apply(policy);
            }
        }
        let allowedSsids = null;
        if (whitelists.length > 0) {
            const [first, ...rest] = whitelists;
            allowedSsids = first.filter((ssid) => rest.every((list) => list.includes(ssid))).sort();
        }
        return { minPinLength, maxAutoLockSeconds, allowCamera, allowScreenshots, allowedSsids };
    }
}
exports.ReferenceModel = ReferenceModel;
/** 确定性伪随机数（mulberry32）。 */
function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
exports.makeRng = makeRng;
function pick(rng, items) {
    return items[Math.floor(rng() * items.length)];
}
exports.pick = pick;
