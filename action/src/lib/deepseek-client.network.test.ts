import { describe, expect, it } from 'vitest';
import {
  createDeepSeekClient,
  DeepSeekResponseError,
  DeepSeekTransientError,
} from './deepseek-client.js';

/**
 * 网络故障与退避矩阵（对抗性测试加固计划 Task 7.4）。
 *
 * 注意：这些用例注入了 sleep，毫秒级完成，所以留在 PR 阻塞通道而不是 nightly ——
 * 计划把它们归在 Phase 7 下的理由是"跑得慢"，而这一组并不慢。
 */
const REQUEST = {
  model: 'deepseek-chat',
  systemPrompt: 's',
  userPrompt: 'u',
  jsonSchema: { type: 'object' as const },
};

function okBody(payload: unknown = { ok: true }) {
  return JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [{ function: { name: 'submit_result', arguments: JSON.stringify(payload) } }],
        },
      },
    ],
  });
}

/** 记录每一次 sleep 的时长，用来断言退避曲线。 */
function makeClient(
  responses: Array<() => Response | Promise<Response> | never>,
  options: { maxRetries?: number } = {},
) {
  const sleeps: number[] = [];
  let call = 0;
  const client = createDeepSeekClient({
    apiKey: 'test-key',
    maxRetries: options.maxRetries ?? 3,
    retryBaseDelayMs: 100,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    fetchImpl: async () => {
      const next = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return next() as Response;
    },
  });
  return { client, sleeps, callCount: () => call };
}

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response('{}', { status: code, headers });

describe('DeepSeek 客户端：重试判定', () => {
  it.each([429, 500, 502, 503, 504])('%s 会重试', async (code) => {
    const { client, callCount } = makeClient([() => status(code), () => new Response(okBody())]);
    await expect(client.sendStructuredRequest(REQUEST)).resolves.toEqual({ ok: true });
    expect(callCount()).toBe(2);
  });

  it.each([400, 401, 403, 404, 422])('%s 不重试（逻辑/权限错误，重试无意义）', async (code) => {
    const { client, callCount } = makeClient([() => status(code)]);
    await expect(client.sendStructuredRequest(REQUEST)).rejects.toThrow(DeepSeekResponseError);
    expect(callCount(), `${code} 不应被重试`).toBe(1);
  });

  it('401 的错误消息里不含 API key', async () => {
    const { client } = makeClient([() => status(401)]);
    let message = '';
    try {
      await client.sendStructuredRequest(REQUEST);
    } catch (err) {
      message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    }
    expect(message).not.toContain('test-key');
  });

  it('连接中途断开（fetch 抛出）会重试', async () => {
    const { client, callCount } = makeClient([
      () => {
        throw new Error('ECONNRESET');
      },
      () => new Response(okBody()),
    ]);
    await expect(client.sendStructuredRequest(REQUEST)).resolves.toEqual({ ok: true });
    expect(callCount()).toBe(2);
  });

  it('连续 429 直到上限：指数退避带抖动，最终抛 DeepSeekTransientError', async () => {
    const { client, sleeps, callCount } = makeClient([() => status(429)], { maxRetries: 3 });

    await expect(client.sendStructuredRequest(REQUEST)).rejects.toThrow(DeepSeekTransientError);

    expect(callCount()).toBe(4); // 首次 + 3 次重试
    expect(sleeps).toHaveLength(3);
    // 指数增长：第 n 次退避落在 [base*2^(n-1), base*2^(n-1) + base) —— 后半段是抖动。
    for (const [i, ms] of sleeps.entries()) {
      const exponential = 100 * 2 ** i;
      expect(ms, `第 ${i + 1} 次退避 ${ms}ms 不在预期区间`).toBeGreaterThanOrEqual(exponential);
      expect(ms).toBeLessThan(exponential + 100);
    }
    // 单调不减，确认真的是指数曲线而不是固定间隔。
    expect(sleeps[2]!).toBeGreaterThan(sleeps[0]!);
  });

  it('响应体为空 → 按 schema 失败处理，不重试', async () => {
    const { client, callCount } = makeClient([() => new Response('', { status: 200 })]);
    await expect(client.sendStructuredRequest(REQUEST)).rejects.toThrow(DeepSeekResponseError);
    expect(callCount(), '空响应体是内容问题，重试没有意义').toBe(1);
  });

  it('200 但没有匹配的 tool call → 不重试', async () => {
    const { client, callCount } = makeClient([
      () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    ]);
    await expect(client.sendStructuredRequest(REQUEST)).rejects.toThrow(DeepSeekResponseError);
    expect(callCount()).toBe(1);
  });

  it('重试次数受 maxRetries 硬约束，不会无限重试', async () => {
    const { client, callCount } = makeClient([() => status(503)], { maxRetries: 2 });
    await expect(client.sendStructuredRequest(REQUEST)).rejects.toThrow(DeepSeekTransientError);
    expect(callCount()).toBe(3);
  });
});

describe('DeepSeek 客户端：遵守服务端的 Retry-After', () => {
  it('429 带 Retry-After: 60（秒）时按该值等待，而不是自己的退避曲线', async () => {
    const { client, sleeps } = makeClient([
      () => status(429, { 'Retry-After': '60' }),
      () => new Response(okBody()),
    ]);

    await client.sendStructuredRequest(REQUEST);

    expect(sleeps).toHaveLength(1);
    // 自己的曲线在第一次重试只会等 100-200ms；服务端要求 60 秒就必须等 60 秒。
    expect(sleeps[0]).toBe(60_000);
  });

  it('503 带 Retry-After 同样生效', async () => {
    const { client, sleeps } = makeClient([
      () => status(503, { 'Retry-After': '5' }),
      () => new Response(okBody()),
    ]);
    await client.sendStructuredRequest(REQUEST);
    expect(sleeps[0]).toBe(5_000);
  });

  it('Retry-After 是 HTTP-date 形式时也能解析', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const { client, sleeps } = makeClient([
      () => status(429, { 'Retry-After': future }),
      () => new Response(okBody()),
    ]);
    await client.sendStructuredRequest(REQUEST);
    // 允许几秒误差：断言量级正确，不断言精确到毫秒。
    expect(sleeps[0]).toBeGreaterThan(20_000);
    expect(sleeps[0]).toBeLessThanOrEqual(31_000);
  });

  it.each(['not-a-number', '', '-5'])(
    'Retry-After 非法（%j）时退回自己的退避曲线，不 crash、不等 0',
    async (value) => {
      const { client, sleeps } = makeClient([
        () => status(429, { 'Retry-After': value }),
        () => new Response(okBody()),
      ]);
      await client.sendStructuredRequest(REQUEST);
      expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    },
  );

  it('Retry-After 大得离谱时被夹到上限，不会让 job 挂死到超时', async () => {
    const { client, sleeps } = makeClient([
      () => status(429, { 'Retry-After': '86400' }), // 一整天
      () => new Response(okBody()),
    ]);
    await client.sendStructuredRequest(REQUEST);
    expect(sleeps[0]).toBeLessThanOrEqual(120_000);
  });
});
