/** 接口状态：只有 可用 / 不可用 两种。 */
export type InterfaceState = 'up' | 'down';

/**
 * 隧道生命周期状态。只有 'Active' 视为自身可用，
 * 其余任意字符串均视为不可用。
 */
export type TunnelState = string;

/** 状态记录作用的对象类别。 */
export type ObjectType = 'interface' | 'tunnel';

/** 上层追加的一条状态记录。 */
export interface StateRecord {
  /** 全局唯一编号；相同编号的内容保证相同，只生效一次。 */
  recordId: string;
  /** 对象类别：接口或隧道。 */
  objectType: ObjectType;
  /** 对象标识（接口 id 或隧道 id）。 */
  objectId: string;
  /** 对象内唯一序号；同一对象同一毫秒有多条记录时以序号最大者为准。 */
  seq: number;
  /** 整数毫秒业务时间。 */
  bizTime: number;
  /** 新状态：接口为 'up'/'down'，隧道为生命周期状态字符串。 */
  state: string;
}

/** 站点对可用率报告。 */
export interface AvailabilityReport {
  siteA: string;
  siteB: string;
  /** 窗口起点（含），整数毫秒。 */
  windowStart: number;
  /** 窗口终点（不含），整数毫秒。 */
  windowEnd: number;
  /** 窗口内可连通总时长（毫秒）。 */
  connectedMs: number;
  /** 可用率 = connectedMs / (windowEnd - windowStart)。 */
  availability: number;
}
