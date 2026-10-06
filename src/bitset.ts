/**
 * Growable bitset over dense user indexes, backed by a Uint32Array.
 * Used for segment membership and index posting lists.
 *
 * Out-of-range reads behave as 0; `set` grows the backing store
 * (amortized doubling). Set-algebra operators tolerate operands of
 * different lengths by treating missing words as zero.
 */
export class Bitset {
  words: Uint32Array;

  constructor(capacityBits = 1024) {
    this.words = new Uint32Array(Math.max(1, Math.ceil(capacityBits / 32)));
  }

  get bitLength(): number {
    return this.words.length * 32;
  }

  private ensureWord(wordIndex: number): void {
    if (wordIndex < this.words.length) return;
    let next = this.words.length;
    while (next <= wordIndex) next *= 2;
    const grown = new Uint32Array(next);
    grown.set(this.words);
    this.words = grown;
  }

  get(index: number): number {
    const word = index >>> 5;
    if (word >= this.words.length) return 0;
    return (this.words[word] >>> (index & 31)) & 1;
  }

  set(index: number): void {
    const word = index >>> 5;
    this.ensureWord(word);
    this.words[word] |= 1 << (index & 31);
  }

  clear(index: number): void {
    const word = index >>> 5;
    if (word >= this.words.length) return;
    this.words[word] &= ~(1 << (index & 31));
  }

  clone(): Bitset {
    const copy = new Bitset(0);
    copy.words = this.words.slice();
    return copy;
  }

  /** this &= other (words beyond other's length become 0). */
  andWith(other: Bitset): this {
    const a = this.words;
    const b = other.words;
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) a[i] &= b[i];
    for (let i = shared; i < a.length; i++) a[i] = 0;
    return this;
  }

  /** this |= other (grows to other's length if needed). */
  orWith(other: Bitset): this {
    const b = other.words;
    this.ensureWord(b.length - 1);
    const a = this.words;
    for (let i = 0; i < b.length; i++) a[i] |= b[i];
    return this;
  }

  /** this &= ~other. */
  andNotWith(other: Bitset): this {
    const a = this.words;
    const b = other.words;
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) a[i] &= ~b[i];
    return this;
  }

  popcount(): number {
    const a = this.words;
    let total = 0;
    for (let i = 0; i < a.length; i++) {
      let x = a[i];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      x = (x + (x >>> 4)) & 0x0f0f0f0f;
      total += (x * 0x01010101) >>> 24;
    }
    return total;
  }

  /** |a ∩ b| without materializing the intersection. */
  static intersectionCount(a: Bitset, b: Bitset): number {
    const wa = a.words;
    const wb = b.words;
    const shared = Math.min(wa.length, wb.length);
    let total = 0;
    for (let i = 0; i < shared; i++) {
      let x = wa[i] & wb[i];
      x -= (x >>> 1) & 0x55555555;
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      x = (x + (x >>> 4)) & 0x0f0f0f0f;
      total += (x * 0x01010101) >>> 24;
    }
    return total;
  }
}
