import { describe, expect, it } from 'vitest';
import {
  evaluateFindings,
  findingKey,
  findingSetInstability,
  incompleteRunFor,
  isIncompleteRun,
} from './metrics.mjs';

function finding(path, line, category = 'correctness') {
  return { path, line, category, id: `${path}:${line}`, title: 't' };
}

describe('evaluateFindings — 召回与误报', () => {
  it('命中 must_find 计入召回', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('a.go', 10)], expected, { lineTolerance: 0 });

    expect(r.mustFindTotal).toBe(1);
    expect(r.mustFindHit).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it('漏掉 must_find 时召回率下降，且不产生误报', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([], expected, { lineTolerance: 0 });

    expect(r.recall).toBe(0);
    expect(r.falsePositives).toBe(0);
  });

  it('category 不参与匹配：位置对上就算命中', () => {
    // 这条断言此前是反的（要求 category 精确相等），那是凭空发明的约束：
    // `candidate-finding.schema.json` 里 category 是 `{type:string, minLength:1}`，
    // 自由文本；设计文档 L139 明确写「severity、confidence、category 仅用于排序、
    // 呈现和统计，不决定是否阻塞」。
    //
    // 代价在首轮真实评测里现形：go-missing-error-check 用例模型连续两轮报出
    // `pkg/service/user.go:19`——正是 expected 的那一行——但 category 返回
    // `error-handling`，于是被同时记成一次漏报和一次误报。模型答对了，评测判错了。
    const expected = [{ path: 'a.go', line: 10, category: 'security', must_find: true }];
    const r = evaluateFindings([finding('a.go', 10, 'error-handling')], expected, {
      lineTolerance: 0,
    });

    expect(r.mustFindHit).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it('模型返回整句话作为 category 时同样能匹配', () => {
    // 实测返回过 `Race condition on delegate access`、
    // `Eval injection / arbitrary code execution` 这类自由文本。
    const expected = [{ path: 'a.swift', line: 33, category: 'correctness', must_find: true }];
    const r = evaluateFindings(
      [finding('a.swift', 33, 'Race condition on delegate access')],
      expected,
      { lineTolerance: 0 },
    );

    expect(r.mustFindHit).toBe(1);
  });

  it('陷阱同样只看位置：category 对不上不能让陷阱命中被漏记', () => {
    // 这是更严重的一侧。historical-issue-not-introduced 用例里模型确实踩了陷阱
    // （报出 helpers.ts:8 那处历史遗留的 eval），但 category 返回
    // `Eval injection / arbitrary code execution`，于是被记成普通误报而不是陷阱
    // 命中——`max_false_positives` 之外那条「命中 must_not_find 即报红」的门槛
    // 因此永远不可能触发。
    const expected = [{ path: 'a.ts', line: 8, category: 'security', must_find: false }];
    const r = evaluateFindings(
      [finding('a.ts', 8, 'Eval injection / arbitrary code execution')],
      expected,
      { lineTolerance: 0 },
    );

    expect(r.mustNotFindHit).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it('命中 must_not_find 单独计数，不重复计进 falsePositives', () => {
    const expected = [{ path: 'a.ts', line: 10, category: 'security', must_find: false }];
    const r = evaluateFindings([finding('a.ts', 10, 'security')], expected, { lineTolerance: 0 });

    expect(r.mustNotFindHit).toBe(1);
    // 同一条 finding 只应被记一次，否则一条误报会同时打爆两个门槛，
    // 让"超了多少"失去意义。
    expect(r.falsePositives).toBe(0);
  });

  it('完全无关的位置算误报', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('a.go', 10), finding('b.go', 99)], expected, {
      lineTolerance: 0,
    });

    expect(r.mustFindHit).toBe(1);
    expect(r.falsePositives).toBe(1);
  });

  it('没有 must_find 项时召回率定义为 1（纯真阴性用例）', () => {
    const expected = [{ path: 'a.ts', line: 10, category: 'security', must_find: false }];
    const r = evaluateFindings([], expected, { lineTolerance: 0 });

    expect(r.mustFindTotal).toBe(0);
    expect(r.recall).toBe(1);
  });
});

describe('evaluateFindings — 行号容差', () => {
  it('容差内的行号偏移算命中', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('a.go', 12)], expected, { lineTolerance: 2 });

    expect(r.mustFindHit).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it('超出容差算误报而非命中', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('a.go', 20)], expected, { lineTolerance: 2 });

    expect(r.mustFindHit).toBe(0);
    expect(r.falsePositives).toBe(1);
  });

  it('容差不跨文件生效', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('b.go', 10)], expected, { lineTolerance: 5 });

    expect(r.mustFindHit).toBe(0);
    expect(r.falsePositives).toBe(1);
  });

  it('一条 expected 不会被两条 finding 重复认领', () => {
    const expected = [{ path: 'a.go', line: 10, category: 'correctness', must_find: true }];
    const r = evaluateFindings([finding('a.go', 9), finding('a.go', 11)], expected, {
      lineTolerance: 2,
    });

    // 否则"同一个问题刷屏报 5 遍"会被记成召回 100% 且零误报。
    expect(r.mustFindHit).toBe(1);
    expect(r.falsePositives).toBe(1);
  });
});

describe('findingSetInstability — Task 9.3 抖动度量', () => {
  it('单次运行没有可比对象，抖动为 0', () => {
    expect(findingSetInstability([[finding('a.go', 1)]])).toBe(0);
  });

  it('多次运行结果完全一致时抖动为 0', () => {
    const run = [finding('a.go', 1), finding('b.go', 2)];
    expect(findingSetInstability([run, [...run], [...run]])).toBe(0);
  });

  it('顺序不同但集合相同，抖动仍为 0', () => {
    const a = [finding('a.go', 1), finding('b.go', 2)];
    const b = [finding('b.go', 2), finding('a.go', 1)];
    expect(findingSetInstability([a, b])).toBe(0);
  });

  it('完全不相交时抖动为 1', () => {
    expect(findingSetInstability([[finding('a.go', 1)], [finding('b.go', 2)]])).toBe(1);
  });

  it('两次运行交 1 并 2 时 Jaccard 距离为 0.5', () => {
    const a = [finding('a.go', 1), finding('b.go', 2)];
    const b = [finding('a.go', 1)];
    expect(findingSetInstability([a, b])).toBeCloseTo(0.5, 10);
  });

  it('取所有配对的均值，而不是只比相邻两次', () => {
    // 三次运行：AB / A / B。配对距离 0.5、0.5、1 → 均值 2/3。
    // 只比相邻会得到 0.5，把最不稳的一对藏起来。
    const runs = [
      [finding('a.go', 1), finding('b.go', 2)],
      [finding('a.go', 1)],
      [finding('b.go', 2)],
    ];
    expect(findingSetInstability(runs)).toBeCloseTo(2 / 3, 10);
  });

  it('两次都为空集时视为稳定（0），而不是 NaN', () => {
    expect(findingSetInstability([[], []])).toBe(0);
  });

  it('空集与非空集之间抖动为 1', () => {
    expect(findingSetInstability([[], [finding('a.go', 1)]])).toBe(1);
  });

  it('同一 run 内的重复 finding 不影响集合语义', () => {
    const a = [finding('a.go', 1), finding('a.go', 1)];
    const b = [finding('a.go', 1)];
    expect(findingSetInstability([a, b])).toBe(0);
  });
});

describe('isIncompleteRun', () => {
  const clean = { anyRequiredStageFailed: false, coverageManifest: { hard_limit_hit: false } };

  it('干净的一轮不算 incomplete', () => {
    expect(isIncompleteRun(clean)).toBe(false);
  });

  it('必需阶段失败算 incomplete', () => {
    expect(isIncompleteRun({ ...clean, anyRequiredStageFailed: true })).toBe(true);
  });

  it('触到硬上限算 incomplete', () => {
    expect(isIncompleteRun({ ...clean, coverageManifest: { hard_limit_hit: true } })).toBe(true);
  });

  it('缺 coverageManifest 时不炸，按未触上限处理', () => {
    expect(isIncompleteRun({ anyRequiredStageFailed: false })).toBe(false);
  });
});

describe('incompleteRunFor', () => {
  const artifact = { coverage_manifest: { files: [], hard_limit_hit: false } };

  it('产出的结果会被 isIncompleteRun 识别为 incomplete', () => {
    const run = incompleteRunFor(artifact, new Error('boom'));

    // 若形状不对（比如漏了 anyRequiredStageFailed），一次抛异常的运行会被
    // 当成「干净的零 finding 审核」——那正好是最危险的静默通过。
    expect(isIncompleteRun(run)).toBe(true);
    expect(run.findings).toEqual([]);
  });

  it('保留原始错误信息，便于定位是哪一层炸的', () => {
    const run = incompleteRunFor(artifact, new Error('verifier exploded'));
    expect(run.stageFailureReason).toContain('verifier exploded');
  });

  it('非 Error 抛出物也能转成可读原因', () => {
    const run = incompleteRunFor(artifact, 'plain string throw');
    expect(run.stageFailureReason).toContain('plain string throw');
  });

  it('带出原 artifact 的 coverage_manifest，覆盖清单不丢', () => {
    const run = incompleteRunFor(artifact, new Error('x'));
    expect(run.coverageManifest).toBe(artifact.coverage_manifest);
  });
});

describe('findingKey', () => {
  it('身份是 path|line', () => {
    expect(findingKey(finding('a.go', 7, 'security'))).toBe('a.go|7');
  });

  it('不受 title/id 等自由文本影响', () => {
    const a = { path: 'a.go', line: 7, category: 'security', id: 'x', title: '措辞一' };
    const b = { path: 'a.go', line: 7, category: 'security', id: 'y', title: '措辞二' };
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it('也不受 category 措辞影响', () => {
    // category 是自由文本，同一处问题模型每轮措辞可能不同（实测 error-handling /
    // naming-clarity / duplication）。把它算进身份，抖动会恒定贴近 1.0，这条门槛
    // 就永远红、也就永远不再提供信息。
    const a = { path: 'a.go', line: 7, category: 'error-handling' };
    const b = { path: 'a.go', line: 7, category: 'correctness' };
    expect(findingKey(a)).toBe(findingKey(b));
  });
});
