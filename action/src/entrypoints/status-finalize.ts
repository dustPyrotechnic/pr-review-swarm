import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { patchCheckConclusion, type CheckConclusion } from '../lib/check-run.js';
import { getOctokitFromInput } from '../lib/github-client.js';
import type { VerdictSummary } from './publish.js';

type Octokit = ReturnType<typeof getOctokit>;

export type UpstreamFailureKind = 'timeout' | 'other';

export interface DetermineConclusionInput {
  verdictSummary?: VerdictSummary;
  upstreamFailureKind?: UpstreamFailureKind;
}

export function determineConclusion(input: DetermineConclusionInput): CheckConclusion {
  if (!input.verdictSummary) {
    return input.upstreamFailureKind === 'timeout' ? 'timed_out' : 'action_required';
  }

  switch (input.verdictSummary.verdict) {
    case 'pass':
      return 'success';
    case 'changes_requested':
      return 'failure';
    case 'incomplete':
      return 'action_required';
    case 'stale_cancelled':
      return 'cancelled';
  }
}

export interface FinalizeStatusInput extends DetermineConclusionInput {
  owner: string;
  repo: string;
  checkRunId: number;
}

export async function finalizeStatus(octokit: Octokit, input: FinalizeStatusInput): Promise<void> {
  const conclusion = determineConclusion(input);
  await patchCheckConclusion(octokit, {
    owner: input.owner,
    repo: input.repo,
    checkRunId: input.checkRunId,
    conclusion,
  });
}

export async function run(): Promise<void> {
  const octokit = getOctokitFromInput();
  const owner = core.getInput('owner', { required: true });
  const repo = core.getInput('repo', { required: true });
  const checkRunId = Number(core.getInput('check_run_id', { required: true }));

  const verdictRaw = core.getInput('verdict');
  const upstreamFailureKindRaw = core.getInput('upstream_failure_kind');

  await finalizeStatus(octokit, {
    owner,
    repo,
    checkRunId,
    verdictSummary: verdictRaw ? (JSON.parse(verdictRaw) as VerdictSummary) : undefined,
    upstreamFailureKind:
      upstreamFailureKindRaw === 'timeout' || upstreamFailureKindRaw === 'other'
        ? upstreamFailureKindRaw
        : undefined,
  });
}
