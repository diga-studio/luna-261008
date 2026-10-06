import type { PlanInput, Order, ReplayResult } from "./types";

const SHELF_LIFE = 3;

interface Batch {
  arrivalDay: number;
  quantity: number;
}

function invalid(error: string): ReplayResult {
  return { feasible: false, error, daily: [], totalConsumed: 0, totalExpired: 0 };
}

export function replay(input: PlanInput, orders: Order[]): ReplayResult {
  const { days, demand, fixedBatches, allowedArrivalDays, leadTime, packSize, moq } = input;

  const allowed = new Set(allowedArrivalDays);
  const orderByDay = new Map<number, number>();
  for (const order of orders) {
    const { arrivalDay, quantity } = order;
    if (!Number.isInteger(arrivalDay) || arrivalDay < 0 || arrivalDay >= days) {
      return invalid(`order arrival day ${arrivalDay} is outside the planning horizon`);
    }
    if (!allowed.has(arrivalDay)) {
      return invalid(`order arrival day ${arrivalDay} is not an allowed arrival day`);
    }
    if (arrivalDay - leadTime < 0) {
      return invalid(`order arriving day ${arrivalDay} would have to be purchased before day 0`);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return invalid(`order quantity ${quantity} is not a positive integer`);
    }
    if (quantity % packSize !== 0) {
      return invalid(`order quantity ${quantity} is not a multiple of packSize ${packSize}`);
    }
    if (quantity < moq) {
      return invalid(`order quantity ${quantity} is below MOQ ${moq}`);
    }
    if (orderByDay.has(arrivalDay)) {
      return invalid(`more than one order arrives on day ${arrivalDay}`);
    }
    orderByDay.set(arrivalDay, quantity);
  }

  const fixedByDay = new Map<number, number>();
  for (const batch of fixedBatches) {
    fixedByDay.set(batch.arrivalDay, (fixedByDay.get(batch.arrivalDay) ?? 0) + batch.quantity);
  }

  const inventory: Batch[] = [];
  for (const [arrivalDay, quantity] of fixedByDay) {
    if (arrivalDay < 0) inventory.push({ arrivalDay, quantity });
  }
  inventory.sort((x, y) => x.arrivalDay - y.arrivalDay);

  const daily: ReplayResult["daily"] = [];
  let feasible = true;
  let totalConsumed = 0;
  let totalExpired = 0;

  for (let day = 0; day < days; day++) {
    let expired = 0;
    for (let i = inventory.length - 1; i >= 0; i--) {
      const batch = inventory[i]!;
      if (batch.arrivalDay + SHELF_LIFE <= day) {
        expired += batch.quantity;
        inventory.splice(i, 1);
      }
    }

    const fixedToday = fixedByDay.get(day);
    if (fixedToday !== undefined && fixedToday > 0) {
      inventory.push({ arrivalDay: day, quantity: fixedToday });
    }
    const orderToday = orderByDay.get(day);
    if (orderToday !== undefined) {
      inventory.push({ arrivalDay: day, quantity: orderToday });
    }

    let need = demand[day]!;
    let available = 0;
    for (const batch of inventory) available += batch.quantity;
    if (available < need) feasible = false;
    const consumed = Math.min(need, available);

    let remaining = consumed;
    for (const batch of inventory) {
      if (remaining === 0) break;
      const take = Math.min(batch.quantity, remaining);
      batch.quantity -= take;
      remaining -= take;
    }

    let endBalance = 0;
    for (let i = inventory.length - 1; i >= 0; i--) {
      if (inventory[i]!.quantity === 0) inventory.splice(i, 1);
      else endBalance += inventory[i]!.quantity;
    }

    daily.push({ day, consumed, expired, endBalance });
    totalConsumed += consumed;
    totalExpired += expired;
  }

  return { feasible, daily, totalConsumed, totalExpired };
}
