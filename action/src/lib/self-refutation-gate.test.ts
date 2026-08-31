import { describe, expect, it } from 'vitest';
import { isSelfRefuting } from './self-refutation-gate.js';
import type { CandidateFinding } from './expert-runner.js';

function makeFinding(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'cf-1',
    path: 'progress.sh',
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

describe('isSelfRefuting', () => {
  // 规则 1：suggestion 是空操作。取自 ios-source-learning#9 第 13 轮
  // bootstrap.sh:210 —— 那条被标成 [high]，建议字段就是「无。」。
  it.each([
    '无',
    '无。',
    '无需修改',
    '无需修改。',
    '无需改动',
    '无需变更。',
    '无问题',
    '不需要修改',
    '不适用',
    'None',
    'none.',
    'N/A',
    'n/a',
    'no change needed',
    'Nothing to change.',
  ])('rejects the no-op suggestion %j', (suggestion) => {
    expect(isSelfRefuting(makeFinding({ suggestion }))).toBe(true);
  });

  it('rejects a suggestion that is only whitespace-padded 「无。」', () => {
    expect(isSelfRefuting(makeFinding({ suggestion: '  无。  ' }))).toBe(true);
  });

  // 规则 2：正文末句是否定式结论。取自第 15 轮 progress.sh:253，那条同样标 [high]。
  it('rejects a finding whose evidence concludes there is no defect', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: 'PIPESTATUS[0] 在 printf 前仍是 git 的真实退出码，OK。综合无实际缺陷。',
          suggestion: '保持现状即可',
        }),
      ),
    ).toBe(true);
  });

  it('rejects when the impact field carries the negation', () => {
    expect(
      isSelfRefuting(
        makeFinding({ impact: '两个调用点都在控制结构中，退出码被正确处理。不构成缺陷。' }),
      ),
    ).toBe(true);
  });

  it('rejects an English negation conclusion', () => {
    expect(
      isSelfRefuting(makeFinding({ evidence: 'The caller already guards this. Not a defect.' })),
    ).toBe(true);
  });

  // ↓↓↓ 反例。这几条是这道门的硬门槛：误杀一条真缺陷，比漏过一条噪声贵得多。
  // arbitrate 的输出直接喂 computeVerdict，全部误杀就变成「审完说没问题」。 ↓↓↓

  // 实测里**唯一站得住的那条 high**（第 13 轮 update-sources.sh:104）的自然写法。
  it('keeps a real defect stated as a concessive clause', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: '计数逻辑正确，但 dry-run 分支 fetched=1; break 后漏了 FETCH_DONE 自增',
          impact: '进度条恒定偏低',
          suggestion: 'dry-run 分支中也 FETCH_DONE=$((FETCH_DONE + 1))',
        }),
      ),
    ).toBe(false);
  });

  it('keeps a finding whose negation is a first impression it then overturns', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: '乍看无问题，但 total=0 时整数除法会抛错',
          suggestion: '除法前判 total > 0',
        }),
      ),
    ).toBe(false);
  });

  it('keeps a finding that concedes one point while asking for another change', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: '这里无需修改命名，但边界判断必须补',
          suggestion: '补 total > 0 的判断',
        }),
      ),
    ).toBe(false);
  });

  it('keeps a finding whose suggestion merely mentions a no-op phrase inside a real request', () => {
    expect(
      isSelfRefuting(
        makeFinding({ suggestion: '无需改动这一处的命名，但要把边界判断补上' }),
      ),
    ).toBe(false);
  });

  it('keeps an ordinary finding', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: 'total 为 0 时 (done * 100 + current) / total 会除零',
          impact: '脚本以非零码退出',
          suggestion: '除法前判 total > 0',
        }),
      ),
    ).toBe(false);
  });

  it('keeps an English finding that concedes before stating the defect', () => {
    expect(
      isSelfRefuting(
        makeFinding({
          evidence: 'The happy path is not a defect, but the retry branch leaks the temp file.',
          suggestion: 'rm -f the temp log in the retry branch too',
        }),
      ),
    ).toBe(false);
  });
});
