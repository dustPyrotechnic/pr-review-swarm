import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchIdentityTuple, type IdentityTuple } from '../lib/identity-tuple.js';
import { loadRepoConfig } from '../lib/repo-config.js';
import { evaluateTrustGate } from '../lib/trust-gate.js';
import { getOctokitFromInput } from '../lib/github-client.js';
import {
  createInProgressCheck,
  cancelSupersededChecks,
  encodeExternalId,
  patchCheckConclusion,
} from '../lib/check-run.js';

type Octokit = ReturnType<typeof getOctokit>;

const PERMISSION_RANK = ['none', 'read', 'triage', 'write', 'maintain', 'admin'];
const MIN_WORKFLOW_DISPATCH_PERMISSION_RANK = PERMISSION_RANK.indexOf('write');

export interface StatusStartInput {
  owner: string;
  repo: string;
  prNumber: number;
  eventName: string;
  authorAssociation: string;
  senderLogin: string;
  runId: string;
  runAttempt: string;
}

export interface StatusStartResult {
  gatePassed: boolean;
  identityTuple: IdentityTuple;
  checkRunId: number;
}

export async function evaluateAndStartStatus(
  octokit: Octokit,
  input: StatusStartInput,
): Promise<StatusStartResult> {
  const identityTuple = await fetchIdentityTuple(octokit, input.owner, input.repo, input.prNumber);

  const externalId = encodeExternalId({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: identityTuple.headSha,
    baseSha: identityTuple.baseSha,
    mergeBaseSha: identityTuple.mergeBaseSha,
    runId: input.runId,
    runAttempt: input.runAttempt,
  });

  const { id: checkRunId } = await createInProgressCheck(octokit, {
    owner: input.owner,
    repo: input.repo,
    headSha: identityTuple.headSha,
    externalId,
  });

  await cancelSupersededChecks(octokit, {
    owner: input.owner,
    repo: input.repo,
    headSha: identityTuple.headSha,
    currentCheckRunId: checkRunId,
  });

  async function rejectWithActionRequired(): Promise<StatusStartResult> {
    await patchCheckConclusion(octokit, {
      owner: input.owner,
      repo: input.repo,
      checkRunId,
      conclusion: 'action_required',
    });
    return { gatePassed: false, identityTuple, checkRunId };
  }

  const repoConfig = await loadRepoConfig(
    octokit,
    input.owner,
    input.repo,
    identityTuple.baseSha,
  );

  if (repoConfig.enabled !== true) {
    return rejectWithActionRequired();
  }

  const trustDecision = evaluateTrustGate({
    eventName: input.eventName,
    authorAssociation: input.authorAssociation,
    senderLogin: input.senderLogin,
    repoConfig,
  });

  if (!trustDecision.allowed) {
    return rejectWithActionRequired();
  }

  if (input.eventName === 'workflow_dispatch') {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: input.owner,
      repo: input.repo,
      username: input.senderLogin,
    });
    const rank = PERMISSION_RANK.indexOf(data.permission);
    if (rank < MIN_WORKFLOW_DISPATCH_PERMISSION_RANK) {
      return rejectWithActionRequired();
    }
  }

  return { gatePassed: true, identityTuple, checkRunId };
}

export async function run(): Promise<void> {
  if (!context.payload.pull_request && context.eventName !== 'workflow_dispatch') {
    throw new Error(
      'status-start: missing required GitHub Actions context (no pull_request in event payload)',
    );
  }

  const octokit = getOctokitFromInput();

  const prNumber =
    context.eventName === 'workflow_dispatch'
      ? Number(core.getInput('pr_number', { required: true }))
      : context.payload.pull_request!.number;

  const result = await evaluateAndStartStatus(octokit, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber,
    eventName: context.eventName,
    authorAssociation: (context.payload.pull_request?.author_association as string) ?? 'NONE',
    senderLogin: context.payload.sender?.login ?? '',
    runId: String(context.runId),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
  });

  core.setOutput('gate_passed', String(result.gatePassed));
  core.setOutput('check_run_id', String(result.checkRunId));
  core.setOutput('identity_tuple', JSON.stringify(result.identityTuple));
}
