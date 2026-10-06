/** 组件：仅包含 id 与依赖列表 */
export interface Component {
    id: string;
    dependsOn: string[];
}
/** 签出凭证：不透明句柄，删除后重建同 ID 不会复用 */
export interface Lease {
    readonly token: string;
    readonly componentId: string;
    readonly actor: string;
    readonly expiresAt: number;
}
/** 一批原子编辑中的单条编辑 */
export declare type Edit = {
    kind: "upsert";
    component: Component;
} | {
    kind: "delete";
    id: string;
};
/** 单调时钟，可注入 */
export declare type Clock = () => number;
export declare class CheckoutError extends Error {
}
export declare class SaveError extends Error {
}
