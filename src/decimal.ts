/**
 * Exact decimal helpers. All arithmetic is done on BigInt at a fixed scale:
 *  - SCALE4 (1e4): general-ledger precision of actual amounts.
 *  - SCALE8 (1e8): precision of ideal (unrounded) shares.
 */

export const SCALE4 = 10_000n;
export const SCALE8 = 100_000_000n;

const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

/** Parse non-negative decimal text (<= 4 fractional digits) into 1e-4 units. */
export function parseAmount4(text: string): bigint {
  if (!AMOUNT_PATTERN.test(text)) {
    throw new Error(
      `invalid amount "${text}": expected a non-negative decimal with at most 4 fractional digits`,
    );
  }
  const [intPart, fracPart = ""] = text.split(".");
  return BigInt(intPart) * SCALE4 + BigInt((fracPart + "0000").slice(0, 4));
}

/** Format a 1e-4-unit integer as decimal text with exactly 4 fraction digits. */
export function formatAmount4(units: bigint): string {
  if (units < 0n) {
    throw new Error(`cannot format negative amount: ${units}`);
  }
  const intPart = units / SCALE4;
  const fracPart = (units % SCALE4).toString().padStart(4, "0");
  return `${intPart}.${fracPart}`;
}

/** Format a 1e-8-unit integer as decimal text, trailing zeros trimmed. */
export function formatAmount8(units: bigint): string {
  if (units < 0n) {
    throw new Error(`cannot format negative amount: ${units}`);
  }
  const intPart = units / SCALE8;
  let fracPart = (units % SCALE8).toString().padStart(8, "0");
  fracPart = fracPart.replace(/0+$/, "");
  return fracPart === "" ? `${intPart}` : `${intPart}.${fracPart}`;
}
