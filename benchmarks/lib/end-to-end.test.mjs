import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCase, toPrepareArtifact } from './case-loader.mjs';
import { evaluateFindings, findingSetInstability } from './metrics.mjs';
import { loadPipeline } from './pipeline.mjs';

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases');

/**
 * 用 fake LLM 把整条评测链路走通：case 目录 → PrepareArtifact → 真实
 * `runAnalysis` → findings → 指标。
 *
 * 这里**不**验证模型有多准（那是 nightly 拿真 key 跑的事），验证的是接线：
 * artifact 结构能不能被生产管线消费、findings 能不能对上 expected。接线错了
 * 而没有这一层，表现出来只会是 nightly 里一个莫名其妙的 0 召回。
 */

async function buildArtifactFor(caseName) {
  const pipeline = await loadPipeline();
  const loaded = loadCase(join(CASES_DIR, caseName));
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
  return { pipeline, loaded, artifact };
}

/**
 * 一个只会照着剧本回话的 client。expert 请求返回给定的候选 finding，
 * verifier 请求一律 confirmed。
 */
function scriptedClient(candidatesByAgent) {
  return {
    async sendStructuredRequest(input) {
      if (input.systemPrompt.includes('independent verifier')) {
        return { status: 'confirmed', notes: 'ok' };
      }
      const agent = /"agent"\s*:\s*"([^"]+)"/.exec(input.userPrompt)?.[1];
      const shardId = /shard-\d+/.exec(input.userPrompt)?.[0] ?? 'shard-1';
      const forThisAgent = candidatesByAgent(input) ?? [];
      return {
        shard_id: shardId,
        agent: agent ?? 'generic-correctness',
        candidate_findings: forThisAgent,
        coverage_complete: true,
      };
    },
  };
}

function candidate(overrides) {
  return {
    id: 'c1',
    path: 'pkg/service/user.go',
    line: 19,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: '未检查错误返回',
    evidence: 'db.Exec 的返回值被丢弃',
    impact: '删除失败时调用方无从得知',
    suggestion: '检查并处理 error',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    ...overrides,
  };
}

const LIMITS = {
  maxCandidateFindingsPerAgentPerShard: 20,
  maxSkillRequestsPerRun: 3,
  maxVerifierCallsPerRun: 30,
  maxFinalFindingsPerRun: 30,
  maxExpertSchemaRetries: 1,
};

describe('评测链路端到端（fake LLM）', () => {
  it('每个已提交的用例都能构造出可被 runAnalysis 消费的 artifact', async () => {
    const names = readdirSync(CASES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const { pipeline, artifact } = await buildArtifactFor(name);
      const result = await pipeline.runAnalysis({
        prepareArtifact: artifact,
        skillIndexMd: pipeline.readIndexMd(),
        model: 'deepseek-chat',
        client: scriptedClient(() => []),
        limits: LIMITS,
      });

      // 没有候选就该是零 finding 的完整审核，而不是失败或 incomplete。
      expect(result.findings, `用例 ${name}`).toEqual([]);
      expect(result.anyRequiredStageFailed, `用例 ${name}`).toBe(false);
      expect(result.coverageManifest.hard_limit_hit, `用例 ${name}`).toBe(false);
    }
  }, 120_000);

  it('模型报出正确位置时，指标记为命中', async () => {
    const { pipeline, loaded, artifact } = await buildArtifactFor('go-missing-error-check');
    const expectation = loaded.expected[0];

    let emitted = false;
    const result = await pipeline.runAnalysis({
      prepareArtifact: artifact,
      skillIndexMd: pipeline.readIndexMd(),
      model: 'deepseek-chat',
      client: scriptedClient(() => {
        if (emitted) return [];
        emitted = true;
        return [candidate({ path: expectation.path, line: expectation.line })];
      }),
      limits: LIMITS,
    });

    // 走通了确定性证据校验 + verifier，才会出现在 findings 里。
    expect(result.findings).toHaveLength(1);

    const metrics = evaluateFindings(result.findings, loaded.expected, { lineTolerance: 2 });
    expect(metrics.recall).toBe(1);
    expect(metrics.falsePositives).toBe(0);
  }, 120_000);

  it('模型报在 diff 之外的行时被确定性校验挡掉，不进 findings', async () => {
    const { pipeline, artifact } = await buildArtifactFor('go-missing-error-check');

    let emitted = false;
    const result = await pipeline.runAnalysis({
      prepareArtifact: artifact,
      skillIndexMd: pipeline.readIndexMd(),
      model: 'deepseek-chat',
      client: scriptedClient(() => {
        if (emitted) return [];
        emitted = true;
        return [candidate({ line: 9999 })];
      }),
      limits: LIMITS,
    });

    // 这条链路本身就是安全护栏之一：评测用例若能靠伪造行号"命中"，
    // 召回率就不再代表任何东西。
    expect(result.findings).toEqual([]);
  }, 120_000);

  it('真阴性用例：模型不报东西时不产生误报', async () => {
    const { pipeline, loaded, artifact } = await buildArtifactFor(
      'historical-issue-not-introduced',
    );

    const result = await pipeline.runAnalysis({
      prepareArtifact: artifact,
      skillIndexMd: pipeline.readIndexMd(),
      model: 'deepseek-chat',
      client: scriptedClient(() => []),
      limits: LIMITS,
    });

    const metrics = evaluateFindings(result.findings, loaded.expected, { lineTolerance: 2 });
    expect(metrics.mustNotFindHit).toBe(0);
    expect(metrics.falsePositives).toBe(0);
    expect(metrics.recall).toBe(1);
  }, 120_000);

  it('连跑两次同一用例，确定性 client 下抖动为 0', async () => {
    const { pipeline, artifact } = await buildArtifactFor('go-missing-error-check');

    const runs = [];
    for (let i = 0; i < 2; i += 1) {
      let emitted = false;
      const result = await pipeline.runAnalysis({
        prepareArtifact: artifact,
        skillIndexMd: pipeline.readIndexMd(),
        model: 'deepseek-chat',
        client: scriptedClient(() => {
          if (emitted) return [];
          emitted = true;
          return [candidate()];
        }),
        limits: LIMITS,
      });
      runs.push(result.findings);
    }

    // 管线自身若引入了不确定性（比如 id 里掺了时间戳），这里就会红。
    expect(findingSetInstability(runs)).toBe(0);
  }, 120_000);
});
