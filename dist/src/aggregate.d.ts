import { type EffectivePolicy, type Policy } from './types.js';
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
export declare class ProfileAggregate {
    private readonly pinLengths;
    private readonly autoLocks;
    private cameraFalse;
    private screenshotsFalse;
    private ssidDeclared;
    private readonly ssidCount;
    private readonly byCount;
    addProfile(policy: Policy): void;
    removeProfile(policy: Policy): void;
    private fold;
    private adjustSsid;
    private addToIndex;
    private removeFromIndex;
    /** 本目标是否声明了任何 SSID 白名单。 */
    get hasSsidWhitelist(): boolean;
    get minPinLength(): number;
    get maxAutoLockSeconds(): number;
    get allowCamera(): boolean;
    get allowScreenshots(): boolean;
    /**
     * 本目标视角的 SSID 交集结果（只读）。
     * 未声明任何白名单时返回 null；否则返回交集集合（可能为空集 = 禁止全部）。
     */
    ssidIntersection(): ReadonlySet<string> | null;
    /** 当前聚合结果（本目标视角，未与其它目标合并）。 */
    snapshot(): EffectivePolicy;
}
