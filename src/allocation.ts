import { PARTY_ROLES, type PartyAmounts, type PartyRole } from "./types.js";

export function computeCumulativeShares(
  totalRefunded: number,
  totalAmount: number,
  splits: PartyAmounts,
): PartyAmounts {
  if (totalRefunded === 0) {
    return { merchant: 0, platform: 0, partner: 0 };
  }
  const floors: Record<PartyRole, number> = { merchant: 0, platform: 0, partner: 0 };
  const remainders: { role: PartyRole; rem: number }[] = [];
  let floorSum = 0;
  for (const role of PARTY_ROLES) {
    const numerator = totalRefunded * splits[role];
    const floor = Math.floor(numerator / totalAmount);
    floors[role] = floor;
    floorSum += floor;
    remainders.push({ role, rem: numerator - floor * totalAmount });
  }
  let leftover = totalRefunded - floorSum;
  remainders.sort((a, b) => {
    if (b.rem !== a.rem) return b.rem - a.rem;
    return PARTY_ROLES.indexOf(a.role) - PARTY_ROLES.indexOf(b.role);
  });
  for (const entry of remainders) {
    if (leftover <= 0) break;
    floors[entry.role] += 1;
    leftover -= 1;
  }
  return floors;
}
