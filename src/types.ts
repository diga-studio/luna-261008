/** 一代密钥材料：代数 + 32 字节密钥（base64 持久化）。 */
export interface KeyMaterial {
  generation: number;
  /** base64 编码的 32 字节密钥 */
  key: string;
}

/** 端点收到的命令回执。 */
export interface Receipt {
  commandId: string;
  endpoint: EndpointRole;
  applied: boolean;
  /** 若为重放（幂等命中），此处为 true */
  replayed: boolean;
}

export type EndpointRole = "A" | "B";

/** 端点本地持久化状态。 */
export interface EndpointState {
  role: EndpointRole;
  /** 当前发送密钥 */
  sendKey: KeyMaterial | null;
  /** 可接收密钥集合：generation -> key */
  recvKeys: Record<string, string>;
  /** 已执行过的命令 id（幂等去重） */
  executedCommands: Record<string, Receipt>;
  /** 本端见过的最大密钥代数，用于拒绝旧代命令回退 */
  maxGenerationSeen: number;
}

/** 控制器侧单个隧道的持久化状态。 */
export interface TunnelState {
  id: string;
  /** 当前已完成的密钥代数 */
  generation: number;
  /** 当前代密钥材料（base64） */
  key: string;
  /** requestId -> 该请求分配到的密钥代数（保证同一 requestId 复用同一代同一材料） */
  requests: Record<string, number>;
  /** 每代密钥材料（保留历史以便重放时复用同一材料） */
  keys: Record<string, string>;
  /** 进行中的轮换所处阶段；null 表示空闲 */
  pending: PendingRotation | null;
}

export interface PendingRotation {
  requestId: string;
  generation: number;
}

/** inspect 结果。 */
export interface InspectResult {
  aToB: boolean;
  bToA: boolean;
  ok: boolean;
}
