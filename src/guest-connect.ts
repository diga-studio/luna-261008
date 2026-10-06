import { Store } from "./store.js";
import { compareWinnerKey, type SessionEvent } from "./types.js";

/**
 * GuestConnect offline session merge & version rollback library.
 *
 * - merge(): atomically commits a batch of events as a new version.
 *   Conflict order: updatedAt, then sourceAp (lexicographic), then sourceSeq.
 *   Deletions (value === null) participate in the same ordering and are kept
 *   as tombstones so older updates cannot resurrect a session.
 * - Every first-seen event identity (sourceAp, sourceSeq) enters a global
 *   dedup set regardless of whether it wins; retransmits are ignored.
 * - rollback(): commits a new version whose state equals the target version,
 *   including winner metadata needed for future conflict comparisons. The
 *   dedup set is NOT rolled back.
 */
export class GuestConnect {
  private readonly store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** Atomically merge a batch of events; returns the new version number. */
  merge(events: SessionEvent[]): number {
    return this.store.commit((txn) => {
      for (const event of events) {
        if (txn.isDuplicate(event.sourceAp, event.sourceSeq)) continue;
        txn.markSeen(event.sourceAp, event.sourceSeq);
        const current = txn.getSessionState(event.sessionId);
        if (current === undefined || compareWinnerKey(event, current) > 0) {
          txn.putSessionState(event.sessionId, {
            updatedAt: event.updatedAt,
            sourceAp: event.sourceAp,
            sourceSeq: event.sourceSeq,
            value: event.value,
          });
        }
      }
    });
  }

  /** Read the session value at a version; undefined if absent or deleted. */
  read(version: number, sessionId: string): Record<string, unknown> | undefined {
    if (!Number.isInteger(version) || version < 0 || version > this.store.getLatestVersion()) {
      throw new RangeError(`unknown version: ${version}`);
    }
    const state = this.store.getSessionState(version, sessionId);
    if (state === undefined || state.value === null) return undefined;
    return state.value;
  }

  /** Commit a new version whose state equals the target version. */
  rollback(version: number): number {
    if (!Number.isInteger(version) || version < 0 || version > this.store.getLatestVersion()) {
      throw new RangeError(`unknown version: ${version}`);
    }
    return this.store.commit((txn) => {
      txn.replaceAllFrom(version);
    });
  }

  /** Latest committed version number (0 = empty). */
  get currentVersion(): number {
    return this.store.getLatestVersion();
  }

  close(): void {
    this.store.close();
  }
}
