export const MIN_LENGTH = 12;
export const MAX_LENGTH = 20;
export const MAX_ORIGINAL_LENGTH = 32;
export const MAX_FRAGMENTS = 8;
export const MIN_FRAGMENT_LENGTH = 2;
export const MAX_FRAGMENT_LENGTH = 6;

export const LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const DIGITS = "0123456789";
export const SPECIALS = "!@#";
export const ALPHABET = LETTERS + DIGITS + SPECIALS;

export interface Challenge {
  readonly bannedFragments: readonly string[];
}

export interface RepairSuggestion {
  readonly changes: number;
  readonly password: string;
}
