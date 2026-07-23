import { describe, expect, it } from 'vitest';
import { checkGhCli } from './check-gh-cli.mjs';

describe('checkGhCli', () => {
  it('resolves silently when gh is installed and logged in', async () => {
    const exec = async () => ({ code: 0, stdout: 'Logged in to github.com', stderr: '' });
    await expect(checkGhCli({ exec })).resolves.toBeUndefined();
  });

  it('throws a clear error when gh is not installed', async () => {
    const exec = async () => {
      const err = new Error('command not found');
      err.code = 'ENOENT';
      throw err;
    };
    await expect(checkGhCli({ exec })).rejects.toThrow(/install/i);
  });

  it('throws a clear error prompting `gh auth login` when not logged in', async () => {
    const exec = async () => ({ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts' });
    await expect(checkGhCli({ exec })).rejects.toThrow(/gh auth login/);
  });
});
