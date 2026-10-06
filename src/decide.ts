import type { Connection, Permission, PolicyConfig } from "./types.js";

export function decide(
  config: PolicyConfig,
  profileId: string,
  deviceId: string,
  connection: Connection,
  minute: number
): Permission {
  throw new Error("not implemented");
}
