import { diffNodes } from './diff.js';
import { parseJsonText } from './parser.js';
import { classifyDiffs } from './registry.js';
import type { CompareReport, DiffEntry, Path } from './types.js';

export * from './types.js';
export { parseJsonText } from './parser.js';
export { numberLiteralsEqual } from './decimal.js';

const CRITICAL_PENALTY = 15;
const MEDIUM_PENALTY = 5;
const LOW_PENALTY = 2;

/**
 * Compares an approved baseline against a current snapshot.
 * Both inputs are JSON texts; criticalPaths uses the same path semantics as
 * reported diffs (string keys and integer indices, root = []). The report is
 * returned in memory; no versioning or persistence is performed.
 */
export function compareConfigs(
  baselineText: string,
  currentText: string,
  criticalPaths: readonly Path[],
): CompareReport {
  const baseline = parseJsonText(baselineText);
  const current = parseJsonText(currentText);
  const rawDiffs = diffNodes(baseline, current);
  const severities = classifyDiffs(rawDiffs, baseline, current, criticalPaths);

  let critical = 0;
  let medium = 0;
  let low = 0;
  const diffs: DiffEntry[] = rawDiffs.map((raw, i) => {
    const severity = severities[i];
    if (severity === 'critical') critical++;
    else if (severity === 'medium') medium++;
    else low++;
    return { ...raw, severity };
  });

  const score = Math.max(
    0,
    100 - critical * CRITICAL_PENALTY - medium * MEDIUM_PENALTY - low * LOW_PENALTY,
  );
  return { diffs, counts: { critical, medium, low }, score };
}
