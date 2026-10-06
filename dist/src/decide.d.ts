import type { Connection, Permission, PolicyConfig } from "./types.js";
export declare function decide(config: PolicyConfig, profileId: string, deviceId: string, connection: Connection, minute: number): Permission;
