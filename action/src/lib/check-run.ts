import type { getOctokit } from '@actions/github';
import { withRetry } from './retry.js';

type Octokit = ReturnType<typeof getOctokit>;

export const CHECK_NAME = 'PR Review Swarm / verdict';

export interface CheckRunExternalId {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  runId: string;
  runAttempt: string;
}

const REQUIRED_EXTERNAL_ID_FIELDS: Array<keyof CheckRunExternalId> = [
  'owner',
  'repo',
  'prNumber',
  'headSha',
  'baseSha',
  'mergeBaseSha',
  'runId',
  'runAttempt',
];

export function encodeExternalId(payload: CheckRunExternalId): string {
  return JSON.stringify(payload);
}

export function decodeExternalId(raw: string): CheckRunExternalId | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  const hasAllFields = REQUIRED_EXTERNAL_ID_FIELDS.every((field) => field in candidate);
  if (!hasAllFields) {
    return undefined;
  }

  return candidate as unknown as CheckRunExternalId;
}

export interface CheckRunSummary {
  id: number;
  status: string;
  externalId?: CheckRunExternalId;
  startedAtMs?: number;
}

export async function createInProgressCheck(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string; externalId: string },
): Promise<{ id: number }> {
  const { data } = await octokit.rest.checks.create({
    owner: params.owner,
    repo: params.repo,
    name: CHECK_NAME,
    head_sha: params.headSha,
    status: 'in_progress',
    external_id: params.externalId,
  });

  return { id: data.id };
}

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'action_required'
  | 'cancelled'
  | 'timed_out';

/**
 * Check Run 是权威门禁，写不进去就意味着 PR 上挂着一个永远 in_progress 的门禁。
 * status-start 的清理与 watchdog 的终结可能同时 PATCH 同一个 Check，GitHub 会用 409
 * 拒掉其中一个——那是纯粹的并发冲突，重试即可。
 *
 * 422 刻意不重试：它表示请求本身不可处理（例如 output 字段非法），重试不会变好，
 * 而静默吞掉会把真正的载荷错误藏起来。让它抛出去 —— job 变红是可观测的，
 * watchdog 仍会在超时阈值后兜底终结这个 Check。
 */
function isRetryableCheckUpdateError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === undefined) return true; // 网络错误，没有 HTTP 状态码
  if (status === 409) return true; // 并发冲突
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

export async function patchCheckConclusion(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: CheckConclusion;
    title?: string;
    summary?: string;
    maxRetries?: number;
    retrySleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  await withRetry(
    () =>
      octokit.rest.checks.update({
        owner: params.owner,
        repo: params.repo,
        check_run_id: params.checkRunId,
        status: 'completed',
        conclusion: params.conclusion,
        ...(params.title || params.summary
          ? { output: { title: params.title ?? params.conclusion, summary: params.summary ?? '' } }
          : {}),
      }),
    {
      maxRetries: params.maxRetries ?? 5,
      isRetryable: isRetryableCheckUpdateError,
      ...(params.retrySleep ? { sleep: params.retrySleep } : {}),
    },
  );
}

export async function listCheckRunsForRef(
  octokit: Octokit,
  params: { owner: string; repo: string; ref: string },
): Promise<CheckRunSummary[]> {
  const { data } = await octokit.rest.checks.listForRef({
    owner: params.owner,
    repo: params.repo,
    ref: params.ref,
    check_name: CHECK_NAME,
  });

  return data.check_runs.map((run) => ({
    id: run.id,
    status: run.status,
    externalId: run.external_id ? decodeExternalId(run.external_id) : undefined,
    startedAtMs: run.started_at ? new Date(run.started_at).getTime() : undefined,
  }));
}

export async function cancelSupersededChecks(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string; currentCheckRunId: number },
): Promise<void> {
  const checkRuns = await listCheckRunsForRef(octokit, {
    owner: params.owner,
    repo: params.repo,
    ref: params.headSha,
  });

  const superseded = checkRuns.filter(
    (run) => run.status === 'in_progress' && run.id !== params.currentCheckRunId,
  );

  for (const run of superseded) {
    await patchCheckConclusion(octokit, {
      owner: params.owner,
      repo: params.repo,
      checkRunId: run.id,
      conclusion: 'cancelled',
    });
  }
}
