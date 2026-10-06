import { ReviewStore } from './store.ts';
import { importCsv } from './importer.ts';
import type { ImportResult, Review } from './types.ts';

export type { ImportResult, ImportStatus, RecordError, Review } from './types.ts';

/** 库入口：对某个 SQLite 数据库文件的评论导入/读取能力。 */
export interface ReviewLibrary {
  importCsv(merchantId: string, bytes: Uint8Array): ImportResult;
  listReviews(merchantId: string): Review[];
  close(): void;
}

export function createReviewLibrary(dbPath: string): ReviewLibrary {
  const store = new ReviewStore(dbPath);
  return {
    importCsv: (merchantId, bytes) => importCsv(store, merchantId, bytes),
    listReviews: (merchantId) => store.listReviews(merchantId),
    close: () => store.close(),
  };
}
