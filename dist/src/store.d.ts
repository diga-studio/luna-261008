import { Application, Definition } from './types';
/** 内存状态 + JSON 文件持久化 */
export interface PersistedState {
    definitions: Definition[];
    applications: Application[];
    /** 操作标识 -> 首次业务结果（用于幂等重试） */
    opLog: Record<string, unknown>;
    seq: number;
}
export declare class Store {
    private readonly filePath;
    private readonly data;
    constructor(filePath: string);
    private load;
    get state(): PersistedState;
    /** 将当前状态原子落盘（先写临时文件再改名） */
    save(): void;
}
