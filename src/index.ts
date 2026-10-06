import { diffTrees } from './compare';
import { parseJson } from './parser';
import { classify, computeScore } from './severity';
import type { DriftEntry, DriftReport, Path } from './types';

export * from './types';
export { parseJson } from './parser';
export { diffTrees } from './compare';
export type { RawDrift } from './compare';
export { normalizeNumber, normalizedEqual } from './decimal';
export { classify, computeScore } from './severity';

/**
 * Compare an approved baseline against a current snapshot.
 *
 * Both inputs are UTF-8 JSON texts (roots may be any JSON value). Numbers
 * compare by exact decimal value, object key order is ignored, and array
 * order matters. `criticalPaths` is the key-field registry using the same
 * path semantics as drift paths. The report is produced in memory; the
 * library does no version management.
 */
export function compareConfigs(
  baselineText: string,
  currentText: string,
  criticalPaths: readonly Path[] = [],
): DriftReport {
  const baseline = parseJson(baselineText);
  const current = parseJson(currentText);
  const drifts = diffTrees(baseline, current);
  const severities = classify(drifts, criticalPaths);
  const entries: DriftEntry[] = drifts.map((d, i) => ({
    path: d.path,
    kind: d.kind,
    severity: severities[i],
    ...(d.baseline !== undefined ? { baseline: d.baseline } : {}),
    ...(d.current !== undefined ? { current: d.current } : {}),
  }));
  let critical = 0;
  let medium = 0;
  let low = 0;
  for (const s of severities) {
    if (s === 'critical') critical += 1;
    else if (s === 'medium') medium += 1;
    else low += 1;
  }
  return {
    entries,
    counts: { critical, medium, low },
    score: computeScore(severities),
  };
}
