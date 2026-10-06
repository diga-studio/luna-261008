/** Deterministic record content shared by the crash child and its parent test. */
export const CHILD_T0 = 1_600_000_000_000;
export const CHILD_HOUR = 3_600_000;

export function childEventTime(i: number): number {
  // Deterministic shuffle: ids do not track event time.
  return CHILD_T0 + ((i * 7919) % 23) * CHILD_HOUR;
}

export function childBody(i: number): unknown {
  return { seq: i, tag: `rec-${i}`, payload: `payload-${i}-` + "x".repeat(i % 17) };
}
