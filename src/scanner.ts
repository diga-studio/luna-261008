import { Lexer } from './lexer.ts';
import { Parser } from './parser.ts';
import type { ScanResult } from './types.ts';

/**
 * 单事件破坏性 SQL 扫描器。
 * 用法：构造实例 -> 逐段 push -> finish 取结果。
 * 每个事件使用独立实例；实例不跨事件复用，finish 后不保留原始 SQL 内容。
 */
export class DestructiveScanner {
  private readonly parser = new Parser();
  private readonly lexer = new Lexer((token) => this.parser.feed(token));

  /** 提交一段 UTF-8 字节（1 字节至 64 KiB，可切在任意字节位置）。 */
  push(chunk: Uint8Array): void {
    this.lexer.push(chunk);
  }

  /** 结束事件并返回结果。 */
  finish(): ScanResult {
    const clean = this.lexer.finish();
    return this.parser.finish(clean);
  }
}

/** 一次性扫描完整输入的便捷函数。 */
export function scanSql(input: string | Uint8Array): ScanResult {
  const scanner = new DestructiveScanner();
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  scanner.push(bytes);
  return scanner.finish();
}
