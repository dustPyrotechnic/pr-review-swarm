import { describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekClient,
  DeepSeekTransientError,
  DeepSeekResponseError,
} from './deepseek-client.js';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function successBody(content: unknown) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

const baseInput = {
  model: 'deepseek-test-model',
  systemPrompt: 'system',
  userPrompt: 'user',
  jsonSchema: { type: 'object' },
};

describe('createDeepSeekClient / sendStructuredRequest', () => {
  it('returns the parsed JSON content on a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successBody({ hello: 'world' })));
    const client = createDeepSeekClient({ apiKey: 'key', fetchImpl, sleep: async () => {} });

    const result = await client.sendStructuredRequest(baseInput);

    expect(result).toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(requestInit.headers).toMatchObject({ Authorization: 'Bearer key' });
  });

  it('retries on a 429 status and succeeds on the next attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, successBody({ ok: true })));
    const client = createDeepSeekClient({ apiKey: 'key', fetchImpl, sleep: async () => {} });

    const result = await client.sendStructuredRequest(baseInput);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on a network error and succeeds on the next attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, successBody({ ok: true })));
    const client = createDeepSeekClient({ apiKey: 'key', fetchImpl, sleep: async () => {} });

    const result = await client.sendStructuredRequest(baseInput);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws DeepSeekTransientError after exhausting retries on persistent 500s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const client = createDeepSeekClient({
      apiKey: 'key',
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });

    await expect(client.sendStructuredRequest(baseInput)).rejects.toBeInstanceOf(
      DeepSeekTransientError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('does not retry on a non-retryable 400 status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    const client = createDeepSeekClient({ apiKey: 'key', fetchImpl, sleep: async () => {} });

    await expect(client.sendStructuredRequest(baseInput)).rejects.toBeInstanceOf(
      DeepSeekResponseError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the response content is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'not json' } }] }),
    );
    const client = createDeepSeekClient({ apiKey: 'key', fetchImpl, sleep: async () => {} });

    await expect(client.sendStructuredRequest(baseInput)).rejects.toBeInstanceOf(
      DeepSeekResponseError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
