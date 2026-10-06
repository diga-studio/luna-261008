/**
 * Incremental UTF-8 decoder. Accepts arbitrary byte chunks (boundaries may
 * split a multi-byte sequence) and emits Unicode code points. Input is
 * assumed to be valid UTF-8 as guaranteed by the component contract.
 */
export class Utf8Decoder {
  private leftover = new Uint8Array(4);
  private leftoverLength = 0;

  /** Feed a byte chunk; returns the code points completed by these bytes. */
  push(chunk: Uint8Array): number[] {
    const pending = this.leftoverLength;
    let bytes: Uint8Array;
    if (pending > 0) {
      bytes = new Uint8Array(pending + chunk.length);
      bytes.set(this.leftover.subarray(0, pending), 0);
      bytes.set(chunk, pending);
    } else {
      bytes = chunk;
    }

    const codePoints: number[] = [];
    const n = bytes.length;
    let i = 0;
    while (i < n) {
      const b0 = bytes[i]!;
      let length: number;
      let cp: number;
      if (b0 < 0x80) {
        length = 1;
        cp = b0;
      } else if (b0 < 0xe0) {
        length = 2;
        cp = b0 & 0x1f;
      } else if (b0 < 0xf0) {
        length = 3;
        cp = b0 & 0x0f;
      } else {
        length = 4;
        cp = b0 & 0x07;
      }
      if (i + length > n) break;
      for (let k = 1; k < length; k++) {
        cp = (cp << 6) | (bytes[i + k]! & 0x3f);
      }
      codePoints.push(cp);
      i += length;
    }

    this.leftoverLength = n - i;
    if (this.leftoverLength > 0) {
      this.leftover.set(bytes.subarray(i, n), 0);
    }
    return codePoints;
  }

  /** Signal end of input. Throws if a truncated multi-byte sequence remains. */
  finish(): number[] {
    if (this.leftoverLength > 0) {
      this.leftoverLength = 0;
      throw new Error("invalid UTF-8: truncated multi-byte sequence at end of input");
    }
    return [];
  }
}
