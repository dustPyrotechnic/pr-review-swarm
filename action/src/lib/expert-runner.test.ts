import { describe, expect, it, vi } from 'vitest';
import { runExpert } from './expert-runner.js';

function makeValidExpertOutput(count: number, coverageComplete: boolean) {
  return {
    shard_id: 'shard-1',
    agent: 'generic-correctness',
    coverage_complete: coverageComplete,
    candidate_findings: Array.from({ length: count }, (_, i) => ({
      id: `cf-${i + 1}`,
      path: 'src/foo.ts',
      line: i + 1,
      side: 'RIGHT',
      severity: 'low',
      confidence: 'medium',
      category: 'style',
      title: `Finding ${i + 1}`,
      evidence: 'evidence',
      impact: 'impact',
      suggestion: 'suggestion',
      introduced_by_pr: true,
      source_agent: 'generic-correctness',
    })),
  };
}

const baseInput = {
  shardId: 'shard-1',
  agentName: 'generic-correctness',
  systemPromptSkills: ['## Checklist\n- [ ] check something'],
  shardContent: 'diff content here',
  model: 'deepseek-test-model',
  maxCandidateFindingsPerAgentPerShard: 30,
};

describe('runExpert', () => {
  it('returns a validated output with hardLimitHit false for a normal, complete response', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue(makeValidExpertOutput(2, true)),
    };

    const result = await runExpert({ ...baseInput, client });

    expect(result.hardLimitHit).toBe(false);
    expect(result.output.candidate_findings).toHaveLength(2);
  });

  it('passes the model, schema, and a wrapped user prompt to the client', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue(makeValidExpertOutput(1, true)),
    };

    await runExpert({ ...baseInput, client });

    expect(client.sendStructuredRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-test-model',
        jsonSchema: expect.any(Object),
        userPrompt: expect.stringContaining('diff content here'),
      }),
    );
    const call = client.sendStructuredRequest.mock.calls[0]![0] as { systemPrompt: string };
    expect(call.systemPrompt).toContain('check something');
  });

  it('marks hardLimitHit when coverage_complete is false', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue(makeValidExpertOutput(1, false)),
    };

    const result = await runExpert({ ...baseInput, client });

    expect(result.hardLimitHit).toBe(true);
  });

  it('marks hardLimitHit when candidate_findings length equals maxItems, even if coverage_complete is true', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue(makeValidExpertOutput(30, true)),
    };

    const result = await runExpert({ ...baseInput, client, maxCandidateFindingsPerAgentPerShard: 30 });

    expect(result.hardLimitHit).toBe(true);
  });

  it('throws when the model response fails expert-output schema validation', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ not: 'a valid expert output' }),
    };

    await expect(runExpert({ ...baseInput, client })).rejects.toThrow();
  });

  // Real-world evidence (2026-07-23 sandbox reproduction): DeepSeek
  // occasionally returns a genuinely malformed response (e.g. a missing
  // required field) on an otherwise-normal tool call — a stochastic
  // formatting slip, not a deterministic prompt defect: an identical
  // request succeeded on a subsequent attempt. One retry is cheap
  // insurance against this class of one-off model glitch. (Stringified
  // "true"/"false" for coverage_complete specifically is coerced instead
  // of retried — see the dedicated tests below — since retrying was
  // observed NOT to reliably fix it: two independent sandbox runs both
  // returned the string form on every attempt.)
  it('retries once and succeeds when the first response is genuinely malformed but the retry is valid', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        .mockResolvedValueOnce({ not: 'a valid expert output' })
        .mockResolvedValueOnce(makeValidExpertOutput(1, true)),
    };
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    const result = await runExpert({ ...baseInput, client, maxSchemaRetries: 1, retrySleep });

    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
    expect(result.output.candidate_findings).toHaveLength(1);
  });

  it('gives up and throws after exhausting maxSchemaRetries on persistently malformed responses', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ not: 'a valid expert output' }),
    };
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    await expect(runExpert({ ...baseInput, client, maxSchemaRetries: 2, retrySleep })).rejects.toThrow(
      /schema validation/,
    );
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('includes the actually-observed offending value in the error, so job logs show what the model really returned', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ not: 'a valid expert output' }),
    };

    await expect(runExpert({ ...baseInput, client })).rejects.toThrow(/observed top-level fields/);
  });

  // Real-world evidence (2026-07-23 sandbox reproduction, two independent
  // runs): DeepSeek returned coverage_complete as the literal string
  // "true" instead of the JSON boolean, on an otherwise well-formed tool
  // call — e.g. {"shard_id":"diff","agent":"generic-security",
  // "coverage_complete":"true"}. This is an unambiguous, benign type
  // near-miss on a control-flow-only field (not finding evidence/content),
  // and a well-known quirk of tool-calling APIs that don't enforce strict
  // JSON-schema typing — safe to normalize rather than reject.
  it('coerces a literal "true"/"false" string for coverage_complete instead of failing validation', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ ...makeValidExpertOutput(1, true), coverage_complete: 'true' }),
    };

    const result = await runExpert({ ...baseInput, client });

    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1); // no retry needed
    expect(result.hardLimitHit).toBe(false);
  });

  it('coerces coverage_complete: "false" to boolean false (still marks hardLimitHit)', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ ...makeValidExpertOutput(1, true), coverage_complete: 'false' }),
    };

    const result = await runExpert({ ...baseInput, client });

    expect(result.hardLimitHit).toBe(true);
  });

  it('does not coerce other invalid coverage_complete values (e.g. a number) — still a genuine validation failure', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ ...makeValidExpertOutput(1, true), coverage_complete: 1 }),
    };

    await expect(runExpert({ ...baseInput, client })).rejects.toThrow(/schema validation/);
  });

  it('does not retry a network/transport error — only schema-validation failures are retried here', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockRejectedValue(new Error('network boom')),
    };
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    await expect(runExpert({ ...baseInput, client, maxSchemaRetries: 2, retrySleep })).rejects.toThrow(
      'network boom',
    );
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });
});

/**
 * issue #12：模型把「碰到的文件里的历史遗留问题」当成本次引入的缺陷报出来。
 *
 * 实测：historical-todo-in-touched-file 用例的陷阱被稳定命中（3 轮 3 中）——
 * 模型报出了文件里那条 2019 年的 TODO，而它出现在 hunk 的**上下文行**里，只是
 * 因为紧邻新增代码才被一起送进来。
 *
 * #9 修完后 shard 内容已经用 "+" 明确区分了新增行与上下文行，约束所需的信息就在
 * prompt 里，缺的是把它讲成一条硬规则。
 */
describe('本次引入 vs 历史遗留的边界（#12）', () => {
  async function systemPromptOf() {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue(makeValidExpertOutput(0, true)),
    };
    await runExpert({ ...baseInput, client });
    return (client.sendStructuredRequest.mock.calls[0]![0] as { systemPrompt: string })
      .systemPrompt;
  }

  it('讲明「+」标记的行才是本次新增', async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toMatch(/"\+"/);
  });

  it('讲明没有标记的行属于既有代码', async () => {
    const prompt = await systemPromptOf();
    expect(prompt.toLowerCase()).toMatch(/pre-?exist|already|unchanged|context line/);
  });

  it('保留「被本次改动 exposed / made reachable」这个例外', async () => {
    // 不能矫枉过正：设计文档明确允许报「本次改动使其出错或首次可达」的既有问题。
    // 一刀切禁止上下文行会把这类真实缺陷一起禁掉——那是用另一个漏报换掉一个误报。
    const prompt = await systemPromptOf();
    expect(prompt.toLowerCase()).toMatch(/exposed|reachable/);
  });

  it('明确点出「文件里碰巧存在的旧问题」不该报', async () => {
    // 这正是 historical-todo 用例的形态：一条 2019 年的 TODO 出现在上下文行里。
    const prompt = await systemPromptOf();
    expect(prompt.toLowerCase()).toMatch(/pre-dates|predates|already there|long-standing|historical/);
  });

  it('行号契约仍然在（#9 的修复不能被这次改动挤掉）', async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain('post-image');
    expect(prompt).toContain('RIGHT');
  });
});
