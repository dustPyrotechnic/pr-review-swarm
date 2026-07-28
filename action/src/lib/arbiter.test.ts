import { describe, expect, it } from 'vitest';
import { arbitrate, type VerifiedCandidate } from './arbiter.js';
import { validate } from './schema-validator.js';
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

describe('arbitrate', () => {
  it('produces a schema-valid Finding for a single confirmed candidate', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding(),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(1);
    const validation = validate('https://pr-review-swarm/schemas/finding.schema.json', result.findings[0]);
    expect(validation.valid).toBe(true);
  });

  it('merges two candidates pointing at the same path+line+category into one finding', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-1', title: 'first description' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
      {
        finding: makeFinding({ id: 'cf-2', title: 'second description, same issue' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'confirmed' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(1);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-2', outcome: 'merged_into', mergedIntoId: 'cf-1' }),
    );
  });

  it('excludes a candidate that failed deterministic validation from findings', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-fail' }),
        deterministicStatus: 'failed',
        deterministicReason: 'line not part of any changed hunk',
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(0);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-fail', outcome: 'rejected_deterministic' }),
    );
  });

  it('excludes a candidate the verifier rejected from findings', () => {
    const candidates: VerifiedCandidate[] = [
      {
        finding: makeFinding({ id: 'cf-rejected' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'rejected', notes: 'existing guard already handles this' },
      },
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(0);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-rejected', outcome: 'rejected_verifier' }),
    );
  });

  it('never lets a rejected or failed candidate id appear anywhere in the findings output', () => {
    const candidates: VerifiedCandidate[] = [
      { finding: makeFinding({ id: 'cf-ok' }), deterministicStatus: 'passed', verifierConclusion: { status: 'confirmed' } },
      { finding: makeFinding({ id: 'cf-fail', line: 20 }), deterministicStatus: 'failed' },
      {
        finding: makeFinding({ id: 'cf-rejected', line: 30 }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'rejected' },
      },
    ];

    const result = arbitrate(candidates);

    const findingIds = result.findings.map((f) => f.id);
    expect(findingIds).toEqual(['cf-ok']);
  });
});

// ---------------------------------------------------------------------------
// 跨文件因果声明的收尾判定（对抗性测试加固计划 Task 4.3 表格最后两行）
// ---------------------------------------------------------------------------

describe('跨文件因果声明由 verifier 决定去留', () => {
  const crossFile = makeFinding({ id: 'cross-1', cross_file_causal_claim: true });

  it('verifier 找不到真实调用点（rejected）→ 不成为 finding', () => {
    const result = arbitrate([
      {
        finding: crossFile,
        deterministicStatus: 'deferred_to_verifier',
        verifierConclusion: { status: 'rejected', notes: 'no call site found' },
      },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cross-1', outcome: 'rejected_verifier' }),
    );
  });

  it('deferred 但完全没有 verifier 结论 → 不成为 finding（未验证候选绝不发布）', () => {
    // 硬禁令 7：只有走完确定性校验 + 独立 verifier 的候选才能成为最终 finding。
    const result = arbitrate([
      { finding: crossFile, deterministicStatus: 'deferred_to_verifier' },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cross-1', outcome: 'rejected_verifier' }),
    );
  });

  it('verifier 确认（confirmed）→ 成为 finding，并记录 deferred 来源', () => {
    const result = arbitrate([
      {
        finding: crossFile,
        deterministicStatus: 'deferred_to_verifier',
        verifierConclusion: { status: 'confirmed', notes: 'call site at src/bar.ts:42' },
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.id).toBe('cross-1');
    expect(result.findings[0]!.verifier_conclusion.status).toBe('confirmed');
  });

  it('确定性 failed 的候选即使 verifier 确认也不成为 finding（顺序不可颠倒）', () => {
    const result = arbitrate([
      {
        finding: makeFinding({ id: 'det-failed' }),
        deterministicStatus: 'failed',
        deterministicReason: 'line outside every changed hunk',
        verifierConclusion: { status: 'confirmed' },
      },
    ]);

    expect(result.findings).toEqual([]);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'det-failed', outcome: 'rejected_deterministic' }),
    );
  });
});
