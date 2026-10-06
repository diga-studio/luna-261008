import type { Order, PlanInput, ReplayResult, DayRecord } from "./types";

/** Shelf life in days: a batch arriving on day t is usable on t, t+1, t+2. */
export const SHELF_LIFE_DAYS = 3;

interface Lot {
  arrivalDay: number;
  quantity: number;
}

function validateOrders(input: PlanInput, orders: Order[]): string[] {
  const errors: string[] = [];
  const allowed = new Set(input.allowedArrivalDays);
  const seenDays = new Set<number>();
  for (const order of orders) {
    if (!Number.isInteger(order.arrivalDay) || order.arrivalDay < 0 || order.arrivalDay >= input.days) {
      errors.push(`order arrival day ${order.arrivalDay} is outside the planning horizon`);
      continue;
    }
    if (!allowed.has(order.arrivalDay)) {
      errors.push(`order arrives on day ${order.arrivalDay}, which is not an allowed arrival day`);
    }
    if (order.arrivalDay - input.leadTime < 0) {
      errors.push(`order arriving day ${order.arrivalDay} would have to be placed before day 0 (leadTime=${input.leadTime})`);
    }
    if (seenDays.has(order.arrivalDay)) {
      errors.push(`more than one order arrives on day ${order.arrivalDay}`);
    }
    seenDays.add(order.arrivalDay);
    if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
      errors.push(`order quantity ${order.quantity} on day ${order.arrivalDay} is not a positive integer`);
    } else {
      if (order.quantity % input.packSize !== 0) {
        errors.push(`order quantity ${order.quantity} on day ${order.arrivalDay} is not a multiple of packSize=${input.packSize}`);
      }
      if (order.quantity < input.moq) {
        errors.push(`order quantity ${order.quantity} on day ${order.arrivalDay} is below MOQ=${input.moq}`);
      }
    }
  }
  return errors;
}

/**
 * Replays fixed batches plus the given purchase orders day by day and
 * reports consumption, expiry and balances. Everything is recomputed
 * from the input; no planner summaries are trusted.
 *
 * Each day: remove lots that expired at the start of the day, receive
 * fixed supply and new orders arriving that day, then satisfy the day's
 * demand FIFO by arrival day. Demand must be met in full on the day.
 */
export function replay(input: PlanInput, orders: Order[]): ReplayResult {
  const errors = validateOrders(input, orders);

  const fixedByDay = new Map<number, number>();
  for (const batch of input.fixedBatches) {
    if (batch.arrivalDay < 0) continue;
    fixedByDay.set(batch.arrivalDay, (fixedByDay.get(batch.arrivalDay) ?? 0) + batch.quantity);
  }
  const ordersByDay = new Map<number, number>();
  for (const order of orders) {
    ordersByDay.set(order.arrivalDay, (ordersByDay.get(order.arrivalDay) ?? 0) + order.quantity);
  }

  // Batches arriving before day 0 are initial stock already on hand.
  const lots: Lot[] = input.fixedBatches
    .filter((batch) => batch.arrivalDay < 0 && batch.quantity > 0)
    .sort((a, b) => a.arrivalDay - b.arrivalDay)
    .map((batch) => ({ arrivalDay: batch.arrivalDay, quantity: batch.quantity }));
  const records: DayRecord[] = [];
  let feasible = errors.length === 0;
  let shortageDay: number | undefined;

  for (let day = 0; day < input.days; day++) {
    // 1. Remove lots that expired at the start of today.
    let expired = 0;
    while (lots.length > 0 && lots[0]!.arrivalDay + SHELF_LIFE_DAYS <= day) {
      expired += lots.shift()!.quantity;
    }

    // 2. Receive fixed supply and new purchases arriving today.
    const arrivedToday = (fixedByDay.get(day) ?? 0) + (ordersByDay.get(day) ?? 0);
    if (arrivedToday > 0) {
      lots.push({ arrivalDay: day, quantity: arrivedToday });
    }

    // 3. Satisfy today's demand FIFO (oldest arrival day first).
    let need = input.demand[day]!;
    let consumed = 0;
    while (need > 0 && lots.length > 0) {
      const head = lots[0]!;
      const take = Math.min(head.quantity, need);
      head.quantity -= take;
      need -= take;
      consumed += take;
      if (head.quantity === 0) {
        lots.shift();
      }
    }
    if (need > 0 && shortageDay === undefined) {
      shortageDay = day;
      feasible = false;
    }

    let balance = 0;
    for (const lot of lots) {
      balance += lot.quantity;
    }
    records.push({ day, consumed, expired, balance });
  }

  let totalQuantity = 0;
  for (const order of orders) {
    totalQuantity += order.quantity;
  }

  const result: ReplayResult = {
    feasible,
    days: records,
    totalQuantity,
    orderCount: orders.length,
    errors,
  };
  if (shortageDay !== undefined) {
    result.shortageDay = shortageDay;
  }
  return result;
}
