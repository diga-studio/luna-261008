// Minimal ambient declaration for Node's Buffer (base64 cursor encoding),
// so the library type-checks without @types/node.
declare class Buffer {
  static from(data: string, encoding: "utf8" | "base64"): Buffer;
  toString(encoding: "utf8" | "base64"): string;
}
