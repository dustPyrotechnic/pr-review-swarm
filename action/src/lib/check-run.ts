import type { getOctokit } from '@actions/github';

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

export async function patchCheckConclusion(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: CheckConclusion;
    title?: string;
    summary?: string;
  },
): Promise<void> {
  await octokit.rest.checks.update({
    owner: params.owner,
    repo: params.repo,
    check_run_id: params.checkRunId,
    status: 'completed',
    conclusion: params.conclusion,
    ...(params.title || params.summary
      ? { output: { title: params.title ?? params.conclusion, summary: params.summary ?? '' } }
      : {}),
  });
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
