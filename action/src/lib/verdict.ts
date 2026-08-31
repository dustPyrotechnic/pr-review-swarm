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
//
// `incomplete` 是第三种情形：我们**知道自己没看全**。此时若只剩 low 级 finding，
// 结论等于「没看全，也没发现要紧的问题」—— 用 REQUEST_CHANGES 卡住一个 PR 说不通。
// 2026-08-29 的 ios-source-learning#9 第 17 轮正是这个组合：verdict=incomplete、
// 4 条全 low、其中 2 条还是自我否定的，却发了 REQUEST_CHANGES。
//
// 但 hard_limit_hit 引起的 incomplete **不降级**：那意味着我们主动截断了分析，
// 「截断之后不再阻塞」正是 docs/AGENTS.md 硬禁令 8 要防的东西。
//
// 这是对设计文档 L152「任何最终 finding 都触发 REQUEST_CHANGES」的一次显式修订，
// 用户于 2026-08-30 批准。severity 依然不影响 verdict 本身，只影响这一步的 event。
export function computeFinalReviewEvent(
  verdict: Verdict,
  finalFindings: Finding[],
  incompleteReasons: string[] = [],
): 'COMMENT' | 'REQUEST_CHANGES' | 'none' {
  if (verdict === 'pass') return 'COMMENT';
  if (verdict === 'changes_requested') return 'REQUEST_CHANGES';
  if (finalFindings.length === 0) return 'none';
  if (incompleteReasons.includes('hard_limit_hit')) return 'REQUEST_CHANGES';
  return finalFindings.every((finding) => finding.severity === 'low')
    ? 'COMMENT'
    : 'REQUEST_CHANGES';
}
