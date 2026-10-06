"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileAggregate = void 0;
const multiset_js_1 = require("./multiset.js");
const types_js_1 = require("./types.js");
/**
 * 单个目标（某台设备的直接绑定集合，或某个组的绑定集合）上
 * 配置合并结果的增量聚合。
 *
 * 每份配置的 add/remove 只触及该配置自身的字段：
 *  - 数值字段进入极值多重集合，均摊 O(log n)；
 *  - 布尔字段维护 false 计数，O(1)；
 *  - SSID 白名单维护「交集计数」结构：ssidCount 记录每个 SSID 被多少份
 *    已声明白名单包含，byCount 是其反向索引（计数 -> SSID 集合）。
 *    声明份数 declared 变化为 O(1)，单份配置的增删为 O(该配置的 SSID 数)。
 * 交集结果 = 计数恰好等于 declared 的全部 SSID，可直接枚举，无需扫描。
 */
class ProfileAggregate {
    pinLengths = multiset_js_1.ExtremumMultiset.max();
    autoLocks = multiset_js_1.ExtremumMultiset.min();
    cameraFalse = 0;
    screenshotsFalse = 0;
    ssidDeclared = 0;
    ssidCount = new Map();
    byCount = new Map();
    addProfile(policy) {
        this.fold(policy, +1);
    }
    removeProfile(policy) {
        this.fold(policy, -1);
    }
    fold(policy, dir) {
        if (policy.minPinLength !== undefined) {
            if (dir > 0)
                this.pinLengths.add(policy.minPinLength);
            else
                this.pinLengths.remove(policy.minPinLength);
        }
        if (policy.maxAutoLockSeconds !== undefined) {
            if (dir > 0)
                this.autoLocks.add(policy.maxAutoLockSeconds);
            else
                this.autoLocks.remove(policy.maxAutoLockSeconds);
        }
        if (policy.allowCamera === false)
            this.cameraFalse += dir;
        if (policy.allowScreenshots === false)
            this.screenshotsFalse += dir;
        if (policy.allowedSsids !== undefined) {
            this.ssidDeclared += dir;
            // 同一份配置内重复声明同一 SSID 只算一份（交集语义）。
            for (const ssid of new Set(policy.allowedSsids)) {
                this.adjustSsid(ssid, dir);
            }
        }
    }
    adjustSsid(ssid, dir) {
        const oldCount = this.ssidCount.get(ssid) ?? 0;
        const newCount = oldCount + dir;
        if (newCount < 0) {
            throw new Error('ProfileAggregate: SSID count underflow');
        }
        this.removeFromIndex(oldCount, ssid);
        if (newCount === 0) {
            this.ssidCount.delete(ssid);
        }
        else {
            this.ssidCount.set(ssid, newCount);
            this.addToIndex(newCount, ssid);
        }
    }
    addToIndex(count, ssid) {
        let bucket = this.byCount.get(count);
        if (bucket === undefined) {
            bucket = new Set();
            this.byCount.set(count, bucket);
        }
        bucket.add(ssid);
    }
    removeFromIndex(count, ssid) {
        const bucket = this.byCount.get(count);
        if (bucket === undefined)
            return;
        bucket.delete(ssid);
        if (bucket.size === 0)
            this.byCount.delete(count);
    }
    /** 本目标是否声明了任何 SSID 白名单。 */
    get hasSsidWhitelist() {
        return this.ssidDeclared > 0;
    }
    get minPinLength() {
        return Math.max(types_js_1.BASE_MIN_PIN_LENGTH, this.pinLengths.top() ?? types_js_1.BASE_MIN_PIN_LENGTH);
    }
    get maxAutoLockSeconds() {
        return Math.min(types_js_1.BASE_MAX_AUTO_LOCK_SECONDS, this.autoLocks.top() ?? types_js_1.BASE_MAX_AUTO_LOCK_SECONDS);
    }
    get allowCamera() {
        return this.cameraFalse === 0;
    }
    get allowScreenshots() {
        return this.screenshotsFalse === 0;
    }
    /**
     * 本目标视角的 SSID 交集结果（只读）。
     * 未声明任何白名单时返回 null；否则返回交集集合（可能为空集 = 禁止全部）。
     */
    ssidIntersection() {
        if (this.ssidDeclared === 0)
            return null;
        return this.byCount.get(this.ssidDeclared) ?? new Set();
    }
    /** 当前聚合结果（本目标视角，未与其它目标合并）。 */
    snapshot() {
        return {
            minPinLength: this.minPinLength,
            maxAutoLockSeconds: this.maxAutoLockSeconds,
            allowCamera: this.allowCamera,
            allowScreenshots: this.allowScreenshots,
            allowedSsids: this.hasSsidWhitelist
                ? [...this.ssidIntersection()]
                : null,
        };
    }
}
exports.ProfileAggregate = ProfileAggregate;
