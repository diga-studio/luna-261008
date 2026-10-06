import { ExtremumMultiset } from './multiset';
import { Policy } from './types';

/** 更新路径的确定性访问计数，供测试观测摊还工作量。 */
export interface AggregateStats {
  /** 折叠进聚合的原始配置份数（add/remove/replace 每份每向计一次）。 */
  profileFolds: number;
  /** 触碰的 SSID 条目数（每份配置的每个去重 SSID 计一次）。 */
  ssidEntryTouches: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * 单一目标（设备或组）上已绑定配置的增量聚合。
 *
 * 每个维度都是可撤销的多重集合语义：
 * - minPinLength：最大值多重集合
 * - maxAutoLockSeconds：最小值多重集合
 * - allowCamera / allowScreenshots：取反值计数（>0 即禁止）
 * - allowedSsids：ssid -> 声明它的配置数；再按计数分桶，
 *   计数等于“声明白名单的配置数”的桶即为交集，增删均为 O(1)/SSID。
 */
export class ProfileAggregate {
  private readonly contributions = new Map<string, Policy>();
  private readonly pin = new ExtremumMultiset('max');
  private readonly lock = new ExtremumMultiset('min');
  private cameraDenyCount = 0;
  private screenshotsDenyCount = 0;
  private declared = 0;
  private readonly ssidCounts = new Map<string, number>();
  private readonly ssidBuckets = new Map<number, Set<string>>();

  constructor(private readonly stats?: AggregateStats) {}

  /** 当前绑定的不同配置数。 */
  get profileCount(): number {
    return this.contributions.size;
  }

  /** 声明白名单的配置数（0 表示白名单维度无约束）。 */
  get ssidDeclaredCount(): number {
    return this.declared;
  }

  /** 加入一份配置的约束；同一 ID 重复加入不产生第二份。 */
  add(profileId: string, policy: Policy): void {
    if (this.contributions.has(profileId)) {
      this.remove(profileId);
    }
    this.contributions.set(profileId, policy);
    this.apply(policy, 1);
  }

  /** 移除一份配置的约束；未绑定时为空操作。 */
  remove(profileId: string): void {
    const old = this.contributions.get(profileId);
    if (old === undefined) return;
    this.contributions.delete(profileId);
    this.apply(old, -1);
  }

  /** 整体替换一份配置的约束（配置被 putProfile 改写时调用）。 */
  replace(profileId: string, policy: Policy): void {
    const old = this.contributions.get(profileId);
    if (old !== undefined) {
      this.apply(old, -1);
    }
    this.contributions.set(profileId, policy);
    this.apply(policy, 1);
  }

  /** 当前 minPinLength 的最大值；无配置时为 undefined。 */
  pinMax(): number | undefined {
    return this.pin.top();
  }

  /** 当前 maxAutoLockSeconds 的最小值；无配置时为 undefined。 */
  lockMin(): number | undefined {
    return this.lock.top();
  }

  /** 是否存在禁止摄像头的配置。 */
  hasCameraDeny(): boolean {
    return this.cameraDenyCount > 0;
  }

  /** 是否存在禁止截屏的配置。 */
  hasScreenshotsDeny(): boolean {
    return this.screenshotsDenyCount > 0;
  }

  /**
   * 当前白名单交集。返回 null 表示无配置声明白名单；
   * 否则返回交集集合（可能为空集，表示禁止所有 WiFi）。
   * 返回值为内部结构的只读视图，调用方不得修改。
   */
  ssidIntersection(): ReadonlySet<string> | null {
    if (this.declared === 0) return null;
    return this.ssidBuckets.get(this.declared) ?? EMPTY_SET;
  }

  private apply(policy: Policy, sign: 1 | -1): void {
    if (this.stats) this.stats.profileFolds += 1;
    if (policy.minPinLength !== undefined) {
      if (sign > 0) this.pin.add(policy.minPinLength);
      else this.pin.remove(policy.minPinLength);
    }
    if (policy.maxAutoLockSeconds !== undefined) {
      if (sign > 0) this.lock.add(policy.maxAutoLockSeconds);
      else this.lock.remove(policy.maxAutoLockSeconds);
    }
    if (policy.allowCamera === false) {
      this.cameraDenyCount += sign;
    }
    if (policy.allowScreenshots === false) {
      this.screenshotsDenyCount += sign;
    }
    if (policy.allowedSsids !== undefined) {
      this.declared += sign;
      const unique = new Set(policy.allowedSsids);
      for (const ssid of unique) {
        this.adjustSsid(ssid, sign);
        if (this.stats) this.stats.ssidEntryTouches += 1;
      }
    }
  }

  private adjustSsid(ssid: string, delta: 1 | -1): void {
    const oldCount = this.ssidCounts.get(ssid) ?? 0;
    const newCount = oldCount + delta;
    if (oldCount > 0) {
      const oldBucket = this.ssidBuckets.get(oldCount);
      if (oldBucket !== undefined) {
        oldBucket.delete(ssid);
        if (oldBucket.size === 0) this.ssidBuckets.delete(oldCount);
      }
    }
    if (newCount <= 0) {
      this.ssidCounts.delete(ssid);
    } else {
      this.ssidCounts.set(ssid, newCount);
      let bucket = this.ssidBuckets.get(newCount);
      if (bucket === undefined) {
        bucket = new Set();
        this.ssidBuckets.set(newCount, bucket);
      }
      bucket.add(ssid);
    }
  }
}
