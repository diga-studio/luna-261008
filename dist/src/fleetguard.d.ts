import { type EffectivePolicy, type Policy, type Target } from './types.js';
export interface FleetGuardStats {
    /** 配置对象被读入聚合的次数（每次 add/remove 折叠计 1）。 */
    profileReads: number;
}
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
export declare class FleetGuard {
    private readonly profiles;
    /** 配置 -> 直接绑定它的目标（"D:<deviceId>" / "G:<groupId>"）。 */
    private readonly profileTargets;
    private readonly deviceBindings;
    private readonly groupBindings;
    private readonly deviceAggregates;
    private readonly groupAggregates;
    private readonly deviceGroups;
    private stats;
    /** 创建或整体替换配置；缺省字段不保留旧值。 */
    putProfile(id: string, policy: Policy): void;
    /** 增删设备或组的配置绑定（集合语义，重复添加不增加份数）。 */
    bindProfiles(target: Target, addIds: string[], removeIds: string[]): void;
    /** 增删设备的组成员关系（集合语义）。 */
    joinGroups(deviceId: string, addGroupIds: string[], removeGroupIds: string[]): void;
    /** 设备当前的有效策略：直接绑定聚合与全部所属组聚合的最严格合并。 */
    resolve(deviceId: string): EffectivePolicy;
    getStats(): FleetGuardStats;
    private aggregateForKey;
    private foldIn;
    private foldOut;
}
