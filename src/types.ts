/** A single image handed to the queue at creation time. */
export interface ImageInput {
  /** Unique positive integer id. */
  id: number;
  /** Feature vector supplied by the caller; stored and passed to the trainer. */
  features: number[];
  /** Initial score, considered to belong to generation 0. */
  score: number;
}

/** One scored candidate returned by getBatch. */
export interface BatchItem {
  id: number;
  score: number;
}

/** Result of getBatch: the published generation plus its top candidates. */
export interface Batch {
  generation: number;
  items: BatchItem[];
}

/**
 * Called by a trainer to output scores in batches. Awaitable; resolves once
 * the score has been recorded for the (not yet published) generation.
 */
export type EmitFn = (imageId: number, score: number) => Promise<void>;

/**
 * Caller-supplied async training function.
 *
 * @param generation cumulative change count that triggered this generation
 * @param labels    read-only snapshot of the labels exactly as of the
 *                  triggering change (image id -> label)
 * @param features  read-only map of image id -> feature vector
 * @param emit      awaitable function to output one score per image
 */
export type Trainer = (
  generation: number,
  labels: ReadonlyMap<number, string>,
  features: ReadonlyMap<number, readonly number[]>,
  emit: EmitFn
) => Promise<void>;

export interface Queue {
  /**
   * Write a final label for an image. `null` withdraws the label.
   * Re-labelling and withdrawal are allowed; writing the same value is a
   * no-op. Returns after the change is persisted, without waiting for any
   * training it may have triggered.
   */
  setLabel(imageId: number, label: string | null): void;
  /**
   * Read-only query: returns the current published generation and up to
   * `size` unlabelled images, fully ordered by that generation's scores.
   */
  getBatch(size: number): Batch;
  /** Close the underlying database. */
  close(): void;
}
