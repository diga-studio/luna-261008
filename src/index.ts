export type {
  AllocationFailure,
  AllocationRequest,
  AllocationResult,
  AllocationSuccess,
  AllowedCombination,
  AudienceGroup,
  BranchSpec,
  CombinationAllocation,
  Material,
} from './types.js';
export { splitBranchQuotas } from './quota.js';
export { solveAllocation } from './allocator.js';
