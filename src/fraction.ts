/** Exact rational number backed by BigInt, normalized to lowest terms. */
export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den === 0n) throw new Error("fraction with zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(abs(num), den);
    this.num = num / g;
    this.den = den / g;
  }

  /** Parse a finite decimal string such as "2", "0.5" or "-1.25" exactly. */
  static fromDecimal(text: string): Fraction {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!m) throw new Error(`invalid decimal: ${text}`);
    const fracDigits = m[3] ?? "";
    const den = 10n ** BigInt(fracDigits.length);
    const num = BigInt(m[2] + fracDigits);
    return new Fraction(m[1] === "-" ? -num : num, den);
  }

  /** Treat a JS number's shortest decimal form as its exact value. */
  static fromNumber(value: number): Fraction {
    if (!Number.isFinite(value)) throw new Error(`invalid weight: ${value}`);
    return Fraction.fromDecimal(String(value));
  }

  static zero(): Fraction {
    return new Fraction(0n);
  }

  add(other: Fraction): Fraction {
    return new Fraction(
      this.num * other.den + other.num * this.den,
      this.den * other.den
    );
  }

  mul(other: Fraction): Fraction {
    return new Fraction(this.num * other.num, this.den * other.den);
  }

  div(other: Fraction): Fraction {
    if (other.num === 0n) throw new Error("division by zero fraction");
    return new Fraction(this.num * other.den, this.den * other.num);
  }

  /** -1 / 0 / 1 as this compares to other. */
  cmp(other: Fraction): number {
    const lhs = this.num * other.den;
    const rhs = other.num * this.den;
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
  }

  /** Nearest integer, ties rounded away from zero. */
  roundHalfUp(): bigint {
    const q = this.num / this.den;
    const r = this.num % this.den;
    const doubled = r < 0n ? -2n * r : 2n * r;
    if (doubled >= this.den) {
      return q + (this.num < 0n ? -1n : 1n);
    }
    return q;
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}
