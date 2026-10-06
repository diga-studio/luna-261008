import type { EmitFn, ImageInput, Trainer } from "../src/types";

/** One started (and still paused) trainer invocation, driven by the test. */
export interface Run {
  readonly generation: number;
  readonly labels: ReadonlyMap<number, string>;
  readonly features: ReadonlyMap<number, readonly number[]>;
  readonly emit: EmitFn;
  emitAll(scores: Iterable<readonly [number, number]>): Promise<void>;
  /** Let the trainer return successfully. */
  succeed(): void;
  /** Make the trainer throw. */
  fail(error: unknown): void;
}

/**
 * A trainer stand-in that never proceeds on its own: every invocation is
 * parked until the test explicitly emits scores and calls succeed()/fail().
 */
export class TrainerRig {
  readonly runs = new Map<number, Run>();
  readonly trainer: Trainer;

  constructor() {
    this.trainer = (generation, labels, features, emit) =>
      new Promise<void>((resolve, reject) => {
        this.runs.set(generation, {
          generation,
          labels,
          features,
          emit,
          emitAll: async (scores) => {
            for (const [imageId, score] of scores) {
              await emit(imageId, score);
            }
          },
          succeed: () => resolve(),
          fail: (error) => reject(error),
        });
      });
  }

  run(generation: number): Run {
    const run = this.runs.get(generation);
    if (run === undefined) {
      throw new Error(`generation ${generation} was not started`);
    }
    return run;
  }

  get startedGenerations(): number[] {
    return [...this.runs.keys()];
  }
}

/** Let queued microtasks (trainer continuations, publish) run to completion. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function makeImages(
  count: number,
  scoreOf: (id: number) => number
): ImageInput[] {
  const images: ImageInput[] = [];
  for (let id = 1; id <= count; id++) {
    images.push({ id, features: [id, id * 2], score: scoreOf(id) });
  }
  return images;
}

/** Reference implementation of the queue ordering over a full score map. */
export function expectedOrder(
  scores: ReadonlyMap<number, number>,
  unlabelled: Iterable<number>
): number[] {
  const inBand = (score: number): number =>
    score >= 0.35 && score <= 0.65 ? 0 : 1;
  return [...unlabelled].sort((a, b) => {
    const scoreA = scores.get(a);
    const scoreB = scores.get(b);
    if (scoreA === undefined || scoreB === undefined) {
      throw new Error("missing score in reference ordering");
    }
    if (inBand(scoreA) !== inBand(scoreB)) {
      return inBand(scoreA) - inBand(scoreB);
    }
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return a - b;
  });
}
