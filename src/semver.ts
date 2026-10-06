import { InvalidVersionError } from "./errors.js";

export interface ParsedSemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemVer(version: string): ParsedSemVer {
  const m = SEMVER_RE.exec(version);
  if (!m) {
    throw new InvalidVersionError(`invalid SemVer 2.0.0 version: ${version}`);
  }
  const prerelease: (string | number)[] =
    m[4] === undefined
      ? []
      : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
  };
}

export function compareSemVer(a: ParsedSemVer, b: ParsedSemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i]!;
    const y = bp[i]!;
    if (x === y) continue;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  if (ap.length === bp.length) return 0;
  return ap.length < bp.length ? -1 : 1;
}
