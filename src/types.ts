/** A label value assigned by a human annotator. */
export type Label = string;

/** Input descriptor for one image when the queue is created. */
export interface ImageInput {
  /** Unique positive integer id. */
  id: number;
  /** Feature vector, supplied by the caller. Treated as opaque read-only data. */
  features: readonly number[];
  /** Initial score in [0, 1]; belongs to generation 0. */
  score: number;
}

/** One item returned by getBatch. */
export interface BatchItem {
  id: number;
  score: number;
}

/** Result of getBatch: the published generation used plus the top items. */
export interface Batch {
  /** The published generation whose scores produced this batch. */
  generation: number;
  items: BatchItem[];
}

/**
 * Read-only snapshot of all finalized labels, captured exactly at the
 * change that triggered a training generation. Later relabels or
 * withdrawals never affect it, even if the trainer reads it lazily.
 */
export interface LabelSnapshot {
  /** The generation this snapshot belongs to. */
  readonly generation: number;
  /** Number of labeled images in the snapshot. */
  readonly size: number;
  get(imageId: number): Label | undefined;
  has(imageId: number): boolean;
  entries(): IterableIterator<readonly [number, Label]>;
}

/**
 * Called by the trainer to publish a batch of scores for its generation.
 * Awaitable; resolves once the scores are durably stored as pending scores
 * of that generation (they become visible only if the generation is
 * published as a whole).
 */
export type EmitFn = (scores: ReadonlyArray<readonly [number, number]>) => Promise<void>;

/**
 * Caller-supplied async training function. Receives the generation number,
 * a read-only label snapshot, the image features, and an emit function.
 * A successful trainer emits exactly one score in [0, 1] per image and then
 * returns; a failing trainer rejects/throws.
 */
export type Trainer = (
  generation: number,
  snapshot: LabelSnapshot,
  features: ReadonlyMap<number, readonly number[]>,
  emit: EmitFn,
) => Promise<void>;

/** Public queue handle returned by createQueue. */
export interface LabelQueue {
  /**
   * Write a finalized label. `null` (or `undefined`) withdraws the label.
   * Relabeling and withdrawal are allowed; writing the same value is a
   * no-op. Returns after the change is persisted, without waiting for
   * any training run.
   */
  setLabel(imageId: number, label: Label | null): void;
  /**
   * Query only: returns the current published generation and up to `size`
   * top unlabeled images according to that generation's complete ordering.
   */
  getBatch(size: number): Batch;
  /** Close the underlying database. */
  close(): void;
}
