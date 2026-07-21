import { describe, expect, it, vi } from 'vitest';
import { fetchFileContent } from './github-content.js';

function toContentResponse(text: string) {
  return {
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(text, 'utf-8').toString('base64'),
    },
  };
}

describe('fetchFileContent', () => {
  it('decodes base64 file content to a utf-8 string', async () => {
    const octokit = { rest: { repos: { getContent: vi.fn().mockResolvedValue(toContentResponse('hello world')) } } };

    const result = await fetchFileContent(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      path: 'src/foo.ts',
      ref: 'sha123',
    });

    expect(result).toBe('hello world');
  });

  it('calls getContent with the given owner/repo/path/ref', async () => {
    const octokit = { rest: { repos: { getContent: vi.fn().mockResolvedValue(toContentResponse('x')) } } };

    await fetchFileContent(octokit as never, { owner: 'octo', repo: 'repo', path: 'a.ts', ref: 'sha123' });

    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      path: 'a.ts',
      ref: 'sha123',
    });
  });

  it('returns undefined when the path is a directory (array response)', async () => {
    const octokit = { rest: { repos: { getContent: vi.fn().mockResolvedValue({ data: [] }) } } };

    const result = await fetchFileContent(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      path: 'src',
      ref: 'sha123',
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the response is not type "file"', async () => {
    const octokit = {
      rest: { repos: { getContent: vi.fn().mockResolvedValue({ data: { type: 'symlink', content: 'x' } }) } },
    };

    const result = await fetchFileContent(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      path: 'link',
      ref: 'sha123',
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the file does not exist (404)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const octokit = { rest: { repos: { getContent: vi.fn().mockRejectedValue(notFound) } } };

    const result = await fetchFileContent(octokit as never, {
      owner: 'octo',
      repo: 'repo',
      path: 'missing.ts',
      ref: 'sha123',
    });

    expect(result).toBeUndefined();
  });

  it('propagates non-404 errors from the underlying API call', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const octokit = { rest: { repos: { getContent: vi.fn().mockRejectedValue(serverError) } } };

    await expect(
      fetchFileContent(octokit as never, { owner: 'octo', repo: 'repo', path: 'bad.ts', ref: 'sha123' }),
    ).rejects.toThrow('Internal Server Error');
  });
});
