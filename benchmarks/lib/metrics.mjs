/**
 * 回归评测的指标计算。
 *
 * 单独成模块（而不是内联进 run-evaluation.mjs）是因为这里的每一条规则都直接决定
 * 门禁松紧：匹配放宽一点，召回率就虚高；误报计重一次，`max_false_positives`
 * 这个硬门槛就失去刻度。这些规则需要自己的测试。
 */

/**
 * finding 的身份键。刻意与 `action/src/lib/arbiter.ts` 的 `groupKey` 保持一致
 * （`path|line|category`）：arbiter 用它去重，`review_set_id` 的内容摘要建立在
 * 去重后的集合上。稳定性度量若用别的键，会出现"抖动 0 但 Review 仍在反复重发"
 * 这种自相矛盾的结论。
 */
export function findingKey(finding) {
  return `${finding.path}|${finding.line}|${finding.category}`;
}

/**
 * 把一次运行的 findings 与该用例的 expected-findings.json 对账。
 *
 * @param {Array<{path: string, line: number, category: string}>} findings
 * @param {Array<{path: string, line: number, category: string, must_find: boolean}>} expected
 * @param {{lineTolerance: number}} options
 */
export function evaluateFindings(findings, expected, options) {
  const lineTolerance = options.lineTolerance;
  if (!Number.isInteger(lineTolerance) || lineTolerance < 0) {
    throw new Error(`evaluateFindings: lineTolerance 必须是非负整数，收到 ${lineTolerance}`);
  }

  const mustFind = expected.filter((e) => e.must_find);
  const mustNotFind = expected.filter((e) => !e.must_find);

  // 一条 expected 只能被认领一次。否则模型把同一个问题在相邻行刷屏报 5 遍，
  // 会被记成"召回 100% 且零误报"——正好和用户的真实体验相反。
  const claimed = new Set();
  const unmatched = [];

  let mustFindHit = 0;
  let mustNotFindHit = 0;

  for (const f of findings) {
    const hitIndex = mustFind.findIndex(
      (exp, i) => !claimed.has(`+${i}`) && matches(f, exp, lineTolerance),
    );
    if (hitIndex !== -1) {
      claimed.add(`+${hitIndex}`);
      mustFindHit += 1;
      continue;
    }

    const trapIndex = mustNotFind.findIndex(
      (exp, i) => !claimed.has(`-${i}`) && matches(f, exp, lineTolerance),
    );
    if (trapIndex !== -1) {
      claimed.add(`-${trapIndex}`);
      // 归到误报陷阱，不再计进 falsePositives —— 一条 finding 只记一次，
      // 这样"超了多少条"在两个门槛上都还有刻度。
      mustNotFindHit += 1;
      continue;
    }

    unmatched.push(f);
  }

  return {
    recall: mustFind.length > 0 ? mustFindHit / mustFind.length : 1,
    falsePositives: unmatched.length,
    mustFindTotal: mustFind.length,
    mustFindHit,
    mustNotFindTotal: mustNotFind.length,
    mustNotFindHit,
    unmatchedFindings: unmatched,
  };
}

/**
 * 位置匹配。category 必须精确相等——同一处代码"报出来了但归错类"仍然是一条
 * 用户要读、要判断、要忽略的评论，按误报计。
 *
 * 行号允许 ±lineTolerance：模型指认同一个缺陷时，行号常落在函数签名行与问题行
 * 之间。精确到行会把"其实找到了"判成漏报 + 误报，双重惩罚，让召回率失真。
 * 容差是显式配置项（thresholds.json 的 `line_tolerance`），不是藏在代码里的魔数。
 */
function matches(finding, expectation, lineTolerance) {
  return (
    finding.path === expectation.path &&
    finding.category === expectation.category &&
    Math.abs(finding.line - expectation.line) <= lineTolerance
  );
}

/**
 * 一轮运行是否算 incomplete。判据与 analyze → verdict 的实际口径一致：任一必需
 * 阶段失败，或触到任一硬上限，都不允许被当作一次完整审核。
 *
 * 放在指标模块里而不是脚本里：这是「什么算一次完整审核」的口径定义，和召回率
 * 怎么算是同一层的东西，需要和其他指标规则一起被测试。
 */
export function isIncompleteRun(run) {
  return Boolean(run.anyRequiredStageFailed) || Boolean(run.coverageManifest?.hard_limit_hit);
}

/**
 * 把「runAnalysis 抛出异常」这件事表示成一轮 incomplete 的运行结果。
 *
 * runAnalysis 把绝大多数故障降级成 anyRequiredStageFailed，但不是全部（例如
 * verifier 抛出的非 VerifierUnavailableError 会原样上抛）。让异常冒到最外层会
 * 中断整轮评测：已经跑完的用例指标一并丢失，输出里只剩一句「评测执行失败」，
 * 无法分辨是脚本坏了还是被测系统在某个用例上炸了。
 *
 * 记成 incomplete 之后，incomplete_ratio 门槛照样会红——不是把问题藏起来，而是
 * 让它带着用例名、轮次和原因一起浮出来。
 */
export function incompleteRunFor(artifact, err) {
  return {
    findings: [],
    coverageManifest: artifact.coverage_manifest,
    hardLimitHit: false,
    anyRequiredStageFailed: true,
    internalDiagnostics: [],
    stageFailureReason: `runAnalysis 抛出异常：${err instanceof Error ? err.message : String(err)}`,
  };
}

/**
 * Task 9.3：同一用例连跑 N 次，finding 集合两两 Jaccard 距离的均值。
 *
 * 抖动大意味着 `review_set_id` 会频繁变化，PR 上就会反复 dismiss 旧 Review、
 * 重发新 Review——这是用户可感知的严重问题，比"少报一条"更招人烦。
 *
 * @param {Array<Array<{path: string, line: number, category: string}>>} runs
 * @returns {number} 0（完全稳定）到 1（每次结果都不相交）
 */
export function findingSetInstability(runs) {
  if (runs.length < 2) {
    // 单次运行没有可比对象。返回 0 而不是抛错，是为了让 `--repeat=1` 这种
    // 只想看召回率的快速跑法仍然可用（门槛侧另有守卫，见 run-evaluation.mjs）。
    return 0;
  }

  const sets = runs.map((run) => new Set(run.map(findingKey)));
  let total = 0;
  let pairs = 0;

  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      total += jaccardDistance(sets[i], sets[j]);
      pairs += 1;
    }
  }

  return total / pairs;
}

function jaccardDistance(a, b) {
  if (a.size === 0 && b.size === 0) {
    // 两次都没报任何东西 = 完全一致。按 |交|/|并| 算会得到 0/0。
    return 0;
  }
  let intersection = 0;
  for (const key of a) {
    if (b.has(key)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return 1 - intersection / union;
}
