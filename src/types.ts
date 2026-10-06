/** 端点标识：一条隧道的两端。 */
export type EndpointId = "A" | "B";

/** 端点持久化到磁盘的本地状态。 */
export interface EndpointState {
  endpointId: EndpointId;
  /** 当前发送密钥（hex 编码的 32 字节）。 */
  sendKey: string;
  /** 可接收密钥集合（hex 编码）。 */
  receiveKeys: string[];
  /** 已应用过的命令 id，用于重放去重。 */
  appliedCommands: string[];
}

/** 端点支持的命令。 */
export type EndpointCommand =
  | { kind: "installReceiveKey"; commandId: string; key: string }
  | { kind: "switchSendKey"; commandId: string; key: string }
  | { kind: "removeReceiveKey"; commandId: string; key: string };

/** 命令执行回执。 */
export interface CommandReceipt {
  commandId: string;
  applied: boolean;
}

/** 单轮换的持久化记录。 */
export interface RotationRecord {
  requestId: string;
  /** 本轮密钥材料（hex），同一 requestId 复用同一份。 */
  key: string;
  stage: "created" | "installed" | "switchedA" | "switched" | "completed";
}

/** 控制器侧单隧道持久化状态。 */
export interface TunnelState {
  tunnelId: string;
  generation: number;
  rotations: RotationRecord[];
}
