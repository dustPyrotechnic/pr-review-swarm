import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { withRetry, type RetryOptions } from './retry.js';

/** Anything with the Octokit hook registry we need to decorate. */
interface HookableOctokit {
  hook: {
    wrap(
      name: 'request',
      fn: (request: (options: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>,
    ): void;
  };
}

function headerOf(err: unknown, name: string): string | undefined {
  const headers = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response
    ?.headers;
  const value = headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Distinguishes "GitHub is having a moment" from "this request is wrong".
 *
 * The watchdog's 2026-08-17 red streak was exactly this class of failure —
 * codeload 429s, a request-timeout 502, and 403s — on unchanged code, token
 * scopes and action SHA. Retrying transport-level noise costs a few seconds;
 * retrying a real 404/422/missing-scope only buries the actual cause under
 * backoff, so those still fail fast.
 */
export function isTransientGithubError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;

  // No HTTP status at all: socket hangup, DNS, TLS, aborted request.
  if (status === undefined) return true;
  if (typeof status !== 'number') return false;

  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;

  // GitHub reports both primary and secondary rate limits as 403. Only the
  // ones carrying a rate-limit signal are retryable; a bare "Resource not
  // accessible by integration" is a scope problem and repeats deterministically.
  if (status === 403) {
    if (headerOf(err, 'retry-after') !== undefined) return true;
    if (headerOf(err, 'x-ratelimit-remaining') === '0') return true;
    const message = (err as { message?: unknown } | null)?.message;
    return typeof message === 'string' && /rate limit|abuse/i.test(message);
  }

  return false;
}

/**
 * Wraps every REST call this client makes — including the ones octokit.paginate
 * issues internally — in transient-failure retries.
 */
export function installTransientRetry(
  octokit: HookableOctokit,
  options?: Partial<RetryOptions>,
): void {
  const retryOptions: RetryOptions = {
    maxRetries: options?.maxRetries ?? 3,
    baseDelayMs: options?.baseDelayMs ?? 1_000,
    isRetryable: options?.isRetryable ?? isTransientGithubError,
    ...(options?.sleep ? { sleep: options.sleep } : {}),
  };

  octokit.hook.wrap('request', async (request, requestOptions) =>
    withRetry(() => request(requestOptions), retryOptions),
  );
}

export function getOctokitFromInput(): ReturnType<typeof getOctokit> {
  const token = core.getInput('github_token', { required: true });
  const octokit = getOctokit(token);
  installTransientRetry(octokit as unknown as HookableOctokit);
  return octokit;
}
