import { describe, expect, it, vi } from 'vitest';
import { verifyFinding, VerifierUnavailableError } from './verifier-client.js';
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
