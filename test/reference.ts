import {
  BASE_MAX_AUTO_LOCK_SECONDS,
  BASE_MIN_PIN_LENGTH,
  EffectivePolicy,
  Policy,
  Target,
} from '../src/types';

/**
 * 参考模型：resolve 时逐份扫描设备命中的全部原始配置并合并。
 * 只用于测试对照，不考虑性能。
 */
export class ReferenceFleetGuard {
  private readonly profiles = new Map<string, Policy>();
  private readonly deviceBindings = new Map<string, Set<string>>();
  private readonly groupBindings = new Map<string, Set<string>>();
  private readonly memberships = new Map<string, Set<string>>();

  putProfile(id: string, policy: Policy): void {
    this.profiles.set(id, policy);
  }

  bindProfiles(target: Target, addIds: string[], removeIds: string[]): void {
    const map = target.kind === 'device' ? this.deviceBindings : this.groupBindings;
    let set = map.get(target.id);
    if (set === undefined) {
      set = new Set();
      map.set(target.id, set);
    }
    for (const id of removeIds) set.delete(id);
    for (const id of addIds) set.add(id);
  }

  joinGroups(deviceId: string, addGroupIds: string[], removeGroupIds: string[]): void {
    let set = this.memberships.get(deviceId);
    if (set === undefined) {
      set = new Set();
      this.memberships.set(deviceId, set);
    }
    for (const id of removeGroupIds) set.delete(id);
    for (const id of addGroupIds) set.add(id);
  }

  resolve(deviceId: string): EffectivePolicy {
    const hit = new Set<string>();
    const direct = this.deviceBindings.get(deviceId);
    if (direct !== undefined) {
      for (const id of direct) hit.add(id);
    }
    const groups = this.memberships.get(deviceId);
    if (groups !== undefined) {
      for (const groupId of groups) {
        const bound = this.groupBindings.get(groupId);
        if (bound !== undefined) {
          for (const id of bound) hit.add(id);
        }
      }
    }

    let minPinLength = BASE_MIN_PIN_LENGTH;
    let maxAutoLockSeconds = BASE_MAX_AUTO_LOCK_SECONDS;
    let allowCamera = true;
    let allowScreenshots = true;
    let ssids: Set<string> | null = null;

    for (const id of hit) {
      const policy = this.profiles.get(id);
      if (policy === undefined) continue;
      if (policy.minPinLength !== undefined && policy.minPinLength > minPinLength) {
        minPinLength = policy.minPinLength;
      }
      if (
        policy.maxAutoLockSeconds !== undefined &&
        policy.maxAutoLockSeconds < maxAutoLockSeconds
      ) {
        maxAutoLockSeconds = policy.maxAutoLockSeconds;
      }
      if (policy.allowCamera === false) allowCamera = false;
      if (policy.allowScreenshots === false) allowScreenshots = false;
      if (policy.allowedSsids !== undefined) {
        const declared = new Set(policy.allowedSsids);
        if (ssids === null) {
          ssids = declared;
        } else {
          for (const ssid of ssids) {
            if (!declared.has(ssid)) ssids.delete(ssid);
          }
        }
      }
    }

    return {
      minPinLength,
      maxAutoLockSeconds,
      allowCamera,
      allowScreenshots,
      allowedSsids: ssids === null ? null : [...ssids].sort(),
    };
  }
}
