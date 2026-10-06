import type { DatabaseSync } from "node:sqlite";
import type { Label, LabelSnapshot } from "./types.js";

/**
 * A label snapshot backed by the append-only `label_events` table.
 *
 * Every accepted label change is appended with the cumulative change
 * counter as its sequence number. A snapshot is just a (seq) cutoff:
 * reading "the latest event per image with seq <= cutoff" always yields
 * exactly the label state at the triggering change, no matter how many
 * relabels or withdrawals happen afterwards. Nothing is copied when the
 * snapshot is created, and reads stay correct forever.
 */
export class SqlLabelSnapshot implements LabelSnapshot {
  readonly generation: number;
  private readonly seq: number;
  private readonly db: DatabaseSync;
  private cachedSize: number | null = null;

  constructor(db: DatabaseSync, generation: number, seq: number) {
    this.db = db;
    this.generation = generation;
    this.seq = seq;
  }

  get size(): number {
    if (this.cachedSize === null) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM label_events e
             JOIN (SELECT image_id, MAX(seq) AS mseq
                     FROM label_events
                    WHERE seq <= ?
                    GROUP BY image_id) m
               ON m.image_id = e.image_id AND m.mseq = e.seq
            WHERE e.label IS NOT NULL`,
        )
        .get(this.seq);
      this.cachedSize = Number(row?.n ?? 0);
    }
    return this.cachedSize;
  }

  get(imageId: number): Label | undefined {
    const row = this.db
      .prepare(
        `SELECT label
           FROM label_events
          WHERE image_id = ? AND seq <= ?
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(imageId, this.seq);
    const label = row?.label;
    return typeof label === "string" ? label : undefined;
  }

  has(imageId: number): boolean {
    return this.get(imageId) !== undefined;
  }

  *entries(): IterableIterator<readonly [number, Label]> {
    const rows = this.db
      .prepare(
        `SELECT e.image_id AS image_id, e.label AS label
           FROM label_events e
           JOIN (SELECT image_id, MAX(seq) AS mseq
                   FROM label_events
                  WHERE seq <= ?
                  GROUP BY image_id) m
             ON m.image_id = e.image_id AND m.mseq = e.seq
          WHERE e.label IS NOT NULL
          ORDER BY e.image_id`,
      )
      .all(this.seq);
    for (const row of rows) {
      yield [Number(row.image_id), row.label as Label] as const;
    }
  }
}
