import { AggregateStats, ProfileAggregate } from './aggregate';
import {
  BASE_MAX_AUTO_LOCK_SECONDS,
  BASE_MIN_PIN_LENGTH,
  EffectivePolicy,
  Policy,
  Target,
} from './types';

/** 更新路径的确定性访问计数，供测试观测摊还工作量。 */
export interface FleetGuardStats extends AggregateStats {
  /** 更新阶段遍历成员设备的次数（本实现恒为 0：组策略刷新不触碰成员）。 */
  memberIterations: number;
}

const DEVICE_PREFIX = 'device:';
const GROUP_PREFIX = 'group:';

/**
 * FleetGuard 增量配置解析。
 *
 * 结构：
 * - 每个设备 / 组各持有一个 ProfileAggregate，只聚合直接绑定到自身的配置；
 * - 设备记录自己的组集合（最多 32 个），组不记录成员；
 * - resolve 在读取时合并“设备直接聚合 + 各组聚合”，
 *   因此组内配置变化不需要触碰任何成员设备；
 * - profileTargets 反向索引使 putProfile 只需更新直接绑定该配置的目标。
 */
export class FleetGuard {
  readonly stats: FleetGuardStats = {
    profileFolds: 0,
    ssidEntryTouches: 0,
    memberIterations: 0,
  };

  private readonly profiles = new Map<string, Policy>();
  private readonly profileTargets = new Map<string, Set<string>>();
  private readonly deviceAggregates = new Map<string, ProfileAggregate>();
  private readonly groupAggregates = new Map<string, ProfileAggregate>();
  private readonly deviceGroups = new Map<string, Set<string>>();

  /** 创建或整体替换配置；缺省字段不保留旧值。 */
  putProfile(id: string, policy: Policy): void {
    this.profiles.set(id, policy);
    const targets = this.profileTargets.get(id);
    if (targets === undefined) return;
    for (const key of targets) {
      this.aggregateForKey(key).replace(id, policy);
    }
  }

  /** 增删设备或组的配置绑定；绑定为集合语义，重复添加不增加份数。 */
  bindProfiles(target: Target, addIds: string[], removeIds: string[]): void {
    const key = this.targetKey(target);
    const aggregate = this.aggregateForKey(key);
    for (const id of removeIds) {
      aggregate.remove(id);
      const targets = this.profileTargets.get(id);
      if (targets !== undefined) {
        targets.delete(key);
        if (targets.size === 0) this.profileTargets.delete(id);
      }
    }
    for (const id of addIds) {
      let targets = this.profileTargets.get(id);
      if (targets === undefined) {
        targets = new Set();
        this.profileTargets.set(id, targets);
      }
      if (targets.has(key)) continue;
      targets.add(key);
      aggregate.add(id, this.profiles.get(id) ?? {});
    }
  }

  /** 增删设备的组成员关系；成员关系为集合语义。 */
  joinGroups(deviceId: string, addGroupIds: string[], removeGroupIds: string[]): void {
    let groups = this.deviceGroups.get(deviceId);
    if (groups === undefined) {
      groups = new Set();
      this.deviceGroups.set(deviceId, groups);
    }
    for (const id of removeGroupIds) groups.delete(id);
    for (const id of addGroupIds) groups.add(id);
  }

  /** 返回设备当前的有效策略。 */
  resolve(deviceId: string): EffectivePolicy {
    let minPinLength = BASE_MIN_PIN_LENGTH;
    let maxAutoLockSeconds = BASE_MAX_AUTO_LOCK_SECONDS;
    let allowCamera = true;
    let allowScreenshots = true;
    const ssidSets: Array<ReadonlySet<string>> = [];

    const merge = (aggregate: ProfileAggregate): void => {
      const pin = aggregate.pinMax();
      if (pin !== undefined && pin > minPinLength) minPinLength = pin;
      const lock = aggregate.lockMin();
      if (lock !== undefined && lock < maxAutoLockSeconds) maxAutoLockSeconds = lock;
      if (aggregate.hasCameraDeny()) allowCamera = false;
      if (aggregate.hasScreenshotsDeny()) allowScreenshots = false;
      const intersection = aggregate.ssidIntersection();
      if (intersection !== null) ssidSets.push(intersection);
    };

    const direct = this.deviceAggregates.get(deviceId);
    if (direct !== undefined) merge(direct);
    const groups = this.deviceGroups.get(deviceId);
    if (groups !== undefined) {
      for (const groupId of groups) {
        const aggregate = this.groupAggregates.get(groupId);
        if (aggregate !== undefined) merge(aggregate);
      }
    }

    return {
      minPinLength,
      maxAutoLockSeconds,
      allowCamera,
      allowScreenshots,
      allowedSsids: intersectAll(ssidSets),
    };
  }

  private targetKey(target: Target): string {
    return target.kind === 'device' ? DEVICE_PREFIX + target.id : GROUP_PREFIX + target.id;
  }

  private aggregateForKey(key: string): ProfileAggregate {
    const isDevice = key.startsWith(DEVICE_PREFIX);
    const rawId = key.slice(isDevice ? DEVICE_PREFIX.length : GROUP_PREFIX.length);
    const map = isDevice ? this.deviceAggregates : this.groupAggregates;
    let aggregate = map.get(rawId);
    if (aggregate === undefined) {
      aggregate = new ProfileAggregate(this.stats);
      map.set(rawId, aggregate);
    }
    return aggregate;
  }
}

function intersectAll(sets: Array<ReadonlySet<string>>): string[] | null {
  if (sets.length === 0) return null;
  let smallest = sets[0] as ReadonlySet<string>;
  for (const set of sets) {
    if (set.size < smallest.size) smallest = set;
  }
  const result: string[] = [];
  for (const ssid of smallest) {
    let present = true;
    for (const set of sets) {
      if (!set.has(ssid)) {
        present = false;
        break;
      }
    }
    if (present) result.push(ssid);
  }
  result.sort();
  return result;
}
