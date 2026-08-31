import { describe, expect, it } from 'vitest';
import { computeVerdict, computeFinalReviewEvent, type Verdict } from './verdict.js';
import type { CoverageManifest } from '../entrypoints/prepare.js';
import type { Finding } from './arbiter.js';

function makeCoverageManifest(overrides: Partial<CoverageManifest> = {}): CoverageManifest {
  return {
    files: [],
    shards_complete: true,
    hard_limit_hit: false,
    pulls_files_pagination_truncated: false,
    missing_patch_files: [],
    token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    ...overrides,
  };
}

function makeFinding(id: string, severity: Finding['severity'] = 'high'): Finding {
  return {
    id,
    path: 'src/foo.ts',
    line: 1,
    side: 'RIGHT',
    severity,
    confidence: 'high',
    category: 'correctness',
    title: 't',
    evidence: 'e',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
  };
}

const completeInput = {
  coverageManifest: makeCoverageManifest(),
  anyRequiredStageFailed: false,
};

describe('computeVerdict', () => {
  it('returns pass when everything is complete and there are no findings', () => {
    const result = computeVerdict({ ...completeInput, finalFindings: [] });
    expect(result.verdict).toBe('pass');
    expect(result.incompleteReasons).toEqual([]);
  });

  it('returns changes_requested when everything is complete and there is at least one finding', () => {
    const result = computeVerdict({ ...completeInput, finalFindings: [makeFinding('cf-1')] });
    expect(result.verdict).toBe('changes_requested');
  });

  it('returns incomplete when coverageManifest.hard_limit_hit is true, even with zero findings', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ hard_limit_hit: true }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('hard_limit_hit');
  });

  it('returns incomplete when anyRequiredStageFailed is true', () => {
    const result = computeVerdict({ ...completeInput, anyRequiredStageFailed: true, finalFindings: [] });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('any_required_stage_failed');
  });

  it('returns incomplete when shards_complete is false', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ shards_complete: false }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('shards_incomplete');
  });

  it('returns incomplete when pulls_files_pagination_truncated is true', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ pulls_files_pagination_truncated: true }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('pulls_files_pagination_truncated');
  });

  it('returns incomplete when there are missing_patch_files', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ missing_patch_files: ['src/huge.ts'] }),
      finalFindings: [],
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.incompleteReasons).toContain('missing_patch_files');
  });

  it('still reports incomplete (never pass) even when there happen to be findings but coverage is incomplete', () => {
    const result = computeVerdict({
      ...completeInput,
      coverageManifest: makeCoverageManifest({ hard_limit_hit: true }),
      finalFindings: [makeFinding('cf-1')],
    });
    expect(result.verdict).toBe('incomplete');
  });

  it('collects multiple incomplete reasons at once', () => {
    const result = computeVerdict({
      coverageManifest: makeCoverageManifest({
        shards_complete: false,
        missing_patch_files: ['a.ts'],
        hard_limit_hit: true,
      }),
      anyRequiredStageFailed: false,
      finalFindings: [],
    });
    expect(result.incompleteReasons).toEqual(
      expect.arrayContaining(['hard_limit_hit', 'shards_incomplete', 'missing_patch_files']),
    );
  });
});

describe('computeFinalReviewEvent', () => {
  const high = (id: string) => makeFinding(id, 'high');
  const low = (id: string) => makeFinding(id, 'low');

  it('returns COMMENT (never APPROVE) for a pass verdict — the bot never gives final merge confirmation, a human always does', () => {
    expect(computeFinalReviewEvent('pass', [])).toBe('COMMENT');
  });

  it('returns REQUEST_CHANGES for a changes_requested verdict', () => {
    expect(computeFinalReviewEvent('changes_requested', [high('a'), high('b')])).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('returns REQUEST_CHANGES for a changes_requested verdict even when every finding is low', () => {
    // 只有 incomplete 才降级。完整跑完的一轮里，low 依然是要求改动的理由。
    expect(computeFinalReviewEvent('changes_requested', [low('a')])).toBe('REQUEST_CHANGES');
  });

  it('returns REQUEST_CHANGES for an incomplete verdict that still has a non-low finding', () => {
    expect(computeFinalReviewEvent('incomplete', [low('a'), high('b')], ['shards_incomplete'])).toBe(
      'REQUEST_CHANGES',
    );
  });

  // 2026-08-29 ios-source-learning#9 第 17 轮的真实组合：没看全 + 4 条全 low
  // （其中 2 条还是自我否定的），却发了 REQUEST_CHANGES。
  it('downgrades an incomplete verdict whose findings are all low to COMMENT', () => {
    expect(
      computeFinalReviewEvent('incomplete', [low('a'), low('b')], ['any_required_stage_failed']),
    ).toBe('COMMENT');
  });

  // docs/AGENTS.md 硬禁令 8：截断之后不得因此不再阻塞。
  it('does NOT downgrade when the run is incomplete because a hard limit was hit', () => {
    expect(computeFinalReviewEvent('incomplete', [low('a')], ['hard_limit_hit'])).toBe(
      'REQUEST_CHANGES',
    );
  });

  it('does NOT downgrade when hard_limit_hit is one of several incomplete reasons', () => {
    expect(
      computeFinalReviewEvent('incomplete', [low('a')], ['shards_incomplete', 'hard_limit_hit']),
    ).toBe('REQUEST_CHANGES');
  });

  it('returns none for an incomplete verdict with zero findings — nothing to request changes on', () => {
    expect(computeFinalReviewEvent('incomplete', [], ['any_required_stage_failed'])).toBe('none');
  });

  it.each(['pass', 'changes_requested', 'incomplete'] as const)(
    'never returns APPROVE for verdict=%s at any findings count — the bot never submits an approving Review',
    (verdict) => {
      for (const count of [0, 1, 5]) {
        const findings = Array.from({ length: count }, (_, i) => high(`f${i}`));
        expect(computeFinalReviewEvent(verdict, findings)).not.toBe('APPROVE');
        expect(
          computeFinalReviewEvent(verdict, findings.map((f) => ({ ...f, severity: 'low' as const }))),
        ).not.toBe('APPROVE');
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 组合穷举不变式（对抗性测试加固计划 Task 3.1）
//
// 上面的用例逐条覆盖单个触发条件；这里穷举 5 个 incomplete 触发维度 × 5 档 findings
// 数量的全部 160 种组合，锁住"任何组合下都不会把 incomplete 升级成 pass"这类不变式。
// ---------------------------------------------------------------------------

/** computeVerdict 的 5 个 incomplete 触发维度，各自给出置位时的 manifest 片段与原因名。 */
const INCOMPLETE_DIMENSIONS: Array<[string, Partial<CoverageManifest>]> = [
  ['hard_limit_hit', { hard_limit_hit: true }],
  ['shards_incomplete', { shards_complete: false }],
  ['pulls_files_pagination_truncated', { pulls_files_pagination_truncated: true }],
  ['missing_patch_files', { missing_patch_files: ['src/gone.ts'] }],
];

const FINDING_COUNTS = [0, 1, 2, 30, 500];
const VERDICTS: Verdict[] = ['pass', 'changes_requested', 'incomplete'];

interface Combination {
  label: string;
  anyRequiredStageFailed: boolean;
  coverageManifest: CoverageManifest;
  expectedReasons: string[];
  findingCount: number;
  finalFindings: Finding[];
}

/** 5 个布尔维度（4 个 manifest 维度 + anyRequiredStageFailed）× 5 档 findings 数。 */
function allCombinations(): Combination[] {
  const combos: Combination[] = [];
  const dimensionCount = INCOMPLETE_DIMENSIONS.length;

  for (let mask = 0; mask < 1 << dimensionCount; mask += 1) {
    for (const stageFailed of [false, true]) {
      let overrides: Partial<CoverageManifest> = {};
      const expectedReasons: string[] = [];
      const labels: string[] = [];

      if (stageFailed) expectedReasons.push('any_required_stage_failed');

      INCOMPLETE_DIMENSIONS.forEach(([reason, override], index) => {
        if (mask & (1 << index)) {
          overrides = { ...overrides, ...override };
          expectedReasons.push(reason);
          labels.push(reason);
        }
      });
      if (stageFailed) labels.push('any_required_stage_failed');

      for (const findingCount of FINDING_COUNTS) {
        combos.push({
          label: `${labels.join('+') || 'clean'} / findings=${findingCount}`,
          anyRequiredStageFailed: stageFailed,
          coverageManifest: makeCoverageManifest(overrides),
          expectedReasons,
          findingCount,
          finalFindings: Array.from({ length: findingCount }, (_, i) => makeFinding(`f${i}`)),
        });
      }
    }
  }
  return combos;
}

const COMBINATIONS = allCombinations();

describe('verdict 不变式（组合穷举）', () => {
  it('穷举了预期数量的组合（防止循环写错导致空跑假绿）', () => {
    expect(COMBINATIONS).toHaveLength(2 ** INCOMPLETE_DIMENSIONS.length * 2 * FINDING_COUNTS.length);
    expect(COMBINATIONS).toHaveLength(160);
  });

  it('输出永远落在三个合法 verdict 内', () => {
    for (const combo of COMBINATIONS) {
      const { verdict } = computeVerdict(combo);
      expect(VERDICTS, combo.label).toContain(verdict);
    }
  });

  it('任一 incomplete 条件成立时永不升级为 pass', () => {
    for (const combo of COMBINATIONS) {
      if (combo.expectedReasons.length === 0) continue;
      const { verdict } = computeVerdict(combo);
      expect(verdict, combo.label).toBe('incomplete');
    }
  });

  it('pass 只在所有覆盖条件干净且零 finding 时出现', () => {
    for (const combo of COMBINATIONS) {
      const { verdict } = computeVerdict(combo);
      if (verdict === 'pass') {
        expect(combo.expectedReasons, combo.label).toEqual([]);
        expect(combo.findingCount, combo.label).toBe(0);
      }
    }
  });

  it('incompleteReasons 完整列出所有被触发的原因，一个都不漏、一个都不多', () => {
    for (const combo of COMBINATIONS) {
      const { verdict, incompleteReasons } = computeVerdict(combo);
      if (verdict !== 'incomplete') {
        expect(incompleteReasons, combo.label).toEqual([]);
        continue;
      }
      expect([...incompleteReasons].sort(), combo.label).toEqual([...combo.expectedReasons].sort());
    }
  });

  it('任何组合下 final_review_event 都不是 APPROVE', () => {
    for (const combo of COMBINATIONS) {
      const { verdict } = computeVerdict(combo);
      expect(
        computeFinalReviewEvent(verdict, combo.finalFindings, combo.expectedReasons),
        combo.label,
      ).not.toBe('APPROVE');
    }
  });

  // COMBINATIONS 的 finding 夹具都是 high 严重度，所以这条原始不变式在
  // 「incomplete + 全 low」例外引入之后依然逐条成立 —— 例外只在全 low 时触发。
  it('findings > 0 且含非 low 时 final_review_event 必为 REQUEST_CHANGES', () => {
    for (const combo of COMBINATIONS) {
      if (combo.findingCount === 0) continue;
      const { verdict, incompleteReasons } = computeVerdict(combo);
      expect(
        computeFinalReviewEvent(verdict, combo.finalFindings, incompleteReasons),
        combo.label,
      ).toBe('REQUEST_CHANGES');
    }
  });

  // 例外的穷举面：把同一批组合的 finding 全换成 low，逐条核对降级只在
  // 「incomplete 且 incompleteReasons 不含 hard_limit_hit」时发生。
  it('全 low 时只有 incomplete 且非硬上限才降级为 COMMENT', () => {
    for (const combo of COMBINATIONS) {
      if (combo.findingCount === 0) continue;
      const lowFindings = combo.finalFindings.map((f) => ({ ...f, severity: 'low' as const }));
      const { verdict, incompleteReasons } = computeVerdict({ ...combo, finalFindings: lowFindings });
      const event = computeFinalReviewEvent(verdict, lowFindings, incompleteReasons);

      const shouldDowngrade =
        verdict === 'incomplete' && !incompleteReasons.includes('hard_limit_hit');
      expect(event, combo.label).toBe(shouldDowngrade ? 'COMMENT' : 'REQUEST_CHANGES');
    }
  });

  // 硬禁令 8：命中硬上限意味着我们主动截断了分析，截断之后不得因此不再阻塞。
  it('硬上限引起的 incomplete 即便全 low 也不降级', () => {
    for (const combo of COMBINATIONS) {
      if (combo.findingCount === 0) continue;
      const { incompleteReasons } = computeVerdict(combo);
      if (!incompleteReasons.includes('hard_limit_hit')) continue;
      const lowFindings = combo.finalFindings.map((f) => ({ ...f, severity: 'low' as const }));
      expect(
        computeFinalReviewEvent('incomplete', lowFindings, incompleteReasons),
        combo.label,
      ).toBe('REQUEST_CHANGES');
    }
  });

  it('incomplete + 0 finding 时 final_review_event 为 none（只更新摘要，不提交 Review）', () => {
    for (const combo of COMBINATIONS) {
      const { verdict } = computeVerdict(combo);
      if (verdict === 'incomplete' && combo.findingCount === 0) {
        expect(
          computeFinalReviewEvent(verdict, combo.finalFindings, combo.expectedReasons),
          combo.label,
        ).toBe('none');
      }
    }
  });

  it('severity 不影响 verdict：只含 low 与只含 critical 得到相同结论', () => {
    for (const combo of COMBINATIONS) {
      if (combo.findingCount === 0) continue;
      const low = combo.finalFindings.map((f) => ({ ...f, severity: 'low' as const }));
      const critical = combo.finalFindings.map((f) => ({ ...f, severity: 'critical' as const }));
      const a = computeVerdict({ ...combo, finalFindings: low });
      const b = computeVerdict({ ...combo, finalFindings: critical });
      expect(a.verdict, combo.label).toBe(b.verdict);
      expect(a.incompleteReasons, combo.label).toEqual(b.incompleteReasons);
    }
  });

  it('computeVerdict 产不出 stale_cancelled —— 它是 publish 层的终态，不由覆盖数据推导', () => {
    // 计划原文把 stale_cancelled 列进 computeVerdict 的输出集合，实际不是：
    // Verdict 只有三个值，publish.ts 用 `Verdict | 'stale_cancelled'` 在身份元组不匹配时
    // 短路，根本不会走到这里（publish.ts:102/473）。
    for (const combo of COMBINATIONS) {
      expect(computeVerdict(combo).verdict as string, combo.label).not.toBe('stale_cancelled');
    }
  });
});
