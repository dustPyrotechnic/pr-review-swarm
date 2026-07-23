import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultExec(cmd, args) {
  const { stdout, stderr } = await execFileAsync(cmd, args);
  return { stdout, stderr: stderr ?? '', code: 0 };
}

const BRANCH_NAME = 'pr-review-swarm/deploy';
const COMMIT_MESSAGE = 'chore: install PR Review Swarm';

export async function deployChanges({ paths, directPush, exec = defaultExec }) {
  if (!directPush) {
    await exec('git', ['checkout', '-b', BRANCH_NAME], {});
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
  const prResult = await exec(
    'gh',
    ['pr', 'create', '--title', COMMIT_MESSAGE, '--body', 'Installs the PR Review Swarm listener workflows.'],
    {},
  );

  return { mode: 'pr', prUrl: prResult.stdout.trim() };
}
