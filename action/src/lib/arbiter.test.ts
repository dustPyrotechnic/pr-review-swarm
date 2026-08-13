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

  it('merges two candidates pointing at the same path+line into one finding', () => {
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

/**
 * 去重键刻意不含 category。
 *
 * 2026-08-13 的全量评测暴露了旧键（path|line|category）的后果：category 是自由
 * 文本，模型每次措辞都可能不同，于是同一行的同一个问题变成多条独立 finding，
 * 用户在同一行代码上收到好几条 inline 评论。
 */
function confirmedCandidate(overrides: Partial<CandidateFinding>): VerifiedCandidate {
  return {
    finding: makeFinding(overrides),
    deterministicStatus: 'passed',
    verifierConclusion: { status: 'confirmed' },
  };
}

describe('去重键不含自由文本 category', () => {
  it('同一位置、category 措辞不同的候选被合并成一条', () => {
    // 实测语料：模型在 webhook.go:9 分别报出 "hardcoded credential" 与
    // "hardcoded-credential"，只差一个连字符就绕过了旧的去重键。
    const result = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'hardcoded credential' }),
      confirmedCandidate({ id: 'b', path: 'a.go', line: 9, category: 'hardcoded-credential' }),
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.internalDiagnostics.filter((d) => d.outcome === 'merged_into')).toHaveLength(1);
  });

  it('同一行的四条不同措辞全部合并（实测 go-goroutine-leak 的形态）', () => {
    const result = arbitrate(
      ['concurrency', 'concurrency-race', 'unbounded-goroutines', 'unnecessary-complexity'].map(
        (category, i) => confirmedCandidate({ id: `c${i}`, path: 'pool.go', line: 15, category }),
      ),
    );

    expect(result.findings).toHaveLength(1);
  });

  it('不同行仍然各自成条——合并只在同一位置发生', () => {
    const result = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'b', path: 'a.go', line: 20, category: 'x' }),
    ]);

    expect(result.findings).toHaveLength(2);
  });

  it('不同文件的同一行号不合并', () => {
    const result = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'b', path: 'b.go', line: 9, category: 'x' }),
    ]);

    expect(result.findings).toHaveLength(2);
  });

  it('被合并掉的条目在 internalDiagnostics 里可追溯到代表条目', () => {
    // 合并不能是静默丢弃：否则「模型报了但用户没看到」会变成一个查不出的黑洞。
    const result = arbitrate([
      confirmedCandidate({ id: 'keep', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'gone', path: 'a.go', line: 9, category: 'y' }),
    ]);

    const merged = result.internalDiagnostics.find((d) => d.id === 'gone');
    expect(merged?.outcome).toBe('merged_into');
    expect(merged?.mergedIntoId).toBe(result.findings[0]!.id);
  });
});

/**
 * 不变式：合并不改变 findings 的 (path, line) 集合。
 *
 * 这条支撑了一个关键判断。2026-08-13 修去重之后的全量评测里，召回率 91.4% →
 * 88.9%、抖动 0.168 → 0.241，两项都变差了。但评测的匹配规则（metrics.mjs 的
 * matches）与抖动度量（findingKey）都只看 path + line —— 而合并是按 path|line
 * 分组的，组内成员这两个字段必然相同。所以合并只能减少「同一位置的重复条目数」，
 * 不可能减少位置的种类。
 *
 * 换句话说：那两项变差在数学上与去重无关，只能是模型的轮间噪音。把这条推理写成
 * 断言，是为了让将来任何人改 arbiter 时，都不会悄悄破坏这个前提——否则下一次
 * 指标下降就再也分不清是回归还是噪音了。
 */
describe('不变式：合并不改变 (path, line) 集合', () => {
  const positionsOf = (xs: Array<{ path: string; line: number }>) =>
    [...new Set(xs.map((x) => `${x.path}|${x.line}`))].sort();

  it('同一位置的多条措辞合并后，位置集合不变', () => {
    const candidates = [
      confirmedCandidate({ id: 'a', path: 'a.go', line: 10, category: 'x' }),
      confirmedCandidate({ id: 'b', path: 'a.go', line: 10, category: 'y' }),
      confirmedCandidate({ id: 'c', path: 'a.go', line: 10, category: 'z' }),
    ];

    const result = arbitrate(candidates);

    expect(result.findings).toHaveLength(1);
    expect(positionsOf(result.findings)).toEqual(positionsOf(candidates.map((c) => c.finding)));
  });

  it('多位置混合重复：条目数下降，位置集合仍然一致', () => {
    const candidates = [
      confirmedCandidate({ id: 'a1', path: 'a.go', line: 10, category: 'x' }),
      confirmedCandidate({ id: 'a2', path: 'a.go', line: 10, category: 'y' }),
      confirmedCandidate({ id: 'b1', path: 'a.go', line: 25, category: 'x' }),
      confirmedCandidate({ id: 'c1', path: 'b.go', line: 10, category: 'x' }),
      confirmedCandidate({ id: 'c2', path: 'b.go', line: 10, category: 'q' }),
      confirmedCandidate({ id: 'c3', path: 'b.go', line: 10, category: 'r' }),
    ];

    const result = arbitrate(candidates);

    // 6 条候选 → 3 个位置
    expect(result.findings).toHaveLength(3);
    expect(positionsOf(result.findings)).toEqual(['a.go|10', 'a.go|25', 'b.go|10']);
    expect(positionsOf(result.findings)).toEqual(positionsOf(candidates.map((c) => c.finding)));
  });

  it('每个位置至少保留一条——合并不会让某个位置整体消失', () => {
    const lines = [3, 3, 7, 11, 11, 11, 20];
    const candidates = lines.map((line, i) =>
      confirmedCandidate({ id: `c${i}`, path: 'a.go', line, category: `cat-${i}` }),
    );

    const result = arbitrate(candidates);

    for (const line of new Set(lines)) {
      expect(
        result.findings.some((f) => f.line === line),
        `位置 a.go:${line} 在合并后消失了`,
      ).toBe(true);
    }
  });
});
