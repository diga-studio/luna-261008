import { Store } from "./db";
import type { Batch, EmitFn, ImageInput, Queue, Trainer } from "./types";

export const CHANGES_PER_GENERATION = 20;

/**
 * Build a queue over the given images. Initial scores are generation 0 and
 * are published immediately. Training generations are triggered by every
 * CHANGES_PER_GENERATION effective label changes and run concurrently in
 * the background; neither setLabel nor getBatch ever waits for them.
 */
export function createQueue(
  path: string,
  images: ImageInput[],
  trainer: Trainer
): Queue {
  const seen = new Set<number>();
  const features = new Map<number, readonly number[]>();
  for (const image of images) {
    if (!Number.isInteger(image.id) || image.id <= 0) {
      throw new Error(`image id must be a positive integer, got ${image.id}`);
    }
    if (seen.has(image.id)) {
      throw new Error(`duplicate image id: ${image.id}`);
    }
    seen.add(image.id);
    features.set(image.id, image.features);
  }

  const store = new Store(path);
  try {
    store.insertImages(images);
  } catch (err) {
    store.close();
    throw err;
  }

  const startGeneration = (generation: number): void => {
    // Synchronous snapshot: exactly the labels as of the triggering change.
    const labels = store.snapshotLabels();
    const emitted = new Map<number, number>();
    let invalid: string | null = null;

    const emit: EmitFn = (imageId, score) => {
      let error: string | null = null;
      if (!features.has(imageId)) {
        error = `emit for unknown image id: ${imageId}`;
      } else if (
        typeof score !== "number" ||
        Number.isNaN(score) ||
        score < 0 ||
        score > 1
      ) {
        error = `emit score out of range [0, 1] for image ${imageId}: ${score}`;
      }
      if (error !== null) {
        invalid = invalid ?? error;
        const rejected = Promise.reject(new Error(error));
        // Prevent an unhandled rejection if the trainer does not await emit;
        // the returned promise still rejects for trainers that do await.
        rejected.catch(() => undefined);
        return rejected;
      }
      emitted.set(imageId, score);
      return Promise.resolve();
    };

    const run = async (): Promise<void> => {
      try {
        await trainer(generation, labels, features, emit);
        if (invalid !== null) {
          return; // emit was misused: treat the generation as failed
        }
        if (emitted.size !== features.size) {
          return; // incomplete output: not a successful generation
        }
        // Publishes only if no newer generation is already published.
        store.publish(generation, emitted);
      } catch {
        // Failed generation: its scores are discarded, previously
        // published generations stay untouched.
      }
    };
    void run();
  };

  return {
    setLabel(imageId: number, label: string | null): void {
      const count = store.applyLabel(imageId, label);
      if (count > 0 && count % CHANGES_PER_GENERATION === 0) {
        startGeneration(count);
      }
    },
    getBatch(size: number): Batch {
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`batch size must be a non-negative integer, got ${size}`);
      }
      return {
        generation: store.publishedGeneration(),
        items: store.topBatch(size),
      };
    },
    close(): void {
      store.close();
    },
  };
}
