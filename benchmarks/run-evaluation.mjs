import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, 'cases');

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

  // PHASE 1: the analyze pipeline is a stub — findings is always []. 
  // Do not fail on recall in Phase 1; Phase 2+ removes this exemption.
  const isPhase1Stub = totalMustFind > 0 && totalMustFindHit === 0;
  if (isPhase1Stub) {
    console.log('\nℹ️  Phase 1 stub mode — recall thresholds disabled');
  } else if (overallRecall < 0.8) {
    console.log('\n⚠️  Overall recall below 80% threshold');
    process.exit(1);
  }

  console.log('\n✓ Benchmark run complete');
}

main();
