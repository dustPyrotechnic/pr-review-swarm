import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultExec(cmd, args) {
  const { stdout, stderr } = await execFileAsync(cmd, args);
  return { stdout, stderr: stderr ?? '', code: 0 };
}

const BRANCH_NAME = 'pr-review-swarm/deploy';
const COMMIT_MESSAGE = 'chore: install PR Review Swarm';

/**
 * Deploying is a multi-step, non-atomic operation: files are written, then the
 * secret is set, then the branch is pushed. Any of those can fail partway, and
 * the operator's natural response is to re-run the command. On a re-run the
 * deploy branch already exists, so `checkout -b` fails — previously that
 * surfaced as a raw git error and the deploy could never converge.
 *
 * Switch to the existing branch instead, so a re-run always lands on the same
 * branch rather than creating a second one.
 */
async function checkoutDeployBranch(exec) {
  try {
    await exec('git', ['checkout', '-b', BRANCH_NAME], {});
  } catch {
    await exec('git', ['checkout', BRANCH_NAME], {});
  }
}

/** Reuse the PR already open for the deploy branch instead of opening a second one. */
async function findExistingPrUrl(exec) {
  try {
    const result = await exec(
      'gh',
      ['pr', 'list', '--head', BRANCH_NAME, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
      {},
    );
    const url = (result.stdout ?? '').trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

export async function deployChanges({ paths, directPush, exec = defaultExec }) {
  if (!directPush) {
    await checkoutDeployBranch(exec);
  }

  await exec('git', ['add', ...paths], {});
  await exec('git', ['commit', '-m', COMMIT_MESSAGE], {});

  if (directPush) {
    await exec('git', ['push'], {});
    return {
      mode: 'direct-push',
      warning: '⚠️ Changes were pushed directly to the current branch, without going through a PR review.',
    };
  }

  await exec('git', ['push', '-u', 'origin', BRANCH_NAME], {});

  try {
    const prResult = await exec(
      'gh',
      ['pr', 'create', '--title', COMMIT_MESSAGE, '--body', 'Installs the PR Review Swarm listener workflows.'],
      {},
    );
    return { mode: 'pr', prUrl: prResult.stdout.trim() };
  } catch (err) {
    // `gh pr create` refuses when a PR is already open for this branch — that's
    // the re-run path, not a failure. Reuse it rather than opening a second one.
    const existing = await findExistingPrUrl(exec);
    if (existing) return { mode: 'pr', prUrl: existing, reusedExistingPr: true };
    throw err;
  }
}
