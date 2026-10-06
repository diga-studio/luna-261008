import { parentPort, workerData } from 'node:worker_threads';
import { Ledger } from '../src/index.ts';

interface Job {
  dbPath: string;
  merchantId: string;
  paymentId: string;
  key: string;
  amount: number;
  result: 'succeeded' | 'failed' | 'processing' | null;
}

const job = workerData as Job;
const ledger = new Ledger(job.dbPath);
try {
  ledger.requestRefund({
    merchantId: job.merchantId,
    paymentId: job.paymentId,
    idempotencyKey: job.key,
    amount: job.amount,
  });
  if (job.result) {
    ledger.receiveRefundResult({
      merchantId: job.merchantId,
      paymentId: job.paymentId,
      idempotencyKey: job.key,
      kind: job.result,
    });
  }
  parentPort?.postMessage({ accepted: true });
} catch (err) {
  parentPort?.postMessage({ accepted: false, error: String(err) });
} finally {
  ledger.close();
}
