export class Bitset {
  words: Uint32Array;

  constructor(sizeInBits: number) {
    this.words = new Uint32Array(Math.ceil(sizeInBits / 32));
  }

  get(index: number): boolean {
    const word = this.words[index >>> 5];
    return word !== undefined && (word & (1 << (index & 31))) !== 0;
  }

  set(index: number): void {
    const slot = index >>> 5;
    const words = this.words;
    if (slot >= words.length) return;
    words[slot] = (words[slot] ?? 0) | (1 << (index & 31));
  }

  clear(index: number): void {
    const slot = index >>> 5;
    const words = this.words;
    if (slot >= words.length) return;
    words[slot] = (words[slot] ?? 0) & ~(1 << (index & 31));
  }

  count(): number {
    let total = 0;
    const words = this.words;
    for (let i = 0; i < words.length; i++) {
      total += popcount32(words[i] ?? 0);
    }
    return total;
  }

  countIntersection(other: Bitset): number {
    const a = this.words;
    const b = other.words;
    const n = Math.min(a.length, b.length);
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += popcount32((a[i] ?? 0) & (b[i] ?? 0));
    }
    return total;
  }

  ensureCapacity(sizeInBits: number): void {
    const needed = Math.ceil(sizeInBits / 32);
    if (needed <= this.words.length) return;
    let capacity = Math.max(this.words.length, 1);
    while (capacity < needed) capacity *= 2;
    const grown = new Uint32Array(capacity);
    grown.set(this.words);
    this.words = grown;
  }

  clone(): Bitset {
    const copy = new Bitset(0);
    copy.words = this.words.slice();
    return copy;
  }

  andInPlace(other: Bitset): void {
    const a = this.words;
    const b = other.words;
    for (let i = 0; i < a.length; i++) {
      a[i] = (a[i] ?? 0) & (b[i] ?? 0);
    }
  }

  orInPlace(other: Bitset): void {
    const a = this.words;
    const b = other.words;
    if (b.length > a.length) {
      this.ensureCapacity(b.length * 32);
    }
    const target = this.words;
    for (let i = 0; i < target.length; i++) {
      target[i] = (target[i] ?? 0) | (b[i] ?? 0);
    }
  }
}

function popcount32(value: number): number {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}
