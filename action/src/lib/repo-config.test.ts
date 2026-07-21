import { describe, expect, it, vi } from 'vitest';
import { loadRepoConfig } from './repo-config.js';

function makeMockOctokit(getContentImpl: () => Promise<unknown>) {
  return {
    rest: {
      repos: {
        getContent: vi.fn(getContentImpl),
      },
    },
  };
}

function toContentResponse(yamlText: string) {
  return {
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(yamlText, 'utf-8').toString('base64'),
    },
  };
}

describe('loadRepoConfig', () => {
  it('returns disabled defaults when the config file does not exist (404)', async () => {
    const octokit = makeMockOctokit(() =>
      // fetchFileContent now catches 404s internally and returns undefined.
      // Simulate a non-existent file by returning undefined from getContent
      // (or by rejecting with 404, which fetchFileContent catches).
      Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })),
    );

    const config = await loadRepoConfig(octokit as never, 'octo', 'repo', 'basesha123');

    expect(config).toEqual({
      enabled: false,
      trusted_users: [],
      ignore_globs: [],
      generated_globs: [],
    });
  });

  it('parses and validates an existing config file', async () => {
    const octokit = makeMockOctokit(() =>
      Promise.resolve(
        toContentResponse(
          'enabled: true\ntrusted_users:\n  - alice\n  - bob\ndefault_mention: "@team"\n',
        ),
      ),
    );

    const config = await loadRepoConfig(octokit as never, 'octo', 'repo', 'basesha123');

    expect(config).toEqual({
      enabled: true,
      trusted_users: ['alice', 'bob'],
      default_mention: '@team',
      ignore_globs: [],
      generated_globs: [],
    });
  });

  it('requests the file content pinned at the given baseSha', async () => {
    const octokit = makeMockOctokit(() => Promise.resolve(toContentResponse('enabled: true\n')));

    await loadRepoConfig(octokit as never, 'octo', 'repo', 'basesha123');

    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'octo',
      repo: 'repo',
      path: '.github/pr-review-swarm.yml',
      ref: 'basesha123',
    });
  });

  it('throws when the config file fails schema validation', async () => {
    const octokit = makeMockOctokit(() =>
      Promise.resolve(toContentResponse('enabled: true\nnot_a_real_field: 123\n')),
    );

    await expect(loadRepoConfig(octokit as never, 'octo', 'repo', 'basesha123')).rejects.toThrow();
  });

  it('rethrows non-404 errors from the GitHub API', async () => {
    const octokit = makeMockOctokit(() => {
      const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
      return Promise.reject(err);
    });

    await expect(loadRepoConfig(octokit as never, 'octo', 'repo', 'basesha123')).rejects.toThrow(
      'Internal Server Error',
    );
  });
});
