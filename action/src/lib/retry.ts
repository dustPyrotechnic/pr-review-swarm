export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
}

function defaultIsRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === undefined) return true; // network error, no HTTP status at all
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < options.maxRetries && isRetryable(err)) {
        attempt += 1;
        await sleep(backoffDelay(attempt, baseDelayMs));
        continue;
      }
      throw err;
    }
  }
}
