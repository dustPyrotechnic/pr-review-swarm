import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCase, toPrepareArtifact } from './lib/case-loader.mjs';
import {
  evaluateFindings,
  findingSetInstability,
  incompleteRunFor,
  isIncompleteRun,
} from './lib/metrics.mjs';
import { loadPipeline } from './lib/pipeline.mjs';
import { createMeteredFetch, percentile } from './lib/usage-meter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, 'cases');
const THRESHOLDS_PATH = join(__dirname, 'thresholds.json');
const PRICING_PATH = join(__dirname, 'pricing.json');

/**
 * 回归评测：拿真实 analyze 管线跑 benchmark 用例集，对账召回率、误报数、
 * incomplete 比例、延迟、成本与结果抖动。
 *
 * 用法：
 *   node run-evaluation.mjs                    跑一轮，只打印指标
 *   node run-evaluation.mjs --gate             任一门槛不达标就退出码 1
 *   node run-evaluation.mjs --repeat=5         每个用例连跑 5 次，度量抖动（Task 9.3）
 *   node run-evaluation.mjs --case=go-goroutine-leak   只跑一个用例
 *
 * 这个脚本会真的调用 DeepSeek，会花钱。没有 DEEPSEEK_API_KEY 时它直接失败，
 * **不会**退化成一个恒绿的空跑——一个不调用被测系统的"通过"比没有评测更糟，
 * 因为它会让人以为有护栏。
 */

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function parseArgs(argv) {
  const args = {
    gate: false,
    repeat: 1,
    only: undefined,
    model: 'deepseek-chat',
    // 只为把这个脚本自己跑通用：指向本地 mock 就能验证指标计算、门槛判定与
    // 计量层，不花钱、不依赖网络。生产/nightly 不传，走客户端的默认地址。
    baseUrl: undefined,
  };
  for (const arg of argv) {
    if (arg === '--gate') {
      args.gate = true;
    } else if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--repeat=')) {
      args.repeat = Number(arg.slice('--repeat='.length));
      if (!Number.isInteger(args.repeat) || args.repeat < 1) {
        throw new Error(`--repeat 必须是 >= 1 的整数，收到 "${arg}"`);
      }
    } else if (arg.startsWith('--case=')) {
      args.only = arg.slice('--case='.length);
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const thresholds = loadJson(THRESHOLDS_PATH);
  const pricing = loadJson(PRICING_PATH);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  // 空白也算缺失。workflow 里写的是 ${{ secrets.DEEPSEEK_API_KEY }}，仓库没配
  // 时展开成空串，而配错成一串空格时 `!apiKey` 是 false —— 那会带着一个无效
  // 凭据一路跑到 API 调用才失败，报出来的是「上游 401」，而不是「你没配 key」。
  if (!apiKey || apiKey.trim() === '') {
    console.error('✗ 没有 DEEPSEEK_API_KEY：评测要真的调用模型才有意义。');
    console.error('  设置后重跑：DEEPSEEK_API_KEY=sk-xxx node benchmarks/run-evaluation.mjs');
    process.exit(1);
  }

  const caseNames = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => args.only === undefined || name === args.only)
    .sort();

  if (caseNames.length === 0) {
    console.error(`✗ 没有可跑的用例（--case=${args.only ?? '<全部>'}）。`);
    process.exit(1);
  }

  const pipeline = await loadPipeline();
  const { fetchImpl, stats } = createMeteredFetch(fetch, pricing);
  const client = pipeline.createDeepSeekClient({
    apiKey,
    fetchImpl,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
  });
  const skillIndexMd = pipeline.readIndexMd();
  const limits = {
    maxCandidateFindingsPerAgentPerShard:
      pipeline.centralLimits.maxCandidateFindingsPerAgentPerShard,
    maxSkillRequestsPerRun: pipeline.centralLimits.maxSkillRequestsPerRun,
    maxVerifierCallsPerRun: pipeline.centralLimits.maxVerifierCallsPerRun,
    maxFinalFindingsPerRun: pipeline.centralLimits.maxFinalFindingsPerRun,
    maxExpertSchemaRetries: pipeline.centralLimits.maxExpertSchemaRetries,
  };

  console.log('=== PR Review Swarm Benchmark ===');
  console.log(`模型 ${args.model} · 用例 ${caseNames.length} 个 · 每例跑 ${args.repeat} 次\n`);

  const results = [];
  const runDurationsMs = [];
  for (const name of caseNames) {
    const loaded = loadCase(join(CASES_DIR, name));
    const artifact = toPrepareArtifact(loaded, {
      parsePatch: pipeline.parsePatch,
      shardFiles: pipeline.shardFiles,
      classifyFile: pipeline.classifyFile,
      limits: {
        maxFilesPerShard: pipeline.centralLimits.maxFilesPerShard,
        maxBytesPerShard: pipeline.centralLimits.maxBytesPerShard,
        maxShards: pipeline.centralLimits.maxShardsPerRun,
      },
    });

    const runs = [];
    for (let i = 0; i < args.repeat; i += 1) {
      // 端到端计时：一次 runAnalysis ≈ 一个 PR 的完整审核（所有 shard × 所有
      // agent + 全部 verifier 调用）。max_p95_latency_ms 门槛盯的是这个，
      // 而不是单次 HTTP 请求——后者永远在秒级，拿它去比 5 分钟的门槛，
      // 等于这条门槛根本没在生效。
      const startedAt = Date.now();
      let result;
      try {
        result = await pipeline.runAnalysis({
          prepareArtifact: artifact,
          skillIndexMd,
          model: args.model,
          client,
          limits,
        });
      } catch (err) {
        // 单轮抛异常不该让整轮评测无输出地崩掉。理由与结果形状见 metrics.mjs 的
        // incompleteRunFor。
        result = incompleteRunFor(artifact, err);
      }
      runDurationsMs.push(Date.now() - startedAt);
      runs.push(result);
    }

    results.push({
      name,
      expected: loaded.expected,
      runs,
      perRun: runs.map((r) =>
        evaluateFindings(r.findings, loaded.expected, {
          lineTolerance: thresholds.line_tolerance,
        }),
      ),
      instability: findingSetInstability(runs.map((r) => r.findings)),
    });

    printCase(results[results.length - 1]);
  }

  const summary = summarize(results, stats, runDurationsMs, thresholds);
  printSummary(summary, stats);

  if (!args.gate) {
    console.log('\n（非 --gate 模式：只打印指标，不作为门禁。）');
    return;
  }

  const violations = checkThresholds(summary, thresholds, args);
  if (violations.length > 0) {
    console.log('\n✗ 未达到回归评测门槛：');
    for (const v of violations) console.log(`    - ${v}`);
    process.exit(1);
  }
  console.log('\n✓ 全部门槛达标');
}

function printCase(r) {
  const recall = mean(r.perRun.map((p) => p.recall));
  const worstFp = Math.max(...r.perRun.map((p) => p.falsePositives));
  const worstTrap = Math.max(...r.perRun.map((p) => p.mustNotFindHit));

  console.log(`用例 ${r.name}`);
  console.log(
    `  召回 ${(recall * 100).toFixed(1)}%（${r.perRun[0].mustFindHit}/${r.perRun[0].mustFindTotal}）` +
      ` · 误报 ${worstFp}（最差一轮）· 陷阱命中 ${worstTrap}/${r.perRun[0].mustNotFindTotal}` +
      ` · 抖动 ${r.instability.toFixed(2)}`,
  );
  const incomplete = r.runs.filter(isIncompleteRun).length;
  if (incomplete > 0) {
    console.log(`  ⚠️  ${incomplete}/${r.runs.length} 轮判定为 incomplete`);
    for (const run of r.runs) {
      if (run.stageFailureReason) console.log(`      ${run.stageFailureReason}`);
    }
  }

  // 召回率为 0 时，「模型压根没报」和「模型报了但被某一层拒掉」是两个完全
  // 不同的问题——前者要调 prompt/skill，后者要查管线。internalDiagnostics
  // 正好记着每个候选的归宿，不打出来就只能靠猜。
  if (recall < 1) {
    const outcomes = new Map();
    for (const run of r.runs) {
      for (const d of run.internalDiagnostics ?? []) {
        outcomes.set(d.outcome, (outcomes.get(d.outcome) ?? 0) + 1);
      }
    }
    if (outcomes.size === 0) {
      console.log('  ↳ 模型没有产出任何候选 finding（不是被管线拒掉的）');
    } else {
      const summary = [...outcomes].map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  ↳ 候选归宿：${summary}`);
      for (const run of r.runs) {
        for (const d of run.internalDiagnostics ?? []) {
          if (d.outcome !== 'confirmed' && d.reason) {
            console.log(`      ${d.path}:${d.line} ${d.outcome} — ${d.reason}`);
          }
        }
      }
    }
  }
  console.log();
}

function summarize(results, stats, runDurationsMs, thresholds) {
  const allRuns = results.flatMap((r) => r.runs);

  return {
    // 召回率取所有轮次的均值：它衡量的是"典型能力"，个别轮次的随机波动
    // 不该单独定生死。
    recall: mean(results.flatMap((r) => r.perRun.map((p) => p.recall))),
    // 误报与陷阱命中取**最差一轮**，不取均值。误报是这个产品的头号杀手，
    // 用均值会让"每五轮爆一次"被稀释成看着还行的小数。
    falsePositives: Math.max(0, ...results.flatMap((r) => r.perRun.map((p) => p.falsePositives))),
    mustNotFindHit: Math.max(0, ...results.flatMap((r) => r.perRun.map((p) => p.mustNotFindHit))),
    incompleteRatio: allRuns.length > 0 ? allRuns.filter(isIncompleteRun).length / allRuns.length : 0,
    instability: mean(results.map((r) => r.instability)),
    p95LatencyMs: percentile(runDurationsMs, 95),
    // 诊断用：单次 HTTP 请求的 p95。它不参与门槛判定，但在端到端延迟劣化时
    // 能立刻区分「模型变慢了」和「我们多打了几轮请求」。
    p95RequestMs: percentile(stats.latenciesMs, 95),
    costUsdPerPr: results.length > 0 ? stats.costUsd / allRuns.length : 0,
    missingUsage: stats.missingUsage,
    unmatched: results.flatMap((r) =>
      r.perRun[0].unmatchedFindings.map((f) => `${r.name}: ${f.path}:${f.line} [${f.category}]`),
    ),
    thresholds,
  };
}

function printSummary(s, stats) {
  console.log('---');
  console.log(`召回率            ${(s.recall * 100).toFixed(1)}%`);
  console.log(`误报（最差一轮）  ${s.falsePositives}`);
  console.log(`陷阱命中          ${s.mustNotFindHit}`);
  console.log(`incomplete 比例   ${(s.incompleteRatio * 100).toFixed(1)}%`);
  console.log(`结果抖动          ${s.instability.toFixed(3)}`);
  console.log(`p95 端到端延迟    ${s.p95LatencyMs} ms（单次审核）`);
  console.log(`p95 单请求延迟    ${s.p95RequestMs} ms（诊断用，不作门槛）`);
  console.log(`成本/PR           $${s.costUsdPerPr.toFixed(4)}（${stats.requests} 次请求）`);
  if (s.unmatched.length > 0) {
    console.log('\n未对上任何 expected 的 finding（按首轮）：');
    for (const line of s.unmatched) console.log(`    ${line}`);
  }
}

function checkThresholds(s, thresholds, args) {
  const violations = [];

  if (s.recall < thresholds.min_recall) {
    violations.push(
      `召回率 ${(s.recall * 100).toFixed(1)}% 低于门槛 ${(thresholds.min_recall * 100).toFixed(1)}%`,
    );
  }
  if (s.falsePositives > thresholds.max_false_positives) {
    violations.push(`误报 ${s.falsePositives} 条超过上限 ${thresholds.max_false_positives}`);
  }
  if (s.mustNotFindHit > 0) {
    violations.push(`命中了 ${s.mustNotFindHit} 条 must_not_find（误报陷阱）`);
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

  if (args.repeat < 2) {
    // 抖动至少要两轮才有定义。--gate 下只跑一轮，就等于放弃了 Task 9.3 那条门槛。
    violations.push('--gate 需要 --repeat>=2 才能度量结果抖动（Task 9.3）');
  } else if (s.instability > thresholds.max_finding_set_instability) {
    violations.push(
      `结果抖动 ${s.instability.toFixed(3)} 超过上限 ${thresholds.max_finding_set_instability}`,
    );
  }

  return violations;
}

function mean(values) {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

main().catch((err) => {
  console.error(`✗ 评测执行失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
