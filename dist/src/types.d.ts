/** 单份配置。所有字段可选；缺省字段表示该配置不施加对应约束。 */
export interface Policy {
    minPinLength?: number;
    maxAutoLockSeconds?: number;
    allowCamera?: boolean;
    allowScreenshots?: boolean;
    /** WiFi 白名单。缺省 = 不约束；空数组 = 禁止所有 WiFi。 */
    allowedSsids?: string[];
}
/** resolve 返回的有效策略（合并后的最终值）。 */
export interface EffectivePolicy {
    minPinLength: number;
    maxAutoLockSeconds: number;
    allowCamera: boolean;
    allowScreenshots: boolean;
    /** null = 无任何白名单约束；[] = 禁止所有 WiFi。 */
    allowedSsids: string[] | null;
}
/** 绑定目标：设备或组，由调用方区分。 */
export declare type Target = {
    readonly kind: 'device';
    readonly id: string;
} | {
    readonly kind: 'group';
    readonly id: string;
};
export declare const BASE_MIN_PIN_LENGTH = 6;
export declare const BASE_MAX_AUTO_LOCK_SECONDS = 120;
