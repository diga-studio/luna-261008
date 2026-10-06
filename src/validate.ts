import {
  ALPHABET,
  Challenge,
  DIGITS,
  MAX_FRAGMENTS,
  MAX_FRAGMENT_LENGTH,
  MAX_LENGTH,
  MAX_ORIGINAL_LENGTH,
  MIN_FRAGMENT_LENGTH,
  MIN_LENGTH,
  SPECIALS,
} from "./types";

const ALLOWED = new Set(ALPHABET.split(""));
const DIGIT_SET = new Set(DIGITS.split(""));
const SPECIAL_SET = new Set(SPECIALS.split(""));

function hasOnlyAllowedChars(value: string): boolean {
  for (const ch of value) {
    if (!ALLOWED.has(ch)) {
      return false;
    }
  }
  return true;
}

export function assertValidOriginal(original: string): void {
  if (typeof original !== "string") {
    throw new TypeError("original must be a string");
  }
  if (original.length > MAX_ORIGINAL_LENGTH) {
    throw new RangeError(`original must be at most ${MAX_ORIGINAL_LENGTH} characters`);
  }
  if (!hasOnlyAllowedChars(original)) {
    throw new RangeError("original contains characters outside a-z, 0-9, !@#");
  }
}

export function assertValidChallenge(challenge: Challenge): void {
  if (challenge === null || typeof challenge !== "object") {
    throw new TypeError("challenge must be an object");
  }
  const fragments = challenge.bannedFragments;
  if (!Array.isArray(fragments)) {
    throw new TypeError("challenge.bannedFragments must be an array");
  }
  if (fragments.length > MAX_FRAGMENTS) {
    throw new RangeError(`challenge allows at most ${MAX_FRAGMENTS} banned fragments`);
  }
  for (const fragment of fragments) {
    if (typeof fragment !== "string") {
      throw new TypeError("banned fragments must be strings");
    }
    if (fragment.length < MIN_FRAGMENT_LENGTH || fragment.length > MAX_FRAGMENT_LENGTH) {
      throw new RangeError(
        `banned fragment length must be ${MIN_FRAGMENT_LENGTH}..${MAX_FRAGMENT_LENGTH}`,
      );
    }
    if (!hasOnlyAllowedChars(fragment)) {
      throw new RangeError("banned fragment contains characters outside a-z, 0-9, !@#");
    }
  }
}

export function isCompliant(password: string, challenge: Challenge): boolean {
  assertValidChallenge(challenge);
  if (typeof password !== "string") {
    return false;
  }
  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    return false;
  }
  if (!hasOnlyAllowedChars(password)) {
    return false;
  }
  let hasDigit = false;
  let hasSpecial = false;
  let runLength = 1;
  for (let i = 0; i < password.length; i++) {
    const ch = password[i];
    if (DIGIT_SET.has(ch)) {
      hasDigit = true;
    } else if (SPECIAL_SET.has(ch)) {
      hasSpecial = true;
    }
    if (i > 0 && password[i - 1] === ch) {
      runLength += 1;
      if (runLength >= 3) {
        return false;
      }
    } else {
      runLength = 1;
    }
  }
  if (!hasDigit || !hasSpecial) {
    return false;
  }
  for (const fragment of challenge.bannedFragments) {
    if (password.includes(fragment)) {
      return false;
    }
  }
  return true;
}
