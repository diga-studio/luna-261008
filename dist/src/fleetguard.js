"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FleetGuard = void 0;
const aggregate_js_1 = require("./aggregate.js");
const types_js_1 = require("./types.js");
/**
 * FleetGuard 增量配置解析。
 *
 * 结构：
 *  - 每个「设备直接绑定集合」和每个「组」各维护一个 ProfileAggregate，
 *    配置的增删改只折叠进直接命中它的聚合，工作量与未变绑定数、
 *    其它配置的 SSID 总数、组成员设备数均无关。
 *  - 设备不预先展开组内容；resolve 时把设备直接聚合与至多 32 个
 *    组聚合现场合并（每组 O(1) 读取数值/布尔，SSID 只枚举交集结果）。
 *  - 同一份配置经多条路径命中时，每条路径在各自聚合中独立计数，
 *    撤销其中一条不影响其余路径仍然提供的约束。
 */
class FleetGuard {
    profiles = new Map();
    /** 配置 -> 直接绑定它的目标（"D:<deviceId>" / "G:<groupId>"）。 */
    profileTargets = new Map();
    deviceBindings = new Map();
    groupBindings = new Map();
    deviceAggregates = new Map();
    groupAggregates = new Map();
    deviceGroups = new Map();
    stats = { profileReads: 0 };
    /** 创建或整体替换配置；缺省字段不保留旧值。 */
    putProfile(id, policy) {
        const previous = this.profiles.get(id);
        this.profiles.set(id, policy);
        const targets = this.profileTargets.get(id);
        if (targets === undefined || targets.size === 0)
            return;
        for (const key of targets) {
            const aggregate = this.aggregateForKey(key);
            if (previous !== undefined)
                this.foldOut(aggregate, previous);
            this.foldIn(aggregate, policy);
        }
    }
    /** 增删设备或组的配置绑定（集合语义，重复添加不增加份数）。 */
    bindProfiles(target, addIds, removeIds) {
        const key = target.kind === 'device' ? `D:${target.id}` : `G:${target.id}`;
        const bindings = target.kind === 'device'
            ? getOrInit(this.deviceBindings, target.id, newSet)
            : getOrInit(this.groupBindings, target.id, newSet);
        const aggregate = this.aggregateForKey(key);
        for (const id of removeIds) {
            if (!bindings.delete(id))
                continue;
            this.profileTargets.get(id)?.delete(key);
            const policy = this.profiles.get(id);
            if (policy !== undefined)
                this.foldOut(aggregate, policy);
        }
        for (const id of addIds) {
            if (bindings.has(id))
                continue;
            bindings.add(id);
            getOrInit(this.profileTargets, id, newSet).add(key);
            const policy = this.profiles.get(id);
            if (policy !== undefined)
                this.foldIn(aggregate, policy);
        }
    }
    /** 增删设备的组成员关系（集合语义）。 */
    joinGroups(deviceId, addGroupIds, removeGroupIds) {
        const groups = getOrInit(this.deviceGroups, deviceId, newSet);
        for (const id of removeGroupIds)
            groups.delete(id);
        for (const id of addGroupIds)
            groups.add(id);
    }
    /** 设备当前的有效策略：直接绑定聚合与全部所属组聚合的最严格合并。 */
    resolve(deviceId) {
        let minPinLength = types_js_1.BASE_MIN_PIN_LENGTH;
        let maxAutoLockSeconds = types_js_1.BASE_MAX_AUTO_LOCK_SECONDS;
        let allowCamera = true;
        let allowScreenshots = true;
        const whitelists = [];
        const consider = (aggregate) => {
            if (aggregate.minPinLength > minPinLength)
                minPinLength = aggregate.minPinLength;
            if (aggregate.maxAutoLockSeconds < maxAutoLockSeconds) {
                maxAutoLockSeconds = aggregate.maxAutoLockSeconds;
            }
            if (!aggregate.allowCamera)
                allowCamera = false;
            if (!aggregate.allowScreenshots)
                allowScreenshots = false;
            const whitelist = aggregate.ssidIntersection();
            if (whitelist !== null)
                whitelists.push(whitelist);
        };
        const direct = this.deviceAggregates.get(deviceId);
        if (direct !== undefined)
            consider(direct);
        const groups = this.deviceGroups.get(deviceId);
        if (groups !== undefined) {
            for (const groupId of groups) {
                const aggregate = this.groupAggregates.get(groupId);
                if (aggregate !== undefined)
                    consider(aggregate);
            }
        }
        return {
            minPinLength,
            maxAutoLockSeconds,
            allowCamera,
            allowScreenshots,
            allowedSsids: intersectWhitelists(whitelists),
        };
    }
    getStats() {
        return { ...this.stats };
    }
    aggregateForKey(key) {
        const map = key.startsWith('D:') ? this.deviceAggregates : this.groupAggregates;
        return getOrInit(map, key.slice(2), () => new aggregate_js_1.ProfileAggregate());
    }
    foldIn(aggregate, policy) {
        this.stats.profileReads += 1;
        aggregate.addProfile(policy);
    }
    foldOut(aggregate, policy) {
        this.stats.profileReads += 1;
        aggregate.removeProfile(policy);
    }
}
exports.FleetGuard = FleetGuard;
function newSet() {
    return new Set();
}
function getOrInit(map, key, create) {
    let value = map.get(key);
    if (value === undefined) {
        value = create();
        map.set(key, value);
    }
    return value;
}
/** 交集合并：全部来源都未声明 -> null；否则返回各白名单的交集（排序后）。 */
function intersectWhitelists(whitelists) {
    if (whitelists.length === 0)
        return null;
    let smallest = whitelists[0];
    for (const set of whitelists) {
        if (set.size < smallest.size)
            smallest = set;
    }
    const result = [];
    outer: for (const ssid of smallest) {
        for (const set of whitelists) {
            if (!set.has(ssid))
                continue outer;
        }
        result.push(ssid);
    }
    result.sort();
    return result;
}
