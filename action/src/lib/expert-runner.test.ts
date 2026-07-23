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
  // occasionally returns coverage_complete as a non-boolean (e.g. a
  // stringified "true") on an otherwise-valid tool call — a stochastic
  // formatting slip, not a deterministic prompt defect: an identical
  // request succeeded on the very next attempt. One retry is cheap
  // insurance against this class of one-off model glitch.
  it('retries once and succeeds when the first response fails schema validation but the retry is valid', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        .mockResolvedValueOnce({ ...makeValidExpertOutput(1, true), coverage_complete: 'true' })
        .mockResolvedValueOnce(makeValidExpertOutput(1, true)),
    };
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    const result = await runExpert({ ...baseInput, client, maxSchemaRetries: 1, retrySleep });

    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
    expect(result.output.candidate_findings).toHaveLength(1);
  });

  it('gives up and throws after exhausting maxSchemaRetries on persistent schema-invalid responses', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ ...makeValidExpertOutput(1, true), coverage_complete: 'true' }),
    };
    const retrySleep = vi.fn().mockResolvedValue(undefined);

    await expect(runExpert({ ...baseInput, client, maxSchemaRetries: 2, retrySleep })).rejects.toThrow(
      /schema validation/,
    );
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('includes the actually-observed offending value in the error, so job logs show what the model really returned', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ ...makeValidExpertOutput(1, true), coverage_complete: 'true' }),
    };

    await expect(runExpert({ ...baseInput, client })).rejects.toThrow(/coverage_complete.*"true"|"true".*coverage_complete/);
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
