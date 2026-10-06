/** Parsed SemVer 2.0.0 version. Build metadata is kept for identity but ignored in precedence. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, empty array when absent. */
  prerelease: string[];
  /** Build metadata without the leading '+'. */
  build: string;
}

const NUMERIC = /^[0-9]+$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const NUMERIC_NO_LEADING_ZERO = /^(0|[1-9][0-9]*)$/;

/** Parse a SemVer 2.0.0 string. Throws on invalid input. */
export function parseSemVer(version: string): SemVer {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`invalid semver: ${String(version)}`);
  }
  let rest = version;
  let build = '';
  const plusIndex = rest.indexOf('+');
  if (plusIndex !== -1) {
    build = rest.slice(plusIndex + 1);
    rest = rest.slice(0, plusIndex);
    if (rest.indexOf('+') !== -1) {
      throw new Error(`invalid semver (multiple '+'): ${version}`);
    }
    validateDotSeparatedIdentifiers(build, false, version);
  }
  let prerelease: string[] = [];
  const dashIndex = rest.indexOf('-');
  let core = rest;
  if (dashIndex !== -1) {
    core = rest.slice(0, dashIndex);
    const prereleaseText = rest.slice(dashIndex + 1);
    prerelease = validateDotSeparatedIdentifiers(prereleaseText, true, version);
  }
  const parts = core.split('.');
  if (parts.length !== 3 || parts.some((p) => !NUMERIC_NO_LEADING_ZERO.test(p))) {
    throw new Error(`invalid semver core: ${version}`);
  }
  const [major, minor, patch] = parts.map((p) => Number(p));
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) {
    throw new Error(`semver number out of range: ${version}`);
  }
  return { major, minor, patch, prerelease, build };
}

function validateDotSeparatedIdentifiers(
  text: string,
  isPrerelease: boolean,
  original: string,
): string[] {
  const identifiers = text.split('.');
  if (identifiers.length === 0 || identifiers.some((id) => id.length === 0)) {
    throw new Error(`invalid semver identifiers: ${original}`);
  }
  for (const id of identifiers) {
    if (!IDENTIFIER.test(id)) {
      throw new Error(`invalid semver identifier "${id}": ${original}`);
    }
    if (isPrerelease && NUMERIC.test(id) && !NUMERIC_NO_LEADING_ZERO.test(id)) {
      throw new Error(`numeric prerelease identifier with leading zero: ${original}`);
    }
  }
  return identifiers;
}

function compareNumericIdentifiers(a: string, b: string): number {
  // Both are pure digits without leading zeros; compare by length then lexically.
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare SemVer precedence per semver.org rules.
 * Build metadata is ignored. Returns negative if a < b, 0 if equal precedence, positive if a > b.
 */
export function comparePrecedence(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // release > prerelease
  if (bPre.length === 0) return -1;
  const common = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < common; i++) {
    const x = aPre[i];
    const y = bPre[i];
    if (x === y) continue;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) return compareNumericIdentifiers(x, y);
    if (xNumeric) return -1; // numeric < alphanumeric
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  if (aPre.length !== bPre.length) return aPre.length < bPre.length ? -1 : 1;
  return 0;
}
