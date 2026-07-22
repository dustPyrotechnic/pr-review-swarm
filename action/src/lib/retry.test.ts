import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

function fakeSleep() {
  const calls: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe('withRetry', () => {
  it('returns the result immediately when the function succeeds on the first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { sleep } = fakeSleep();

    const result = await withRetry(fn, { maxRetries: 3, sleep });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockResolvedValueOnce('ok');
    const { sleep } = fakeSleep();

    const result = await withRetry(fn, { maxRetries: 3, sleep, baseDelayMs: 10 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 503 }))
      .mockResolvedValueOnce('ok');
    const { sleep } = fakeSleep();

    await withRetry(fn, { maxRetries: 3, sleep, baseDelayMs: 10 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a plain network error with no status field', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce('ok');
    const { sleep } = fakeSleep();

    await withRetry(fn, { maxRetries: 3, sleep, baseDelayMs: 10 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable 4xx error (e.g. 422 validation failure)', async () => {
    const err = Object.assign(new Error('unprocessable'), { status: 422 });
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep } = fakeSleep();

    await expect(withRetry(fn, { maxRetries: 3, sleep, baseDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last error after exhausting maxRetries', async () => {
    const err = Object.assign(new Error('still failing'), { status: 503 });
    const fn = vi.fn().mockRejectedValue(err);
    const { sleep } = fakeSleep();

    await expect(withRetry(fn, { maxRetries: 2, sleep, baseDelayMs: 10 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('uses exponential backoff with jitter bounded by baseDelayMs per attempt', async () => {
    const err = Object.assign(new Error('fail'), { status: 500 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    const { sleep, calls } = fakeSleep();

    await withRetry(fn, { maxRetries: 3, sleep, baseDelayMs: 100 });

    expect(calls).toHaveLength(2);
    // attempt 1 delay in [100, 200), attempt 2 delay in [200, 300)
    expect(calls[0]).toBeGreaterThanOrEqual(100);
    expect(calls[0]).toBeLessThan(200);
    expect(calls[1]).toBeGreaterThanOrEqual(200);
    expect(calls[1]).toBeLessThan(300);
  });
});
