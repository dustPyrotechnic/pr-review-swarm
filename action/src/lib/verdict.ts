import type { CoverageManifest } from '../entrypoints/prepare.js';
import type { Finding } from './arbiter.js';

export type Verdict = 'pass' | 'changes_requested' | 'incomplete';

export interface ComputeVerdictInput {
  coverageManifest: CoverageManifest;
  finalFindings: Finding[];
  anyRequiredStageFailed: boolean;
}

export interface ComputeVerdictResult {
  verdict: Verdict;
  incompleteReasons: string[];
}

export function computeVerdict(input: ComputeVerdictInput): ComputeVerdictResult {
  const incompleteReasons: string[] = [];

  if (input.coverageManifest.hard_limit_hit) incompleteReasons.push('hard_limit_hit');
  if (input.anyRequiredStageFailed) incompleteReasons.push('any_required_stage_failed');
  if (!input.coverageManifest.shards_complete) incompleteReasons.push('shards_incomplete');
  if (input.coverageManifest.pulls_files_pagination_truncated) {
    incompleteReasons.push('pulls_files_pagination_truncated');
  }
  if (input.coverageManifest.missing_patch_files.length > 0) {
    incompleteReasons.push('missing_patch_files');
  }

  if (incompleteReasons.length > 0) {
    return { verdict: 'incomplete', incompleteReasons };
  }

  if (input.finalFindings.length > 0) {
    return { verdict: 'changes_requested', incompleteReasons: [] };
  }

  return { verdict: 'pass', incompleteReasons: [] };
}

// The bot never gives final merge confirmation — a human always makes that
// call. So even a clean (`pass`) verdict only ever posts a COMMENT-state
// Review, never APPROVE; only REQUEST_CHANGES is a "real" review-state
// change, and only when there's something to flag.
export function computeFinalReviewEvent(
  verdict: Verdict,
  finalFindingsCount: number,
): 'COMMENT' | 'REQUEST_CHANGES' | 'none' {
  if (verdict === 'pass') return 'COMMENT';
  if (verdict === 'changes_requested') return 'REQUEST_CHANGES';
  return finalFindingsCount > 0 ? 'REQUEST_CHANGES' : 'none';
}
