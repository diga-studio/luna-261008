/** 分馆标识 */
export type BranchId = string;
/** 册条码 */
export type Barcode = string;
/** 读者标识 */
export type ReaderId = string;
/** 题名 */
export type Title = string;
/** 业务凭据（借出/调拨各一次，不复用） */
export type Credential = string;

export type CopyStatus = 'on_shelf' | 'in_transit' | 'checked_out';

export type ReservationStatus = 'pending' | 'ready' | 'cancelled' | 'completed';

export interface CopyInfo {
  barcode: Barcode;
  title: Title;
  /** 当前所在分馆；在途时为出发馆 */
  branch: BranchId;
  status: CopyStatus;
  /** 在途时的目的分馆 */
  transitTo: BranchId | null;
  /** 当前绑定的预约 id */
  reservationId: number | null;
  /** 当前借出凭据 */
  loanCredential: Credential | null;
  /** 当前调拨凭据 */
  transferCredential: Credential | null;
}

export interface ReservationInfo {
  id: number;
  title: Title;
  reader: ReaderId;
  pickupBranch: BranchId;
  status: ReservationStatus;
  /** 绑定的册条码 */
  copyBarcode: Barcode | null;
  /** 队列中的序号（按接受先后） */
  seq: number;
}

export interface QueueEntry extends ReservationInfo {}

export interface CheckoutResult {
  loanCredential: Credential;
}

export interface TransferInfo {
  credential: Credential;
  barcode: Barcode;
  fromBranch: BranchId;
  toBranch: BranchId;
  arrived: boolean;
}
