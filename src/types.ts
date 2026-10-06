/** 单份配置：所有字段可选，缺省字段在合并时使用基础值。 */
export interface Policy {
  minPinLength?: number;
  maxAutoLockSeconds?: number;
  allowCamera?: boolean;
  allowScreenshots?: boolean;
  /** WiFi 白名单；缺省表示不施加约束，空数组表示禁止所有 WiFi。 */
  allowedSsids?: string[];
}

/** resolve 返回的有效策略，所有字段均为确定值。 */
export interface EffectivePolicy {
  minPinLength: number;
  maxAutoLockSeconds: number;
  allowCamera: boolean;
  allowScreenshots: boolean;
  /** null 表示没有任何适用配置声明白名单（不限制）。 */
  allowedSsids: string[] | null;
}

export type TargetKind = 'device' | 'group';

/** bindProfiles 的目标：设备或组。 */
export interface Target {
  kind: TargetKind;
  id: string;
}

export const BASE_MIN_PIN_LENGTH = 6;
export const BASE_MAX_AUTO_LOCK_SECONDS = 120;
