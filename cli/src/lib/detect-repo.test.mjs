import { describe, expect, it } from 'vitest';
import { parseOwnerRepo, detectRepo } from './detect-repo.mjs';

describe('parseOwnerRepo', () => {
  it('parses an https remote URL', () => {
    expect(parseOwnerRepo('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' });
  });

  it('parses an https remote URL without the .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/octo/repo')).toEqual({ owner: 'octo', repo: 'repo' });
  });

  it('parses an ssh remote URL', () => {
    expect(parseOwnerRepo('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', repo: 'repo' });
  });

  it('returns undefined for a non-GitHub remote', () => {
    expect(parseOwnerRepo('https://gitlab.com/octo/repo.git')).toBeUndefined();
  });
});

describe('detectRepo', () => {
  it('returns owner/repo when git remote resolves to a GitHub URL', async () => {
    const exec = async () => ({ stdout: 'https://github.com/octo/repo.git\n', code: 0 });
    const result = await detectRepo({ exec });
    expect(result).toEqual({ owner: 'octo', repo: 'repo' });
  });

  it('throws a clear error when not inside a git repository', async () => {
    const exec = async () => ({ stdout: '', code: 128, stderr: 'not a git repository' });
    await expect(detectRepo({ exec })).rejects.toThrow(/not a git repository|git repo/i);
  });

  it('throws a clear error when the remote is not a GitHub URL', async () => {
    const exec = async () => ({ stdout: 'https://gitlab.com/octo/repo.git\n', code: 0 });
    await expect(detectRepo({ exec })).rejects.toThrow(/github/i);
  });
});
