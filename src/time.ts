const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Silent window: 22:00 (inclusive) to 06:00 (exclusive), UTC+8. */
export function isInSilentWindow(timeMs: number): boolean {
  const local = new Date(timeMs + UTC8_OFFSET_MS);
  const hour = local.getUTCHours();
  return hour >= 22 || hour < 6;
}

/** Next 06:00 (UTC+8) strictly after the given time, in epoch ms. */
export function nextSilentWindowEnd(timeMs: number): number {
  const localMs = timeMs + UTC8_OFFSET_MS;
  const localDayStart = Math.floor(localMs / DAY_MS) * DAY_MS;
  let end = localDayStart + 6 * 60 * 60 * 1000 - UTC8_OFFSET_MS;
  if (end <= timeMs) {
    end += DAY_MS;
  }
  return end;
}
