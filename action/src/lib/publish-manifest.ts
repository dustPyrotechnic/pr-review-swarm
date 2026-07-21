import type { Finding } from './arbiter.js';
import { computeFindingsDigest } from './review-set-id.js';

export interface ReviewBatch {
  batchIndex: number;
  batchCount: number;
  findings: Finding[];
  findingsDigest: string;
  event: 'COMMENT';
}

export interface ReviewBatchLimits {
  maxFindingsPerReviewBatch: number;
  maxReviewBodyChars: number;
}

function estimateFindingChars(finding: Finding): number {
  return finding.title.length + finding.evidence.length + finding.impact.length + finding.suggestion.length + 64;
}

export function planReviewBatches(findings: Finding[], limits: ReviewBatchLimits): ReviewBatch[] {
  const groups: Finding[][] = [];
  let current: Finding[] = [];
  let currentChars = 0;

  for (const finding of findings) {
    const findingChars = estimateFindingChars(finding);
    const wouldExceedCount = current.length + 1 > limits.maxFindingsPerReviewBatch;
    const wouldExceedChars = current.length > 0 && currentChars + findingChars > limits.maxReviewBodyChars;

    if (current.length > 0 && (wouldExceedCount || wouldExceedChars)) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(finding);
    currentChars += findingChars;
  }

  if (current.length > 0 || groups.length === 0) {
    groups.push(current);
  }

  return groups.map((batchFindings, index) => ({
    batchIndex: index,
    batchCount: groups.length,
    findings: batchFindings,
    findingsDigest: computeFindingsDigest(batchFindings),
    event: 'COMMENT' as const,
  }));
}
