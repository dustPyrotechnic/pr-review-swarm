import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, 'cases');
const THRESHOLDS_PATH = join(__dirname, 'thresholds.json');

/**
 * analyze 管线尚未接入本脚本（见 evaluateCase 里的 TODO）。
 *
 * 这是一个**显式**开关，而不是从"命中数为 0"反推出来的。原先的判定是
 * `totalMustFindHit === 0 → 视为桩模式并关闭召回率门槛`，那本身就是个缺陷：一次真实但
 * 召回率为 0 的运行（也就是最该报警的情形）会被当成桩而静默放行。
 *
 * 接上真实管线时，把它改成 true，并删掉 evaluateCase 里的 TODO。
 */
const ANALYZE_RUNNER_IMPLEMENTED = false;

/**
 * Phase 1 benchmark runner — compares analyze pipeline output against
 * expected-findings.json for each test case and computes recall, false
 * positives, and incomplete rate.
 *
 * In Phase 1 this is a stub that validates fixture schema and prints a
 * summary. Phase 2+ will actually run analyze against a live/expert mock.
 */

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function evaluateCase(caseName) {
  const caseDir = join(CASES_DIR, caseName);
  const expected = loadJson(join(caseDir, 'expected-findings.json'));

  const mustFind = expected.filter((e) => e.must_find);
  const mustNotFind = expected.filter((e) => !e.must_find);

  // PHASE 1 STUB: no analyze runner yet — placeholder metrics.
  // Phase 2+ replaces this with actual analyze() call.
  const findings = [];  // TODO: runAnalyze(diff, context) → Finding[]

  const matched = mustFind.filter((exp) =>
    findings.some((f) => f.path === exp.path && f.line === exp.line && f.category === exp.category),
  );

  const falsePositives = findings.filter(
    (f) => !expected.some((exp) => exp.path === f.path && exp.line === f.line),
  );

  const recall = mustFind.length > 0 ? matched.length / mustFind.length : 1;
  const fpCount = falsePositives.length;

  return {
    case: caseName,
    recall,
    falsePositives: fpCount,
    mustFindTotal: mustFind.length,
    mustFindHit: matched.length,
    mustNotFindTotal: mustNotFind.length,
    // If mustNotFind items were actually found, count them separately
    mustNotFindHit: mustNotFind.filter((exp) =>
      findings.some((f) => f.path === exp.path && f.line === exp.line),
    ).length,
  };
}

function main() {
  const cases = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log('=== PR Review Swarm Benchmark Results ===\n');

  const results = cases.map(evaluateCase);

  let totalMustFind = 0;
  let totalMustFindHit = 0;
  let totalFalsePositives = 0;
  let totalMustNotFindHit = 0;

  for (const r of results) {
    totalMustFind += r.mustFindTotal;
    totalMustFindHit += r.mustFindHit;
    totalFalsePositives += r.falsePositives;
    totalMustNotFindHit += r.mustNotFindHit;

    console.log(`Case: ${r.case}`);
    console.log(`  Recall:     ${(r.recall * 100).toFixed(1)}% (${r.mustFindHit}/${r.mustFindTotal})`);
    console.log(`  False Pos:  ${r.falsePositives}`);
    console.log(`  False Neg (must_not_find items found): ${r.mustNotFindHit}/${r.mustNotFindTotal}`);
    console.log();
  }

  const overallRecall = totalMustFind > 0 ? totalMustFindHit / totalMustFind : 1;

  console.log('---');
  console.log(`Overall recall:     ${(overallRecall * 100).toFixed(1)}%`);
  console.log(`Total false positives: ${totalFalsePositives}`);
  console.log(`Total false negatives (must_not_find): ${totalMustNotFindHit}`);

  const thresholds = loadJson(THRESHOLDS_PATH);
  const gateMode = process.argv.includes('--gate');

  if (!ANALYZE_RUNNER_IMPLEMENTED) {
    console.log('\n⚠️  analyze 管线尚未接入本脚本：findings 恒为 []，上面所有指标都没有意义。');
    console.log('    在 evaluateCase 的 TODO 落地之前，这里给出的任何"通过"都是空洞的。');
    if (gateMode) {
      console.log('\n✗ --gate 模式拒绝在桩实现上给出绿灯。');
      process.exit(1);
    }
    console.log('\n（非 --gate 模式：仅打印指标，不作为门禁。）');
    return;
  }

  const violations = [];
  if (overallRecall < thresholds.min_recall) {
    violations.push(
      `召回率 ${(overallRecall * 100).toFixed(1)}% 低于门槛 ${(thresholds.min_recall * 100).toFixed(1)}%`,
    );
  }
  // 误报数是这个产品的头号杀手，硬门槛。
  if (totalFalsePositives > thresholds.max_false_positives) {
    violations.push(
      `误报 ${totalFalsePositives} 条超过上限 ${thresholds.max_false_positives}`,
    );
  }
  if (totalMustNotFindHit > 0) {
    violations.push(`命中了 ${totalMustNotFindHit} 条 must_not_find（误报陷阱）`);
  }

  if (violations.length > 0) {
    console.log('\n✗ 未达到回归评测门槛：');
    for (const v of violations) console.log(`    - ${v}`);
    process.exit(1);
  }

  console.log('\n✓ Benchmark run complete');
}

main();
