import { type AddressFamily } from './ip.js';
import type { Rect } from './rect.js';
import type { ConcreteProtocol, Rule } from './types.js';
/** 一条规则在某个具体协议下的匹配矩形。 */
export interface RuleAtom {
    readonly protocol: ConcreteProtocol;
    readonly rect: Rect;
}
/** 编译后的规则：按检查顺序排列，携带展开后的原子矩形。 */
export interface CompiledRule {
    readonly rule: Rule;
    readonly family: AddressFamily;
    readonly atoms: readonly RuleAtom[];
}
export declare const MAX_RULES = 500;
export declare const MIN_PRIORITY = 1;
export declare const MAX_PRIORITY = 1000;
export declare const MIN_PORT = 0;
export declare const MAX_PORT = 65535;
/** 校验策略并按“优先级升序、同优先级按输入顺序”编译规则。 */
export declare function compilePolicy(rules: readonly Rule[]): CompiledRule[];
