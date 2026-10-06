import type { EffectivePolicy, Policy, Target } from '../src/index.js';
import { BASE_MAX_AUTO_LOCK_SECONDS, BASE_MIN_PIN_LENGTH } from '../src/index.js';

/**
 * 参考模型：每次 resolve 都逐份扫描该设备命中的全部原始配置并合并。
 * 只追求显然正确，不追求效率，用于对照验证增量实现。
 */
export class ReferenceModel {
  private readonly profiles = new Map<string, Policy>();
  private readonly deviceBindings = new Map<string, Set<string>>();
  private readonly groupBindings = new Map<string, Set<string>>();
  private readonly deviceGroups = new Map<string, Set<string>>();

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
    let set = this.deviceGroups.get(deviceId);
    if (set === undefined) {
      set = new Set();
      this.deviceGroups.set(deviceId, set);
    }
    for (const id of removeGroupIds) set.delete(id);
    for (const id of addGroupIds) set.add(id);
  }

  resolve(deviceId: string): EffectivePolicy {
    let minPinLength = BASE_MIN_PIN_LENGTH;
    let maxAutoLockSeconds = BASE_MAX_AUTO_LOCK_SECONDS;
    let allowCamera = true;
    let allowScreenshots = true;
    const whitelists: string[][] = [];

    const apply = (policy: Policy): void => {
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
        whitelists.push([...new Set(policy.allowedSsids)]);
      }
    };

    for (const id of this.deviceBindings.get(deviceId) ?? []) {
      const policy = this.profiles.get(id);
      if (policy !== undefined) apply(policy);
    }
    for (const groupId of this.deviceGroups.get(deviceId) ?? []) {
      for (const id of this.groupBindings.get(groupId) ?? []) {
        const policy = this.profiles.get(id);
        if (policy !== undefined) apply(policy);
      }
    }

    let allowedSsids: string[] | null = null;
    if (whitelists.length > 0) {
      const [first, ...rest] = whitelists as [string[], ...string[][]];
      allowedSsids = first.filter((ssid) => rest.every((list) => list.includes(ssid))).sort();
    }
    return { minPinLength, maxAutoLockSeconds, allowCamera, allowScreenshots, allowedSsids };
  }
}

/** 确定性伪随机数（mulberry32）。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}
