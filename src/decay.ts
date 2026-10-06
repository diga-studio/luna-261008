export const DAY_MS = 86_400_000;
export const FULL_WINDOW_MS = 30 * DAY_MS;
export const MID_WINDOW_MS = 90 * DAY_MS;

export function decayPercent(ageMs: number): number {
  if (ageMs <= FULL_WINDOW_MS) return 100;
  if (ageMs <= MID_WINDOW_MS) return 75;
  return 40;
}

export function companyScore(companySize: number): number {
  if (companySize <= 50) return 10;
  if (companySize <= 200) return 20;
  if (companySize <= 1000) return 35;
  return 50;
}
