import { describe, expect, it, vi } from 'vitest';
import { verifyFinding, VerifierUnavailableError, VerifierSchemaError } from './verifier-client.js';
import { DeepSeekMalformedResultError, DeepSeekResponseError } from './deepseek-client.js';
import type { CandidateFinding } from './expert-runner.js';

function makeFinding(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'cf-1',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 'title',
    evidence: 'evidence',
    impact: 'impact',
    suggestion: 'suggestion',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    ...overrides,
  };
}

const baseArgs = { model: 'deepseek-test-model', contextContent: 'context bundle' };

describe('verifyFinding', () => {
  it('returns a confirmed conclusion as-is for a normal (non-cross-file) finding', async () => {
    const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ status: 'confirmed' }) };

    const result = await verifyFinding({ ...baseArgs, finding: makeFinding(), client });

    expect(result.status).toBe('confirmed');
  });

  it('returns a rejected conclusion as-is', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({ status: 'rejected', notes: 'not reproducible' }),
    };

    const result = await verifyFinding({ ...baseArgs, finding: makeFinding(), client });

    expect(result.status).toBe('rejected');
  });

  it('forces rejection for a cross-file causal claim when the verifier provides no evidence_refs', async () => {
    const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ status: 'confirmed' }) };
    const finding = makeFinding({
      cross_file_causal_claim: true,
      causal_evidence_refs: [{ path: 'src/bar.ts', line: 5 }],
    });

    const result = await verifyFinding({ ...baseArgs, finding, client });

    expect(result.status).toBe('rejected');
  });

  it('keeps confirmed for a cross-file causal claim when the verifier cites evidence_refs', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({
        status: 'confirmed',
        evidence_refs: [{ path: 'src/bar.ts', line: 5 }],
      }),
    };
    const finding = makeFinding({
      cross_file_causal_claim: true,
      causal_evidence_refs: [{ path: 'src/bar.ts', line: 5 }],
    });

    const result = await verifyFinding({ ...baseArgs, finding, client });

    expect(result.status).toBe('confirmed');
  });

  it('wraps a client failure as VerifierUnavailableError', async () => {
    const client = { sendStructuredRequest: vi.fn().mockRejectedValue(new Error('timeout')) };

    await expect(verifyFinding({ ...baseArgs, finding: makeFinding(), client })).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
  });

  it('wraps a schema validation failure as VerifierUnavailableError', async () => {
    const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ status: 'not-a-valid-status' }) };

    await expect(verifyFinding({ ...baseArgs, finding: makeFinding(), client })).rejects.toBeInstanceOf(
      VerifierUnavailableError,
    );
  });
});

/**
 * 重试策略。expert-runner 早就有 withRetry 兜底同一类失败，verifier 侧一直没有
 * —— 一次抖动就把整轮判成 incomplete。2026-08-29 的 ios-source-learning#9 第 17
 * 轮正是如此：verifier 少了个 status 字段，整轮报废。
 *
 * 但不能无差别重试：verifyFinding 把客户端的**任何**异常都包成
 * VerifierUnavailableError，其中 401、空响应体、缺 tool_calls 都是确定性失败，
 * 重试 200 × 2 次只烧配额。只有 schema 抖动和畸形 tool-call 值得重试。
 */
describe('verifyFinding retries', () => {
  const retrySleep = () => Promise.resolve();

  it('retries a schema-invalid response and succeeds on the second attempt', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        // 与第 17 轮线上观测一致：缺 status
        .mockResolvedValueOnce({ notes: 'looks fine' })
        .mockResolvedValueOnce({ status: 'rejected' }),
    };

    const result = await verifyFinding({
      ...baseArgs,
      finding: makeFinding(),
      client,
      maxSchemaRetries: 1,
      retrySleep,
    });

    expect(result.status).toBe('rejected');
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
  });

  it('retries a malformed tool-call payload', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        .mockRejectedValueOnce(
          new DeepSeekMalformedResultError('deepseek-client: tool call arguments are not valid JSON'),
        )
        .mockResolvedValueOnce({ status: 'confirmed' }),
    };

    const result = await verifyFinding({
      ...baseArgs,
      finding: makeFinding(),
      client,
      maxSchemaRetries: 1,
      retrySleep,
    });

    expect(result.status).toBe('confirmed');
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a deterministic client failure — retrying a 401 only burns quota', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        .mockRejectedValue(new DeepSeekResponseError('deepseek-client: request failed with status 401')),
    };

    await expect(
      verifyFinding({ ...baseArgs, finding: makeFinding(), client, maxSchemaRetries: 3, retrySleep }),
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a missing-tool_calls response', async () => {
    const client = {
      sendStructuredRequest: vi
        .fn()
        .mockRejectedValue(
          new DeepSeekResponseError('deepseek-client: response missing choices[0].message.tool_calls'),
        ),
    };

    await expect(
      verifyFinding({ ...baseArgs, finding: makeFinding(), client, maxSchemaRetries: 3, retrySleep }),
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });

  it('still throws once schema retries are exhausted', async () => {
    const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ notes: 'no status' }) };

    await expect(
      verifyFinding({ ...baseArgs, finding: makeFinding(), client, maxSchemaRetries: 1, retrySleep }),
    ).rejects.toBeInstanceOf(VerifierSchemaError);
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry at all by default (maxSchemaRetries defaults to 0)', async () => {
    const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ notes: 'no status' }) };

    await expect(
      verifyFinding({ ...baseArgs, finding: makeFinding(), client }),
    ).rejects.toBeInstanceOf(VerifierUnavailableError);
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });
});
