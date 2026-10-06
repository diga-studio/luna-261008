import { RuleNode } from './types';

/** Internal, mutable profile view used by compiled matchers. */
export interface MatcherProfile {
  engagementScore: number | null;
  region: string | null;
  purchaseTags: readonly string[];
}

export type Matcher = (profile: MatcherProfile) => boolean;

// Instruction set for the compiled matcher VM. Compiling to a flat jump
// program (instead of generating one JS function per segment) keeps memory
// bounded when thousands of segments are evaluated millions of times: only
// one shared interpreter is JIT-compiled, and each segment is plain data.
const OP_SCORE = 0; // [OP_SCORE, min, max, trueTarget, falseTarget]
const OP_REGION = 1; // [OP_REGION, value, , trueTarget, falseTarget]
const OP_TAG = 2; // [OP_TAG, value, , trueTarget, falseTarget]
const OP_RETURN = 3; // [OP_RETURN, value]

type Instruction = [number, unknown, unknown, number, number] | [number, boolean];

/**
 * Compiles a rule tree into a fast per-profile predicate.
 * Used only for profiles that actually changed in a batch; segment
 * (re)computation at saveSegment time goes through the inverted indexes
 * instead of per-profile evaluation.
 */
export function compileMatcher(rule: RuleNode): Matcher {
  const program: Instruction[] = [
    [OP_RETURN, true],
    [OP_RETURN, false],
  ];
  const start = emitNode(program, rule, 0, 1);
  return (profile: MatcherProfile): boolean => {
    let pc = start;
    for (;;) {
      const instruction = program[pc];
      switch (instruction[0]) {
        case OP_SCORE: {
          const score = profile.engagementScore;
          pc =
            score !== null &&
            score >= (instruction[1] as number) &&
            score <= (instruction[2] as number)
              ? (instruction[3] as number)
              : (instruction[4] as number);
          break;
        }
        case OP_REGION:
          pc =
            profile.region === instruction[1]
              ? (instruction[3] as number)
              : (instruction[4] as number);
          break;
        case OP_TAG:
          pc = profile.purchaseTags.includes(instruction[1] as string)
            ? (instruction[3] as number)
            : (instruction[4] as number);
          break;
        default:
          return instruction[1] as boolean;
      }
    }
  };
}

/**
 * Emits children in reverse so that each child's "continue" target is the
 * already-emitted start of the next sibling. Short-circuits: AND children
 * jump to the group's false target on failure, OR children jump to the
 * group's true target on success.
 */
function emitNode(
  program: Instruction[],
  node: RuleNode,
  trueTarget: number,
  falseTarget: number,
): number {
  switch (node.type) {
    case 'scoreRange':
      program.push([OP_SCORE, node.min, node.max, trueTarget, falseTarget]);
      return program.length - 1;
    case 'region':
      program.push([OP_REGION, node.value, 0, trueTarget, falseTarget]);
      return program.length - 1;
    case 'tag':
      program.push([OP_TAG, node.value, 0, trueTarget, falseTarget]);
      return program.length - 1;
    case 'and': {
      let next = trueTarget;
      for (let i = node.children.length - 1; i >= 0; i--) {
        next = emitNode(program, node.children[i], next, falseTarget);
      }
      return next;
    }
    case 'or': {
      let next = falseTarget;
      for (let i = node.children.length - 1; i >= 0; i--) {
        next = emitNode(program, node.children[i], trueTarget, next);
      }
      return next;
    }
  }
}
