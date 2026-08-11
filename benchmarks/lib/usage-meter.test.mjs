import { describe, expect, it } from 'vitest';
import { createMeteredFetch } from './usage-meter.mjs';

const PRICING = { input_usd_per_million: 1, output_usd_per_million: 2 };

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CHAT_BODY = {
  choices: [{ message: { content: '{}' } }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 },
};

describe('createMeteredFetch', () => {
  it('把响应原样传给下游（body 未被计量层消费）', async () => {
    const { fetchImpl } = createMeteredFetch(async () => jsonResponse(CHAT_BODY), PRICING);

    const res = await fetchImpl('https://api.deepseek.com/chat/completions', { method: 'POST' });
    // 计量层若直接 res.json() 读掉 body，客户端拿到的就是一个已消费的流。
    const parsed = await res.json();

    expect(parsed.choices[0].message.content).toBe('{}');
  });

  it('累加多次调用的 token 用量', async () => {
    const { fetchImpl, stats } = createMeteredFetch(async () => jsonResponse(CHAT_BODY), PRICING);

    await fetchImpl('u', {});
    await fetchImpl('u', {});

    expect(stats.requests).toBe(2);
    expect(stats.promptTokens).toBe(2000);
    expect(stats.completionTokens).toBe(1000);
  });

  it('按定价算出美元成本', async () => {
    const { fetchImpl, stats } = createMeteredFetch(async () => jsonResponse(CHAT_BODY), PRICING);

    await fetchImpl('u', {});

    // 1000 input @ $1/M + 500 output @ $2/M = 0.001 + 0.001
    expect(stats.costUsd).toBeCloseTo(0.002, 10);
  });

  it('记录每次请求的耗时', async () => {
    const { fetchImpl, stats } = createMeteredFetch(async () => jsonResponse(CHAT_BODY), PRICING);

    await fetchImpl('u', {});

    expect(stats.latenciesMs).toHaveLength(1);
    expect(stats.latenciesMs[0]).toBeGreaterThanOrEqual(0);
  });

  it('响应没有 usage 字段时不炸，但记进 missingUsage', async () => {
    const { fetchImpl, stats } = createMeteredFetch(
      async () => jsonResponse({ choices: [] }),
      PRICING,
    );

    await fetchImpl('u', {});

    expect(stats.promptTokens).toBe(0);
    // 静默当成 0 会让成本门槛在 API 改字段名之后永远绿灯。
    expect(stats.missingUsage).toBe(1);
  });

  it('响应不是 JSON 时不炸，且仍把原响应交给下游', async () => {
    const { fetchImpl, stats } = createMeteredFetch(
      async () => new Response('502 Bad Gateway', { status: 502 }),
      PRICING,
    );

    const res = await fetchImpl('u', {});

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('502 Bad Gateway');
    expect(stats.missingUsage).toBe(1);
  });

  it('下游 fetch 抛错时照样记一次请求与耗时，然后把错误透传', async () => {
    const { fetchImpl, stats } = createMeteredFetch(async () => {
      throw new Error('ECONNRESET');
    }, PRICING);

    await expect(fetchImpl('u', {})).rejects.toThrow('ECONNRESET');
    // 漏记失败请求会让 p95 延迟只统计成功路径，掩盖掉超时。
    expect(stats.requests).toBe(1);
    expect(stats.latenciesMs).toHaveLength(1);
  });

  it('重试导致的多次 HTTP 调用各记一次', async () => {
    let n = 0;
    const { fetchImpl, stats } = createMeteredFetch(async () => {
      n += 1;
      return n === 1 ? jsonResponse({}, { status: 429 }) : jsonResponse(CHAT_BODY);
    }, PRICING);

    await fetchImpl('u', {});
    await fetchImpl('u', {});

    expect(stats.requests).toBe(2);
    expect(stats.promptTokens).toBe(1000);
  });
});
