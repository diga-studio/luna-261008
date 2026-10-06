export type ErrorCode =
  | 'LOCATION_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ALREADY_EXISTS'
  | 'FULFILLMENT_NOT_FOUND'
  | 'FULFILLMENT_NOT_ACTIVE'
  | 'INSUFFICIENT_STOCK'
  | 'INSUFFICIENT_CAPACITY'
  | 'QUANTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'STORE_CLOSED';

export class StoreError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
