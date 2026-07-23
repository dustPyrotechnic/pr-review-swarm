import type { getOctokit } from '@actions/github';
import type { Finding } from './arbiter.js';
import type { VerdictSummary } from '../entrypoints/publish.js';
import { buildIncompleteBanner } from './incomplete-banner.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface SummaryCommentContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  engineRevision: string;
  policyRevision: string;
  model: string;
  schemaVersion: string;
  verdict: string;
  reviewSetId: string;
  defaultMention?: string;
}

const MAX_COMMENT_CHARS = 65536;

export function findStableMarkerId(ctx: SummaryCommentContext): string {
  return `<!-- pr-review-swarm:marker=summary;repo=${ctx.owner}/${ctx.repo};pr=${ctx.prNumber} -->`;
}

function encodeResultMarker(ctx: SummaryCommentContext): string {
  return (
    `<!-- pr-review-swarm:result;head_sha=${ctx.headSha};base_sha=${ctx.baseSha};` +
    `engine_revision=${ctx.engineRevision};policy_revision=${ctx.policyRevision};` +
    `model=${ctx.model};schema_version=${ctx.schemaVersion};verdict=${ctx.verdict};` +
    `review_set_id=${ctx.reviewSetId} -->`
  );
}

export function buildSummaryCommentBody(
  ctx: SummaryCommentContext,
  verdictSummary: VerdictSummary,
  findings: Finding[],
): string {
  const lines = ['# PR Review Swarm', ''];

  if (verdictSummary.verdict === 'incomplete' && verdictSummary.incomplete_reasons?.length) {
    lines.push(buildIncompleteBanner(verdictSummary.incomplete_reasons), '');
  }

  lines.push(`**Verdict:** ${verdictSummary.verdict}`);

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

  if (verdictSummary.verdict === 'pass' && ctx.defaultMention) {
    lines.push('', `cc @${ctx.defaultMention}`);
  }

  lines.push('', findStableMarkerId(ctx), encodeResultMarker(ctx));

  const body = lines.join('\n');
  if (body.length <= MAX_COMMENT_CHARS) {
    return body;
  }

  const truncated = [
    '# PR Review Swarm',
    '',
    `**Verdict:** ${verdictSummary.verdict}`,
    '',
    `**Findings (${findings.length}):** list truncated, see Review batches for the full list.`,
    '',
    findStableMarkerId(ctx),
    encodeResultMarker(ctx),
  ].join('\n');
  return truncated;
}

export async function upsertSummaryComment(
  octokit: Octokit,
  ctx: SummaryCommentContext,
  body: string,
): Promise<{ commentId: number; action: 'created' | 'updated' }> {
  const marker = findStableMarkerId(ctx);
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
  });

  const existing = comments.find((c) => c.body?.includes(marker));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: existing.id,
      body,
    });
    return { commentId: existing.id, action: 'updated' };
  }

  const { data } = await octokit.rest.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body,
  });
  return { commentId: data.id, action: 'created' };
}
