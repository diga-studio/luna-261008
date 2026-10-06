/** A single path segment: object key (string) or array index (number). */
export type PathSegment = string | number;

/** A location inside a JSON document; root is the empty array. */
export type Path = PathSegment[];

/** Kind of a reported difference. */
export type DiffKind = 'added' | 'removed' | 'modified';

/** Severity assigned to a difference. */
export type Severity = 'critical' | 'medium' | 'low';

/**
 * A JSON value as parsed by this library. Numbers keep their raw literal so
 * no precision or formatting information is ever lost.
 */
export type ConfigNode =
  | { readonly type: 'null' }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'number'; readonly raw: string }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'array'; readonly items: readonly ConfigNode[] }
  | { readonly type: 'object'; readonly entries: ReadonlyArray<readonly [string, ConfigNode]> };

/** A difference before severity classification. */
export interface RawDiff {
  readonly path: Path;
  readonly kind: DiffKind;
  /** Baseline-side value; absent when the position is missing in baseline. */
  readonly baseline?: ConfigNode;
  /** Current-snapshot value; absent when the position is missing in current. */
  readonly current?: ConfigNode;
}

/** A single reported difference between baseline and current snapshot. */
export interface DiffEntry extends RawDiff {
  readonly severity: Severity;
}

/** Aggregate result of one comparison. */
export interface CompareReport {
  readonly diffs: readonly DiffEntry[];
  readonly counts: { readonly critical: number; readonly medium: number; readonly low: number };
  readonly score: number;
}
