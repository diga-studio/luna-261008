/** A single segment of a drift path: either an object key or an array index. */
export type PathSegment =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'index'; readonly index: number };

/** A path from the root; the root itself is the empty path. */
export type Path = readonly PathSegment[];

/** Convenience constructor for an object-key path segment. */
export function key(name: string): PathSegment {
  return { kind: 'key', key: name };
}

/** Convenience constructor for an array-index path segment. */
export function index(i: number): PathSegment {
  return { kind: 'index', index: i };
}

/** Normalized exact decimal used for numeric comparison. */
export interface NormalizedNumber {
  /** -1, 0 or 1. Zero is always sign 0 regardless of "-0". */
  readonly sign: -1 | 0 | 1;
  /** Significant digits with leading/trailing zeros stripped; empty when sign is 0. */
  readonly digits: string;
  /** Base-10 exponent of the normalized digit string (digits * 10^exp). */
  readonly exp: number;
}

/** Internal tree node produced by the parser. Numbers keep their raw literal. */
export type JsonNode =
  | { readonly kind: 'object'; readonly entries: ReadonlyMap<string, JsonNode> }
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly raw: string; readonly num: NormalizedNumber }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' };

/** A reported value preserves number raw literals so nothing is rounded. */
export type ReportedValue =
  | { readonly type: 'object'; readonly value: { readonly [k: string]: ReportedValue } }
  | { readonly type: 'array'; readonly value: readonly ReportedValue[] }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly raw: string }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'null' };

export type DriftKind = 'added' | 'removed' | 'modified';
export type Severity = 'critical' | 'medium' | 'low';

export interface DriftEntry {
  readonly path: Path;
  readonly kind: DriftKind;
  readonly severity: Severity;
  /** Present unless the value is missing on the baseline side. */
  readonly baseline?: ReportedValue;
  /** Present unless the value is missing on the current side. */
  readonly current?: ReportedValue;
}

export interface DriftReport {
  readonly entries: readonly DriftEntry[];
  readonly counts: { readonly critical: number; readonly medium: number; readonly low: number };
  /** Compliance score from 100; -15/-5/-2 per critical/medium/low, floored at 0. */
  readonly score: number;
}
