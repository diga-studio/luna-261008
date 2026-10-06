/** 分馆标识（调用方可信） */
export type BranchId = string;
/** 读者标识（调用方可信） */
export type ReaderId = string;
/** 题名 */
export type Title = string;
/** 册条码 */
export type Barcode = string;
/** 业务凭据（借出或调拨），不复用 */
export type Credential = string;

/** 预约状态 */
export type HoldStatus =
  | 'pending' // 排队中，未绑定册
  | 'bound' // 已绑定册（册在途或待调拨到馆）
  | 'ready' // 册已到领取分馆，可领取
  | 'fulfilled' // 已领取
  | 'cancelled'; // 已撤销

/** 册状态 */
export type CopyStatus =
  | 'on_shelf' // 在架
  | 'in_transit' // 在途（调拨中）
  | 'checked_out'; // 已借出

export interface HoldInfo {
  holdId: number;
  title: Title;
  reader: ReaderId;
  pickupBranch: BranchId;
  status: HoldStatus;
  /** 队列顺序（被接受的先后），取消后重新预约排到队尾 */
  queueSeq: number;
  /** 绑定的册条码（未绑定为 null） */
  barcode: Barcode | null;
}

export interface CopyInfo {
  barcode: Barcode;
  title: Title;
  status: CopyStatus;
  /** on_shelf: 所在分馆；in_transit: 既定目的分馆；checked_out: null */
  branch: BranchId | null;
  /** 当前关联的未完成预约（无则 null） */
  holdId: number | null;
  /** 当前在途调拨凭据（无则 null） */
  transferCredential: Credential | null;
  /** 当前借出凭据（无则 null） */
  loanCredential: Credential | null;
}

export interface TransferInfo {
  credential: Credential;
  barcode: Barcode;
  destBranch: BranchId;
  holdId: number | null;
  status: 'open' | 'closed';
}

export interface LoanInfo {
  credential: Credential;
  barcode: Barcode;
  reader: ReaderId;
  holdId: number;
  status: 'open' | 'closed';
}

export interface PlaceHoldResult {
  holdId: number;
}

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_cancelled' | 'already_fulfilled' };

export type PickupResult =
  | { ok: true; loanCredential: Credential }
  | { ok: false; reason: 'not_found' | 'not_ready' | 'wrong_reader' | 'wrong_branch' | 'already_cancelled' | 'already_fulfilled' };

export type CheckinResult =
  | { ok: true; kind: 'loan' | 'transfer' }
  | { ok: false; reason: 'unknown_credential' | 'already_closed' };
