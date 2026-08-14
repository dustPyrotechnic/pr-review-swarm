import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDeepSeekClient } from './deepseek-client.js';
import { runExpert } from './expert-runner.js';

/**
 * 模型输出是**完全不可信**的输入。这里的语料是模型可能返回的原始文本，通过真实管线
 * 送进去：deepseek-client 的 JSON.parse（解析层）→ coerceStringifiedBoolean（归一化）
 * → ajv expert-output schema（结构层）。
 *
 * 注意：计划里假设存在 `validateExpertOutput(raw: string)`，实际不存在——真实的
 * `validate(schemaId, data)` 只吃已解析对象，解析层在 deepseek-client 里。所以这里走
 * 真实客户端 + 注入 fetch，才能同时覆盖解析层与结构层。
 */
const DIR = fileURLToPath(new URL('../../test/fixtures/malformed-llm-output/', import.meta.url));
const CASES = readdirSync(DIR)
  .filter((f) => f.endsWith('.txt'))
  .sort();

/** 合法输入：按记录在案的行为被归一化后接受，不属于"必须拒绝"的语料。 */
const ACCEPTED = new Set([
  // CHECKLIST L56 记录的真实故障：模型把 coverage_complete 返回成字符串 "true"。
  // 仅这两个精确字符串被归一化，其余任何非布尔值仍然失败。
  'coverage-complete-string.txt',
  // `1e2` 就是整数 100，是合法 JSON 与合法 integer，没有理由拒绝。
  'exp-line.txt',
  // 恰好等于 maxItems：schema 合法，但必须触发硬上限（见下方单独用例）。
  'maxitems-exact.txt',
]);

const REJECTED = CASES.filter((f) => !ACCEPTED.has(f));

function clientReturning(rawArguments: string) {
  return createDeepSeekClient({
    apiKey: 'test-key',
    maxRetries: 0,
    sleep: async () => {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'submit_result', arguments: rawArguments } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  });
}

function expertInput(rawArguments: string) {
  return {
    shardId: 'shard-1',
    agentName: 'generic-security',
    systemPromptSkills: ['## Checklist\n- security item'],
    shardContent: 'File: src/foo.ts\n+const x = 1;',
    model: 'deepseek-chat',
    client: clientReturning(rawArguments),
    maxCandidateFindingsPerAgentPerShard: 30,
  };
}

const read = (file: string): string => readFileSync(join(DIR, file), 'utf8');

describe('畸形 LLM 输出一律被拒绝（且不 crash、不 hang）', () => {
  it('语料目录非空（防止 glob 写错导致空扫描假绿）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    expect(REJECTED.length).toBeGreaterThanOrEqual(20);
  });

  it.each(REJECTED)('%s 被拒绝，而不是被当成合法结果', async (file) => {
    await expect(
      runExpert(expertInput(read(file))),
      `${file} 被错误地判为合法输出`,
    ).rejects.toThrow();
  });

  it('原型污染语料不会污染全局 Object', async () => {
    await expect(runExpert(expertInput(read('proto-pollution.txt')))).rejects.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  // 这两条语料程序生成，不落盘：一个 200KB、一个近 10MB，没有理由让它们进仓库。
  const OVERSIZED: Array<[string, () => string]> = [
    ['超深嵌套（10 万层数组）', () => '['.repeat(100_000) + ']'.repeat(100_000)],
    [
      '单字段 10MB 字符串',
      () =>
        JSON.stringify({
          shard_id: 'shard-1',
          agent: 'generic-security',
          coverage_complete: true,
          candidate_findings: [{ evidence: 'x'.repeat(10_000_000), title: 12345 }],
        }),
    ],
  ];

  it.each(OVERSIZED)('%s 在 5 秒内被拒绝（不指数级回溯、不 hang）', async (_name, build) => {
    const t0 = performance.now();
    await expect(runExpert(expertInput(build()))).rejects.toThrow();
    expect(performance.now() - t0, '处理超时').toBeLessThan(5000);
  }, 30_000);
});

describe('合法但需要特殊处理的模型输出', () => {
  it('coverage_complete 精确字符串 "true" 被归一化为布尔值并接受', async () => {
    const result = await runExpert(expertInput(read('coverage-complete-string.txt')));
    expect(result.output.coverage_complete).toBe(true);
    expect(result.hardLimitHit).toBe(false);
  });

  it.each([
    'coverage-complete-uppercase.txt',
    'coverage-complete-numeric.txt',
    'coverage-complete-yes.txt',
    'coverage-complete-missing.txt',
  ])('%s：其它任何非布尔值仍然失败（归一化刻意只认两个精确字符串）', async (file) => {
    await expect(runExpert(expertInput(read(file)))).rejects.toThrow();
  });

  it('findings 数恰好等于 maxItems 时判定命中硬上限（硬禁令 8：不静默截断）', async () => {
    const result = await runExpert(expertInput(read('maxitems-exact.txt')));
    expect(result.output.candidate_findings).toHaveLength(30);
    expect(result.hardLimitHit).toBe(true);
  });

  it('超出 maxItems 时被 schema 拒绝，而不是截断到 30 条继续', async () => {
    await expect(runExpert(expertInput(read('maxitems-exceeded.txt')))).rejects.toThrow();
  });
});

/**
 * #10：畸形 tool-call arguments 是随机的模型格式故障，和 schema 不合规同性质，
 * 却此前不重试——整轮审核因此降级为 incomplete。实测 4 次里有 3 次中招（含两次
 * 真实生产审核），远超 max_incomplete_ratio 的 0.1。
 */
describe('模型格式故障的重试边界（#10）', () => {
  const VALID = JSON.stringify({
    shard_id: 'shard-1',
    agent: 'generic-security',
    candidate_findings: [],
    coverage_complete: true,
  });

  /** 按调用序依次返回给定的响应体构造函数。 */
  function clientReturningSequence(bodies: Array<() => Response>) {
    let n = 0;
    return createDeepSeekClient({
      apiKey: 'test-key',
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        const body = bodies[Math.min(n++, bodies.length - 1)];
        if (!body) throw new Error('clientReturningSequence: 序列为空');
        return body();
      },
    });
  }

  const toolCallBody = (rawArguments: string) => () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { tool_calls: [{ function: { name: 'submit_result', arguments: rawArguments } }] } },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  function inputWith(client: ReturnType<typeof createDeepSeekClient>, maxSchemaRetries: number) {
    return {
      shardId: 'shard-1',
      agentName: 'generic-security',
      systemPromptSkills: ['## Checklist\n- security item'],
      shardContent: 'File: src/foo.ts\n+const x = 1;',
      model: 'deepseek-chat',
      client,
      maxCandidateFindingsPerAgentPerShard: 30,
      maxSchemaRetries,
      retrySleep: async () => {},
    };
  }

  it('arguments 不是合法 JSON 时重试，下一次成功即整轮成功', async () => {
    const client = clientReturningSequence([
      toolCallBody('{"shard_id": "shard-1", "agent": '), // 截断的 JSON
      toolCallBody(VALID),
    ]);

    const result = await runExpert(inputWith(client, 1));

    // 此前这里会抛 DeepSeekResponseError，整个 analyze 判 incomplete。
    expect(result.output.coverage_complete).toBe(true);
  });

  it('maxSchemaRetries=0 时不重试，仍然失败', async () => {
    const client = clientReturningSequence([toolCallBody('{oops'), toolCallBody(VALID)]);

    await expect(runExpert(inputWith(client, 0))).rejects.toThrow();
  });

  it('重试次数用尽后仍失败，不会无限重试', async () => {
    const client = clientReturningSequence([toolCallBody('{oops')]);

    await expect(runExpert(inputWith(client, 2))).rejects.toThrow(/not valid JSON/);
  });

  it('空响应体不重试：那不是随机格式故障，重试没有意义', async () => {
    let calls = 0;
    const client = createDeepSeekClient({
      apiKey: 'test-key',
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await expect(runExpert(inputWith(client, 3))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('缺 tool_calls 不重试：结构性错误，重试同样拿不到结果', async () => {
    let calls = 0;
    const client = createDeepSeekClient({
      apiKey: 'test-key',
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await expect(runExpert(inputWith(client, 3))).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('非有限数（1e309）不重试：那是确定性的内容缺陷，不是随机故障', async () => {
    let calls = 0;
    const client = createDeepSeekClient({
      apiKey: 'test-key',
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return toolCallBody(
          '{"shard_id":"s","agent":"generic-security","coverage_complete":true,"candidate_findings":[{"line":1e309}]}',
        )();
      },
    });

    await expect(runExpert(inputWith(client, 3))).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
