import { describe, expect, it, vi } from 'vitest';
import { deployChanges } from './deploy-changes.mjs';

function makeExec(prUrl = 'https://github.com/octo/repo/pull/1') {
  return vi.fn(async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { code: 0, stdout: `${prUrl}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

const paths = ['.github/workflows/pr-review.yml', '.github/workflows/pr-review-watchdog.yml'];

describe('deployChanges (PR mode, default)', () => {
  it('creates a branch, commits the new files, and opens a PR', async () => {
    const exec = makeExec();
    const result = await deployChanges({ paths, directPush: false, exec });

    expect(exec).toHaveBeenCalledWith('git', ['checkout', '-b', 'pr-review-swarm/deploy'], expect.anything());
    expect(exec).toHaveBeenCalledWith('git', ['add', ...paths], expect.anything());
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['commit']), expect.anything());
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['push']), expect.anything());
    expect(exec).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'create']), expect.anything());
    expect(result.mode).toBe('pr');
    expect(result.prUrl).toBe('https://github.com/octo/repo/pull/1');
  });
});

describe('deployChanges (--direct-push)', () => {
  it('commits and pushes directly to the current branch, without opening a PR', async () => {
    const exec = makeExec();
    const result = await deployChanges({ paths, directPush: true, exec });

    expect(exec).not.toHaveBeenCalledWith('git', expect.arrayContaining(['checkout', '-b']), expect.anything());
    expect(exec).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'create']), expect.anything());
    expect(exec).toHaveBeenCalledWith('git', ['add', ...paths], expect.anything());
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['commit']), expect.anything());
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['push']), expect.anything());
    expect(result.mode).toBe('direct-push');
    expect(result.warning).toMatch(/直接推送|not.*review|without.*review/i);
  });
});
