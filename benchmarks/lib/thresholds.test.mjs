import { describe, expect, it } from 'vitest';
import { checkThresholds } from './thresholds.mjs';

/** 一个全部达标的 summary，各条测试只改自己关心的那一项。 */
function passingSummary(overrides = {}) {
  return {
    recall: 0.9,
    falsePositives: 1,
    mustNotFindHit: 0,
    incompleteRatio: 0,
    instability: 0.1,
    p95LatencyMs: 30_000,
    costUsdPerPr: 0.003,
    missingUsage: 0,
    ...overrides,
  };
}

const T = {
  min_recall: 0.82,
  max_false_positives: 5,
  max_must_not_find_hits: 1,
  max_incomplete_ratio: 0.05,
  max_p95_latency_ms: 300_000,
  max_cost_usd_per_pr: 0.5,
  max_finding_set_instability: 0.35,
};

const opts = { repeat: 3 };

describe('checkThresholds', () => {
  it('全部达标时没有违规', () => {
    expect(checkThresholds(passingSummary(), T, opts)).toEqual([]);
  });

  it.each([
    ['召回率', { recall: 0.82 }],
    ['误报', { falsePositives: 5 }],
    ['陷阱命中', { mustNotFindHit: 1 }],
    ['incomplete 比例', { incompleteRatio: 0.05 }],
    ['抖动', { instability: 0.35 }],
    ['p95 延迟', { p95LatencyMs: 300_000 }],
    ['成本', { costUsdPerPr: 0.5 }],
  ])('%s 恰好等于门槛时不算违规（门槛是上/下限，不是开区间）', (_name, override) => {
    expect(checkThresholds(passingSummary(override), T, opts)).toEqual([]);
  });

  it('召回率低于门槛时报违规', () => {
    const v = checkThresholds(passingSummary({ recall: 0.819 }), T, opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('召回率');
  });

  it('误报超一条就报违规', () => {
    const v = checkThresholds(passingSummary({ falsePositives: 6 }), T, opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('误报 6 条');
  });
});

describe('陷阱命中的门槛可配置（issue #12 的已知缺口）', () => {
  it('命中数等于配置上限时不报红——否则 nightly 会恒红到 #12 修完', () => {
    // 一条永远红的门槛等于没有门槛：大家会开始习惯性忽略它，
    // 等真出第二个问题时也看不见。
    expect(checkThresholds(passingSummary({ mustNotFindHit: 1 }), T, opts)).toEqual([]);
  });

  it('第 2 条陷阱被踩立刻报红——这正是保留这条门槛的意义', () => {
    const v = checkThresholds(passingSummary({ mustNotFindHit: 2 }), T, opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('must_not_find');
    expect(v[0]).toContain('上限 1');
  });

  it('缺配置时回落到 0：默认不容忍任何陷阱命中', () => {
    // #12 修完后从 thresholds.json 里删掉该键，语义应当自动回到最严。
    const withoutKey = { ...T };
    delete withoutKey.max_must_not_find_hits;

    const v = checkThresholds(passingSummary({ mustNotFindHit: 1 }), withoutKey, opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('上限 0');
  });
});

describe('读不到 usage 时不让成本门槛静默常绿', () => {
  it('missingUsage > 0 单独构成一条违规', () => {
    const v = checkThresholds(passingSummary({ missingUsage: 3 }), T, opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('usage');
  });
});

describe('抖动至少要两轮才有定义', () => {
  it('--repeat=1 直接判违规，而不是当成「这条门槛通过了」', () => {
    const v = checkThresholds(passingSummary(), T, { repeat: 1 });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('--repeat>=2');
  });

  it('--repeat=1 时不再重复报抖动超标（那个数字此时没有意义）', () => {
    const v = checkThresholds(passingSummary({ instability: 0.99 }), T, { repeat: 1 });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('--repeat>=2');
  });
});

describe('多项同时超标时全部列出', () => {
  it('不在第一条违规处短路——一次跑完要能看到全部问题', () => {
    const v = checkThresholds(
      passingSummary({ recall: 0.5, falsePositives: 99, mustNotFindHit: 9, instability: 0.9 }),
      T,
      opts,
    );
    expect(v).toHaveLength(4);
  });
});
