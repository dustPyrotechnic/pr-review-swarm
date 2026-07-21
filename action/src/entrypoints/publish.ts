import * as core from '@actions/core';
import { context } from '@actions/github';
import { getOctokitFromInput } from '../lib/github-client.js';
import {
  fetchIdentityTuple,
  identityTuplesEqual,
  toSchemaIdentityTuple,
  type IdentityTuple,
  type SchemaIdentityTuple,
} from '../lib/identity-tuple.js';
import { computeVerdict, type Verdict } from '../lib/verdict.js';
import type { Finding } from '../lib/arbiter.js';
import type { CoverageManifest } from './prepare.js';

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
  const lines = [
    '# PR Review Swarm (shadow mode)',
    '',
    `**Verdict:** ${verdictSummary.verdict}`,
  ];

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

  // PHASE 1: this is diagnostic-only output (job summary + artifact). No
  // GitHub Review/comment is ever published here — see Phase 2 task list.
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
    // PHASE 1: no GitHub write calls here, see Phase 2 task list. The verdict
    // above can already say "changes_requested" (that's a pure computation
    // over findings/coverage), but this action never actually posts a Review,
    // so the *real* GitHub-visible event always stays "none" in Phase 1.
    final_review_event: 'none',
  };

  return {
    verdictSummary,
    markdownSummary: buildMarkdownSummary(verdictSummary, input.findings),
  };
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
  // case buildPublishResult's own identity-tuple comparison (above) already
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

  const result = buildPublishResult({
    currentIdentityTuple,
    expectedIdentityTuple,
    findings,
    coverageManifest,
    anyRequiredStageFailed,
    reviewSetId: `${context.runId}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
  });

  await core.summary.addRaw(result.markdownSummary).write();
  core.setOutput('verdict', JSON.stringify(result.verdictSummary));
}
