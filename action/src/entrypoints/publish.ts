import { createHash } from 'node:crypto';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import { getOctokitFromInput } from '../lib/github-client.js';
import {
  fetchIdentityTuple,
  identityTuplesEqual,
  toSchemaIdentityTuple,
  type IdentityTuple,
  type SchemaIdentityTuple,
} from '../lib/identity-tuple.js';
import { computeVerdict, type Verdict } from '../lib/verdict.js';
import { computeReviewSetId } from '../lib/review-set-id.js';
import { planReviewBatches, type ReviewBatch, type ReviewBatchLimits } from '../lib/publish-manifest.js';
import { decodeBatchMarker, encodeBatchMarker } from '../lib/hidden-marker.js';
import {
  buildSummaryCommentBody,
  upsertSummaryComment,
  type SummaryCommentContext,
} from '../lib/summary-comment.js';
import type { Finding } from '../lib/arbiter.js';
import type { CoverageManifest } from './prepare.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface VerdictSummary {
  identity_tuple: SchemaIdentityTuple;
  verdict: Verdict | 'stale_cancelled';
  incomplete_reasons?: string[];
  review_set_id: string;
  final_findings_count: number;
  final_review_event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | 'none';
}

export interface PublishCoreInput {
  currentIdentityTuple: IdentityTuple;
  expectedIdentityTuple: IdentityTuple;
  findings: Finding[];
  coverageManifest: CoverageManifest;
  anyRequiredStageFailed: boolean;
  reviewSetId: string;
}

export interface PublishCoreResult {
  verdictSummary: VerdictSummary;
  markdownSummary: string;
}

function buildMarkdownSummary(verdictSummary: VerdictSummary, findings: Finding[]): string {
  const lines = ['# PR Review Swarm', '', `**Verdict:** ${verdictSummary.verdict}`];

  if (verdictSummary.incomplete_reasons?.length) {
    lines.push(`**Incomplete reasons:** ${verdictSummary.incomplete_reasons.join(', ')}`);
  }

  lines.push('', `**Findings (${findings.length}):**`);
  if (findings.length === 0) {
    lines.push('- (none)');
  } else {
    for (const finding of findings) {
      lines.push(`- \`${finding.path}:${finding.line}\` [${finding.severity}] ${finding.title}`);
    }
  }

  return lines.join('\n');
}

export function buildPublishResult(input: PublishCoreInput): PublishCoreResult {
  if (!identityTuplesEqual(input.currentIdentityTuple, input.expectedIdentityTuple)) {
    const verdictSummary: VerdictSummary = {
      identity_tuple: toSchemaIdentityTuple(input.expectedIdentityTuple),
      verdict: 'stale_cancelled',
      review_set_id: input.reviewSetId,
      final_findings_count: 0,
      final_review_event: 'none',
    };
    return { verdictSummary, markdownSummary: buildMarkdownSummary(verdictSummary, []) };
  }

  const { verdict, incompleteReasons } = computeVerdict({
    coverageManifest: input.coverageManifest,
    finalFindings: input.findings,
    anyRequiredStageFailed: input.anyRequiredStageFailed,
  });

  const verdictSummary: VerdictSummary = {
    identity_tuple: toSchemaIdentityTuple(input.currentIdentityTuple),
    verdict,
    ...(incompleteReasons.length > 0 ? { incomplete_reasons: incompleteReasons } : {}),
    review_set_id: input.reviewSetId,
    final_findings_count: input.findings.length,
    // PHASE 2: every non-stale run publishes at least one Review batch, and
    // that batch's event is always COMMENT (see reusable-pr-review.yml —
    // this Job never holds the intent to change PR review state; that only
    // arrives in Phase 3, which replaces this fixed value with a real branch
    // driven by `verdict`).
    final_review_event: 'COMMENT',
  };

  return {
    verdictSummary,
    markdownSummary: buildMarkdownSummary(verdictSummary, input.findings),
  };
}

function buildBatchReviewBody(batch: ReviewBatch, reviewSetId: string): string {
  const lines = [`## PR Review Swarm — batch ${batch.batchIndex + 1}/${batch.batchCount}`, ''];

  if (batch.findings.length === 0) {
    lines.push('No findings in this run.');
  } else {
    lines.push(`${batch.findings.length} finding(s) in this batch (see inline comments below).`);
  }

  lines.push('', encodeBatchMarker({
    reviewSetId,
    batchIndex: batch.batchIndex,
    batchCount: batch.batchCount,
    digest: batch.findingsDigest,
  }));

  return lines.join('\n');
}

function buildInlineComments(batch: ReviewBatch): Array<{
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}> {
  // Phase 2 simplification: every finding that reaches publish has already
  // passed deterministic-evidence-validator + verifier confirmation against
  // the locked head_sha, so we trust its path/line/side directly. Downgrading
  // unlocatable findings to the Review body (D-L215) is deferred — see the
  // Phase 2 plan doc's progress table.
  return batch.findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: finding.side,
    ...(finding.start_line !== undefined ? { start_line: finding.start_line } : {}),
    ...(finding.start_side !== undefined ? { start_side: finding.start_side } : {}),
    body: `**[${finding.severity}] ${finding.title}**\n\n${finding.evidence}\n\n${finding.suggestion}`,
  }));
}

async function supersedeOldReviewSets(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    currentReviewSetId: string;
    reviews: Array<{ id: number; body: string | null }>;
  },
): Promise<void> {
  const staleReviews = params.reviews.filter((review) => {
    const marker = decodeBatchMarker(review.body);
    return marker !== undefined && marker.reviewSetId !== params.currentReviewSetId;
  });

  if (staleReviews.length === 0) return;

  const { data: allComments } = await octokit.rest.pulls.listReviewComments({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
  });

  for (const review of staleReviews) {
    const notice = `⚠️ 已被新一轮审核（review_set_id=${params.currentReviewSetId}）取代，请以下方最新 Review 为准。\n\n`;
    await octokit.rest.pulls.updateReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      review_id: review.id,
      body: notice + (review.body ?? ''),
    });

    const commentsForReview = allComments.filter((c) => c.pull_request_review_id === review.id);
    for (const comment of commentsForReview) {
      await octokit.rest.pulls.updateReviewComment({
        owner: params.owner,
        repo: params.repo,
        comment_id: comment.id,
        body: `⚠️ 已被新一轮审核（review_set_id=${params.currentReviewSetId}）取代。\n\n${comment.body ?? ''}`,
      });
    }
  }
}

export interface ExecutePublishInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  currentIdentityTuple: IdentityTuple;
  expectedIdentityTuple: IdentityTuple;
  findings: Finding[];
  coverageManifest: CoverageManifest;
  anyRequiredStageFailed: boolean;
  engineRevision: string;
  policyRevision: string;
  model: string;
  schemaVersion: string;
  reviewBatchLimits: ReviewBatchLimits;
}

export async function executePublish(input: ExecutePublishInput): Promise<PublishCoreResult> {
  if (!identityTuplesEqual(input.currentIdentityTuple, input.expectedIdentityTuple)) {
    return buildPublishResult({
      currentIdentityTuple: input.currentIdentityTuple,
      expectedIdentityTuple: input.expectedIdentityTuple,
      findings: input.findings,
      coverageManifest: input.coverageManifest,
      anyRequiredStageFailed: input.anyRequiredStageFailed,
      reviewSetId: '',
    });
  }

  const reviewSetId = computeReviewSetId({
    identityTuple: toSchemaIdentityTuple(input.currentIdentityTuple),
    engineRevision: input.engineRevision,
    policyRevision: input.policyRevision,
    model: input.model,
    schemaVersion: input.schemaVersion,
    findings: input.findings,
  });

  const result = buildPublishResult({
    currentIdentityTuple: input.currentIdentityTuple,
    expectedIdentityTuple: input.expectedIdentityTuple,
    findings: input.findings,
    coverageManifest: input.coverageManifest,
    anyRequiredStageFailed: input.anyRequiredStageFailed,
    reviewSetId,
  });

  const { data: existingReviews } = await input.octokit.rest.pulls.listReviews({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });

  await supersedeOldReviewSets(input.octokit, {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    currentReviewSetId: reviewSetId,
    reviews: existingReviews,
  });

  const batches = planReviewBatches(input.findings, input.reviewBatchLimits);
  const alreadyPublished = existingReviews
    .map((review) => decodeBatchMarker(review.body))
    .filter((marker): marker is NonNullable<typeof marker> => marker !== undefined)
    .filter((marker) => marker.reviewSetId === reviewSetId);

  for (const batch of batches) {
    const existing = alreadyPublished.find((marker) => marker.batchIndex === batch.batchIndex);
    if (existing) {
      if (existing.digest === batch.findingsDigest) {
        continue; // already published in this run_set — skip, don't republish
      }
      // Should not happen: review_set_id already binds findings content, so a
      // batch found under the *same* review_set_id must have the same digest.
      // Treat any mismatch conservatively as incomplete and stop publishing
      // further batches rather than silently overwriting.
      result.verdictSummary.verdict = 'incomplete';
      result.verdictSummary.incomplete_reasons = [
        ...(result.verdictSummary.incomplete_reasons ?? []),
        'digest_mismatch',
      ];
      break;
    }

    await input.octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      commit_id: input.currentIdentityTuple.headSha,
      event: 'COMMENT',
      body: buildBatchReviewBody(batch, reviewSetId),
      comments: buildInlineComments(batch),
    });
  }

  const summaryCtx: SummaryCommentContext = {
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: input.currentIdentityTuple.headSha,
    baseSha: input.currentIdentityTuple.baseSha,
    engineRevision: input.engineRevision,
    policyRevision: input.policyRevision,
    model: input.model,
    schemaVersion: input.schemaVersion,
    verdict: result.verdictSummary.verdict,
    reviewSetId,
  };
  await upsertSummaryComment(
    input.octokit,
    summaryCtx,
    buildSummaryCommentBody(summaryCtx, result.verdictSummary, input.findings),
  );

  return result;
}

// The engine revision identifies which pinned build of this action actually
// produced a given verdict. We deliberately do NOT embed a git SHA at build
// time (e.g. via an esbuild `define`): dist/index.js is committed alongside
// its source, and the CI `build-dist-no-drift` job rebuilds dist from a
// checkout of that same commit and diffs it — but `git rev-parse HEAD` at
// local build time (before the commit exists) can never equal `git rev-parse
// HEAD` during CI's rebuild (after the commit exists), so any build-time SHA
// embed would drift on every single commit that touches action/src.
// GITHUB_ACTION_REF is populated by GitHub Actions itself, at zero build-time
// cost, with the exact ref the consuming repo's `uses: org/repo/action@<ref>`
// resolved to — which is precisely "the pinned engine version currently
// executing", with no drift risk at all.
export function resolveEngineRevision(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_ACTION_REF || env.PR_REVIEW_SWARM_ENGINE_REVISION || 'unknown-engine-revision';
}

export async function run(): Promise<void> {
  const octokit = getOctokitFromInput();
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const prNumberInput = core.getInput('pr_number');
  const pr = context.payload.pull_request;
  const prNumber = pr ? pr.number : Number(prNumberInput);

  const expectedIdentityTupleRaw = core.getInput('identity_tuple', { required: true });
  const expectedIdentityTuple = JSON.parse(expectedIdentityTupleRaw) as IdentityTuple;

  let currentIdentityTuple: IdentityTuple;
  try {
    currentIdentityTuple = await fetchIdentityTuple(octokit, owner, repo, prNumber);
  } catch (err) {
    // If we can't re-read the PR (network error, permission gap, etc.),
    // treat it as stale — the identity-tuple comparison would fail anyway.
    core.warning(`publish: failed to re-fetch identity tuple: ${(err as Error).message}`);
    const staleSummary: VerdictSummary = {
      identity_tuple: toSchemaIdentityTuple(expectedIdentityTuple),
      verdict: 'stale_cancelled',
      review_set_id: `${context.runId}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      final_findings_count: 0,
      final_review_event: 'none',
    };
    await core.summary.addRaw(buildMarkdownSummary(staleSummary, [])).write();
    core.setOutput('verdict', JSON.stringify(staleSummary));
    return;
  }

  const findingsRaw = core.getInput('findings');
  const findings = (findingsRaw ? JSON.parse(findingsRaw) : []) as Finding[];

  // coverage_manifest is intentionally NOT required here: when prepare detects
  // a stale identity tuple, analyze never runs and never produces one. In that
  // case executePublish's own identity-tuple comparison (above) already
  // short-circuits to stale_cancelled before this value is ever inspected. If
  // it's missing for any *other* reason, this conservative "nothing verified"
  // shape makes computeVerdict fall through to incomplete rather than pass.
  const coverageManifestRaw = core.getInput('coverage_manifest');
  const coverageManifest = coverageManifestRaw
    ? (JSON.parse(coverageManifestRaw) as CoverageManifest)
    : {
        files: [],
        shards_complete: false,
        hard_limit_hit: true,
        pulls_files_pagination_truncated: false,
        missing_patch_files: [],
        token_usage: { prompt_tokens: 0, completion_tokens: 0 },
      };
  const anyRequiredStageFailed = core.getInput('any_required_stage_failed') === 'true';
  const model = core.getInput('model') || 'unknown-model';

  const result = await executePublish({
    octokit,
    owner,
    repo,
    prNumber,
    currentIdentityTuple,
    expectedIdentityTuple,
    findings,
    coverageManifest,
    anyRequiredStageFailed,
    engineRevision: resolveEngineRevision(process.env),
    policyRevision: createHash('sha256').update(JSON.stringify(centralLimits)).digest('hex').slice(0, 12),
    model,
    schemaVersion: 'finding-v1',
    reviewBatchLimits: {
      maxFindingsPerReviewBatch: centralLimits.maxFindingsPerReviewBatch,
      maxReviewBodyChars: centralLimits.maxReviewBodyChars,
    },
  });

  await core.summary.addRaw(result.markdownSummary).write();
  core.setOutput('verdict', JSON.stringify(result.verdictSummary));
}
