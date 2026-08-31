import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { fetchIdentityTupleWithState, type IdentityTuple } from '../lib/identity-tuple.js';
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
  const { identityTuple, pullRequestState } = await fetchIdentityTupleWithState(
    octokit,
    input.owner,
    input.repo,
    input.prNumber,
  );

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

  // 已合并 / 已关闭的 PR 上再发 Review 没有任何意义，只会留下一条永远不会被处理
  // 的 REQUEST_CHANGES 和一个红叉。2026-08-30 的 ios-source-learning#9：00:45:10
  // 合并，00:45:14 被 closed 事件触发，00:47:13 在已合并 PR 上提交了第 18 轮
  // CHANGES_REQUESTED。
  //
  // 防线放在 action 里而不是只放在部署模板里：模板落地后就是使用方自己的文件，
  // 我们改不动已经发出去的那些。
  //
  // 结论刻意用 neutral 而不是 rejectWithActionRequired 的 action_required ——
  // 「PR 已合并」不需要任何人做任何事，不该显示成红叉。
  if (pullRequestState.state === 'closed') {
    core.info(
      `status-start: skipping ${pullRequestState.merged ? 'merged' : 'closed'} PR #${input.prNumber}`,
    );
    await patchCheckConclusion(octokit, {
      owner: input.owner,
      repo: input.repo,
      checkRunId,
      conclusion: 'neutral',
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
