/** A single cart line: one SKU with its original unit price and quantity. */
export interface CartLine {
  sku: string;
  /** Original unit price in integer cents. */
  unitPriceCents: number;
  quantity: number;
}

export type Cart = CartLine[];

/** Buy X get Y free activity. */
export interface BuyXGetYActivity {
  type: "buyXGetY";
  id: string;
  /** SKUs eligible as threshold (paid) items. */
  thresholdSkus: string[];
  /** SKUs eligible as gift (free) items. */
  giftSkus: string[];
  /** Positive integer: required threshold quantity. */
  x: number;
  /** Positive integer: required gift quantity. */
  y: number;
}

/** Whole-order percentage discount, integer 1..50. */
export interface PercentOffActivity {
  type: "percentOff";
  id: string;
  /** Integer percent in [1, 50]. */
  percent: number;
}

/** Fixed amount off in cents. */
export interface FixedOffActivity {
  type: "fixedOff";
  id: string;
  amountCents: number;
}

export type Activity = BuyXGetYActivity | PercentOffActivity | FixedOffActivity;

/**
 * Declares that two activities (by id) are allowed to stack on one order.
 * Pairs not listed here are not stackable.
 */
export interface StackablePair {
  activityIdA: string;
  activityIdB: string;
}

/** Per-SKU allocation of one applied buy-X-get-Y activity. */
export interface BuyXGetYAllocation {
  activityId: string;
  /** sku -> quantity used as threshold items. */
  threshold: Record<string, number>;
  /** sku -> quantity used as gift items. */
  gift: Record<string, number>;
}

export interface PricingResult {
  /** Lowest payable amount in integer cents. */
  payableCents: number;
  /** Ids of selected activities (0..2). */
  selectedActivityIds: string[];
  /** Allocations for each selected buy-X-get-Y activity. */
  allocations: BuyXGetYAllocation[];
}
