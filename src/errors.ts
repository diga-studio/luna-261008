export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export class PaymentNotFoundError extends LedgerError {
  constructor(paymentId: string) {
    super('PAYMENT_NOT_FOUND', `payment not found: ${paymentId}`);
  }
}

export class DuplicatePaymentError extends LedgerError {
  constructor(paymentId: string) {
    super('DUPLICATE_PAYMENT', `payment already recorded: ${paymentId}`);
  }
}

export class RefundNotFoundError extends LedgerError {
  constructor(key: string) {
    super('REFUND_NOT_FOUND', `refund not found: ${key}`);
  }
}

export class IdempotencyConflictError extends LedgerError {
  constructor(key: string) {
    super('IDEMPOTENCY_CONFLICT', `idempotency key reused with different request: ${key}`);
  }
}

export class ValidationError extends LedgerError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}
