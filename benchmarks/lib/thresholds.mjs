/**
 * 门槛判定。
 *
 * 抽成纯函数是为了能直接单测每条边界（等于门槛不该红、超一点就该红）。留在
 * run-evaluation.mjs 里只能靠端到端测试间接覆盖，而要在端到端里凑出「两条陷阱
 * 同时被踩」这种组合，得让 mock 同时命中两个用例各自的陷阱位置——测试会比被测
 * 逻辑还复杂。
 */
export function checkThresholds(summary, thresholds, options) {
  const violations = [];
  const s = summary;

  if (s.recall < thresholds.min_recall) {
    violations.push(
      `召回率 ${(s.recall * 100).toFixed(1)}% 低于门槛 ${(thresholds.min_recall * 100).toFixed(1)}%`,
    );
  }

  if (s.falsePositives > thresholds.max_false_positives) {
    violations.push(`误报 ${s.falsePositives} 条超过上限 ${thresholds.max_false_positives}`);
  }

  // 陷阱命中曾经是「>0 即红」。改成读配置，是因为已知有一条踩中（见 issue #12：
  // 模型不区分本次引入与历史遗留）。保持 0 会让 nightly 从上线第一天就恒红，
  // 而一条永远红的门槛等于没有门槛——大家会开始习惯性忽略它，等真出第二个问题时
  // 也看不见。配置成「容忍已知的那一条」，第 2 条被踩立刻报警。
  //
  // 这个值随 #12 修复必须改回 0。thresholds.json 的注释里写了这句话。
  const maxTrapHits = thresholds.max_must_not_find_hits ?? 0;
  if (s.mustNotFindHit > maxTrapHits) {
    violations.push(
      `命中了 ${s.mustNotFindHit} 条 must_not_find（误报陷阱），上限 ${maxTrapHits}`,
    );
  }

  if (s.incompleteRatio > thresholds.max_incomplete_ratio) {
    violations.push(
      `incomplete 比例 ${(s.incompleteRatio * 100).toFixed(1)}% 超过上限 ` +
        `${(thresholds.max_incomplete_ratio * 100).toFixed(1)}%`,
    );
  }

  if (s.p95LatencyMs > thresholds.max_p95_latency_ms) {
    violations.push(
      `p95 端到端延迟 ${s.p95LatencyMs}ms 超过上限 ${thresholds.max_p95_latency_ms}ms`,
    );
  }

  if (s.costUsdPerPr > thresholds.max_cost_usd_per_pr) {
    violations.push(
      `单 PR 成本 $${s.costUsdPerPr.toFixed(4)} 超过上限 $${thresholds.max_cost_usd_per_pr}`,
    );
  }

  // 成本/延迟门槛建立在响应里的 usage 字段上。字段拿不到就等于这两个门槛没在
  // 生效，必须说出来，而不是让它们静默常绿。
  if (s.missingUsage > 0) {
    violations.push(
      `有 ${s.missingUsage} 次响应读不到 usage 字段，成本门槛在这些请求上没有生效`,
    );
  }

  if (options.repeat < 2) {
    // 抖动至少要两轮才有定义。--gate 下只跑一轮，就等于放弃了这条门槛，
    // 而不是「这条门槛通过了」。
    violations.push('--gate 需要 --repeat>=2 才能度量结果抖动（Task 9.3）');
  } else if (s.instability > thresholds.max_finding_set_instability) {
    violations.push(
      `结果抖动 ${s.instability.toFixed(3)} 超过上限 ${thresholds.max_finding_set_instability}`,
    );
  }

  return violations;
}
