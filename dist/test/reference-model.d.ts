import type { EffectivePolicy, Policy, Target } from '../src/index.js';
/**
 * 参考模型：每次 resolve 都逐份扫描该设备命中的全部原始配置并合并。
 * 只追求显然正确，不追求效率，用于对照验证增量实现。
 */
export declare class ReferenceModel {
    private readonly profiles;
    private readonly deviceBindings;
    private readonly groupBindings;
    private readonly deviceGroups;
    putProfile(id: string, policy: Policy): void;
    bindProfiles(target: Target, addIds: string[], removeIds: string[]): void;
    joinGroups(deviceId: string, addGroupIds: string[], removeGroupIds: string[]): void;
    resolve(deviceId: string): EffectivePolicy;
}
/** 确定性伪随机数（mulberry32）。 */
export declare function makeRng(seed: number): () => number;
export declare function pick<T>(rng: () => number, items: readonly T[]): T;
