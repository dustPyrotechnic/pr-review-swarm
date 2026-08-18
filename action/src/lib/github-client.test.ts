import { describe, expect, it, vi } from 'vitest';
import { installTransientRetry, isTransientGithubError } from './github-client.js';

function httpError(status: number, message = 'boom', headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

/**
 * Minimal stand-in for the parts of an Octokit instance installTransientRetry
 * touches: a hook registry whose `wrap('request', ...)` decorates every REST
 * call (including the ones octokit.paginate makes under the hood).
 */
function makeFakeOctokit() {
  let wrapped: ((request: (o: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>) | undefined;
  return {
    hook: {
      wrap(name: string, fn: typeof wrapped) {
        if (name !== 'request') throw new Error(`unexpected hook: ${name}`);
        wrapped = fn;
      },
    },
    async request(inner: (o: unknown) => Promise<unknown>, options: unknown = {}) {
      if (!wrapped) throw new Error('hook not installed');
      return wrapped(inner, options);
    },
  };
}

describe('isTransientGithubError', () => {
  it('treats a status-less failure as transient (socket hangup, DNS, TLS)', () => {
    expect(isTransientGithubError(new Error('socket hang up'))).toBe(true);
  });

  it('treats 429 and 5xx as transient', () => {
    expect(isTransientGithubError(httpError(429))).toBe(true);
    expect(isTransientGithubError(httpError(502))).toBe(true);
    expect(isTransientGithubError(httpError(503))).toBe(true);
  });

  it('treats a 403 carrying rate-limit signals as transient', () => {
    expect(isTransientGithubError(httpError(403, 'forbidden', { 'retry-after': '30' }))).toBe(true);
    expect(
      isTransientGithubError(httpError(403, 'forbidden', { 'x-ratelimit-remaining': '0' })),
    ).toBe(true);
    expect(isTransientGithubError(httpError(403, 'You have exceeded a secondary rate limit'))).toBe(
      true,
    );
  });

  // A genuinely missing scope repeats deterministically; retrying it only
  // delays the failure and hides the real cause behind backoff noise.
  it('does not treat a plain permission 403 as transient', () => {
    expect(isTransientGithubError(httpError(403, 'Resource not accessible by integration'))).toBe(
      false,
    );
  });

  it('does not treat 404/422 as transient', () => {
    expect(isTransientGithubError(httpError(404))).toBe(false);
    expect(isTransientGithubError(httpError(422))).toBe(false);
  });
});

describe('installTransientRetry', () => {
  it('retries a transient request and returns the eventual success', async () => {
    const octokit = makeFakeOctokit();
    installTransientRetry(octokit, { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} });

    const inner = vi
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue({ data: 'ok' });

    await expect(octokit.request(inner)).resolves.toEqual({ data: 'ok' });
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const octokit = makeFakeOctokit();
    installTransientRetry(octokit, { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} });

    const inner = vi.fn().mockRejectedValue(httpError(503, 'still down'));

    await expect(octokit.request(inner)).rejects.toThrow('still down');
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient error', async () => {
    const octokit = makeFakeOctokit();
    installTransientRetry(octokit, { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} });

    const inner = vi.fn().mockRejectedValue(httpError(422, 'validation failed'));

    await expect(octokit.request(inner)).rejects.toThrow('validation failed');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('passes the original request options through untouched', async () => {
    const octokit = makeFakeOctokit();
    installTransientRetry(octokit, { maxRetries: 1, baseDelayMs: 1, sleep: async () => {} });

    const inner = vi.fn().mockResolvedValue({ data: [] });
    await octokit.request(inner, { url: '/repos/{owner}/{repo}/pulls', owner: 'octo' });

    expect(inner).toHaveBeenCalledWith({ url: '/repos/{owner}/{repo}/pulls', owner: 'octo' });
  });
});
