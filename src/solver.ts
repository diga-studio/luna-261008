import {
  ALPHABET_SIZE,
  ForbiddenAutomaton,
  charToIndex,
  indexToChar,
  isDigitIndex,
  isSpecialIndex,
} from "./automaton";
import { Challenge, MAX_LENGTH, MIN_LENGTH, RepairSuggestion } from "./types";
import { assertValidChallenge, assertValidOriginal, isCompliant } from "./validate";

const RUN_STATES = 1 + ALPHABET_SIZE * 2;
const FLAG_COUNT = 4;
const FULL_FLAGS = 3;
const WIDTH = MAX_LENGTH + 1;
const INF = 1 << 28;

const OP_DELETE = 0;
const OP_INSERT = 1;
const OP_SUBSTITUTE = 2;

interface TransitionTables {
  nextState: Int32Array;
  groupStart: Uint32Array;
  groupNext: Int32Array;
  groupChar: Uint8Array;
}

function buildTransitions(automaton: ForbiddenAutomaton, stateCount: number): TransitionTables {
  const nodeCount = automaton.nodeCount;
  const nextState = new Int32Array(stateCount * ALPHABET_SIZE);
  for (let run = 0; run < RUN_STATES; run++) {
    const curChar = run === 0 ? -1 : (run - 1) >> 1;
    const runLen = run === 0 ? 0 : ((run - 1) & 1) + 1;
    for (let flags = 0; flags < FLAG_COUNT; flags++) {
      for (let ac = 0; ac < nodeCount; ac++) {
        const state = (run * FLAG_COUNT + flags) * nodeCount + ac;
        const row = state * ALPHABET_SIZE;
        for (let c = 0; c < ALPHABET_SIZE; c++) {
          const acNext = automaton.next(ac, c);
          let value = -1;
          if (!automaton.isTerminal(acNext)) {
            let runNext = -1;
            if (run === 0 || c !== curChar) {
              runNext = 1 + c * 2;
            } else if (runLen < 2) {
              runNext = 1 + c * 2 + 1;
            }
            if (runNext !== -1) {
              const flagsNext =
                flags | (isDigitIndex(c) ? 1 : 0) | (isSpecialIndex(c) ? 2 : 0);
              value = (runNext * FLAG_COUNT + flagsNext) * nodeCount + acNext;
            }
          }
          nextState[row + c] = value;
        }
      }
    }
  }

  const groupStart = new Uint32Array(stateCount + 1);
  const nextList: number[] = [];
  const charList: number[] = [];
  const seen = new Int32Array(stateCount).fill(-1);
  for (let state = 0; state < stateCount; state++) {
    groupStart[state] = nextList.length;
    const row = state * ALPHABET_SIZE;
    for (let c = 0; c < ALPHABET_SIZE; c++) {
      const target = nextState[row + c];
      if (target < 0 || seen[target] === state) {
        continue;
      }
      seen[target] = state;
      nextList.push(target);
      charList.push(c);
    }
  }
  groupStart[stateCount] = nextList.length;

  return {
    nextState,
    groupStart,
    groupNext: Int32Array.from(nextList),
    groupChar: Uint8Array.from(charList),
  };
}

export function suggestRepair(original: string, challenge: Challenge): RepairSuggestion {
  assertValidOriginal(original);
  assertValidChallenge(challenge);
  if (isCompliant(original, challenge)) {
    return { changes: 0, password: original };
  }

  const n = original.length;
  const automaton = new ForbiddenAutomaton(challenge.bannedFragments);
  const nodeCount = automaton.nodeCount;
  const stateCount = RUN_STATES * FLAG_COUNT * nodeCount;
  const tables = buildTransitions(automaton, stateCount);
  const { nextState, groupStart, groupNext, groupChar } = tables;

  const layerSize = WIDTH * stateCount;
  let prevLayer = new Int32Array(layerSize).fill(INF);
  let curLayer = new Int32Array(layerSize).fill(INF);
  const back = new Uint32Array((n + 1) * layerSize);
  prevLayer[0] = 0;

  for (let i = 0; i <= n; i++) {
    const origChar = i < n ? charToIndex(original[i]) : -1;
    for (let j = 0; j < WIDTH; j++) {
      const base = j * stateCount;
      for (let state = 0; state < stateCount; state++) {
        const value = prevLayer[base + state];
        if (value === INF) {
          continue;
        }
        if (i < n) {
          const target = base + state;
          if (value + 1 < curLayer[target]) {
            curLayer[target] = value + 1;
            back[((i + 1) * WIDTH + j) * stateCount + state] =
              (state << 8) | OP_DELETE;
          }
        }
        if (j < MAX_LENGTH) {
          const groupEnd = groupStart[state + 1];
          const insertBase = base + stateCount;
          const backInsertBase = (i * WIDTH + j + 1) * stateCount;
          for (let g = groupStart[state]; g < groupEnd; g++) {
            const next = groupNext[g];
            if (value + 1 < prevLayer[insertBase + next]) {
              prevLayer[insertBase + next] = value + 1;
              back[backInsertBase + next] =
                (state << 8) | (groupChar[g] << 2) | OP_INSERT;
            }
          }
          if (i < n) {
            const row = state * ALPHABET_SIZE;
            const matchNext = nextState[row + origChar];
            const subBase = base + stateCount;
            const backSubBase = ((i + 1) * WIDTH + j + 1) * stateCount;
            for (let g = groupStart[state]; g < groupEnd; g++) {
              const next = groupNext[g];
              const isMatch = matchNext === next;
              const cost = value + (isMatch ? 0 : 1);
              if (cost < curLayer[subBase + next]) {
                curLayer[subBase + next] = cost;
                back[backSubBase + next] =
                  (state << 8) | ((isMatch ? origChar : groupChar[g]) << 2) | OP_SUBSTITUTE;
              }
            }
          }
        }
      }
    }
    if (i < n) {
      const swap = prevLayer;
      prevLayer = curLayer;
      curLayer = swap;
      curLayer.fill(INF);
    }
  }

  let best = INF;
  let bestJ = -1;
  let bestState = -1;
  for (let j = MIN_LENGTH; j <= MAX_LENGTH; j++) {
    const base = j * stateCount;
    for (let run = 1; run < RUN_STATES; run++) {
      const stateBase = base + (run * FLAG_COUNT + FULL_FLAGS) * nodeCount;
      for (let ac = 0; ac < nodeCount; ac++) {
        const value = prevLayer[stateBase + ac];
        if (value < best) {
          best = value;
          bestJ = j;
          bestState = stateBase + ac - base;
        }
      }
    }
  }
  if (best === INF) {
    throw new Error("no compliant password is reachable");
  }

  const chars: number[] = [];
  let i = n;
  let j = bestJ;
  let state = bestState;
  while (i > 0 || j > 0) {
    const packed = back[(i * WIDTH + j) * stateCount + state];
    const op = packed & 3;
    const charIndex = (packed >> 2) & 0x3f;
    const prevState = packed >>> 8;
    if (op === OP_DELETE) {
      i--;
    } else {
      chars.push(charIndex);
      j--;
      if (op === OP_SUBSTITUTE) {
        i--;
      }
    }
    state = prevState;
  }
  chars.reverse();

  let password = "";
  for (const c of chars) {
    password += indexToChar(c);
  }
  return { changes: best, password };
}
