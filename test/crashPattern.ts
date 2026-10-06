/** Deterministic record pattern shared by the crash child and its parent test. */
export const CHILD_RECORD_COUNT = 50;
export const CHILD_CUTOFF = 1_700_000_100_000;

export function childTime(index: number): number {
  // Scrambled times around the cutoff: some before, some exactly at, some after.
  const scramble = (index * 37) % CHILD_RECORD_COUNT;
  return CHILD_CUTOFF - 2_500 + scramble * 100;
}

export function childBody(index: number): string {
  return JSON.stringify({ child: true, index, pad: "x".repeat(index % 13) });
}
