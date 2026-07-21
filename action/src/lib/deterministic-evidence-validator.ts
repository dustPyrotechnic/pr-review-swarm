import type { DiffHunk } from './diff-parser.js';
import type { CandidateFinding } from './expert-runner.js';

export type DeterministicValidationStatus = 'passed' | 'failed' | 'deferred_to_verifier';

export interface DeterministicValidationResult {
  status: DeterministicValidationStatus;
  reason?: string;
}

function hunkHasChange(hunk: DiffHunk): boolean {
  return hunk.lines.some((line) => line.type === 'add' || line.type === 'del');
}

// A directly-added/removed line (rule 1) is always within its own hunk's
// declared line range (rule 2) by construction — diff-parser.ts numbers every
// add/context line starting at newStart for exactly newLines lines (and
// likewise for del/context lines from oldStart for oldLines), so rule 1's
// matches are always a strict subset of rule 2's. One range check covers both.
function isWithinChangedHunkRange(hunk: DiffHunk, side: 'LEFT' | 'RIGHT', line: number): boolean {
  if (!hunkHasChange(hunk)) return false;
  if (side === 'RIGHT') {
    return line >= hunk.newStart && line <= hunk.newStart + hunk.newLines - 1;
  }
  return line >= hunk.oldStart && line <= hunk.oldStart + hunk.oldLines - 1;
}

export function validateDeterministicEvidence(
  finding: CandidateFinding,
  filePath: string,
  fileHunks: DiffHunk[],
): DeterministicValidationResult {
  if (finding.cross_file_causal_claim === true) {
    return { status: 'deferred_to_verifier' };
  }

  if (finding.path !== filePath) {
    return {
      status: 'failed',
      reason: `path mismatch: finding references "${finding.path}" but hunks belong to "${filePath}"`,
    };
  }

  if (finding.side !== 'LEFT' && finding.side !== 'RIGHT') {
    return { status: 'failed', reason: `invalid side: "${finding.side}"` };
  }

  for (const hunk of fileHunks) {
    if (isWithinChangedHunkRange(hunk, finding.side, finding.line)) {
      return { status: 'passed' };
    }
  }

  return {
    status: 'failed',
    reason:
      `line ${finding.line} (side ${finding.side}) in "${filePath}" is not part of any hunk that ` +
      'this PR actually modified',
  };
}
