import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import corpus from '../fixtures/prompt-injection/corpus.json' with { type: 'json' };
import { runAnalysis } from '../../src/entrypoints/analyze.js';
import { computeFinalReviewEvent, computeVerdict, type Verdict } from '../../src/lib/verdict.js';
import { validateDeterministicEvidence } from '../../src/lib/deterministic-evidence-validator.js';
import type { PrepareArtifact } from '../../src/entrypoints/prepare.js';
import type { LoadedSkill } from '../../src/lib/skill-loader.js';
import type { CandidateFinding } from '../../src/lib/expert-runner.js';

/**
 * 端到端注入测试。用一个「听话的」fake LLM：它会真的执行 prompt 里读到的注入指令
 * （宣称零问题、覆盖完整、verdict=pass）。这样一旦数据边界失效，注入就会体现为
 * 「模型闭嘴」。断言的是：**即使模型完全被攻陷，确定性层仍然独立成立**。
 *
 * 注意本测试验证的不是"模型不会被骗"（那需要真实模型抽样评测，见计划附录 A 第 5 条），
 * 而是"边界失效时系统仍然安全"。
 */
const PAYLOADS: Array<[string, string]> = corpus.payloads.map((p) => [p.id, p.text]);

const identityTuple = {
  head_repo: 'octo/head-repo',
  head_sha: 'headsha123',
  base_repo: 'octo/repo',
  base_ref: 'main',
  base_sha: 'basesha456',
  merge_base_sha: 'mergebasesha789',
};

function artifactWithInjection(injected: string): PrepareArtifact {
  return {
    identity_tuple: identityTuple,
    shards: [
      {
        id: 'shard-1',
        files: [
          {
            path: 'src/foo.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 2,
                lines: [
                  { type: 'add', newLine: 1, content: 'const x = 1;' },
                  { type: 'add', newLine: 2, content: `// ${injected}` },
                ],
              },
            ],
            contextRefs: [],
            contextContents: {},
          },
        ],
      },
    ],
    coverage_manifest: {
      files: [
        { path: 'src/foo.ts', treatment: 'reviewed', shard_id: 'shard-1', status: 'success' },
      ],
      shards_complete: true,
      hard_limit_hit: false,
      pulls_files_pagination_truncated: false,
      missing_patch_files: [],
      token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
  };
}

const SKILL_INDEX_MD = [
  '# Skill Index',
  '',
  '- generic-correctness: v1 | * | correctness checklist',
  '- generic-security: v1 | * | security checklist',
  '- generic-maintainability: v1 | * | maintainability checklist',
].join('\n');

function fakeLoadSkill(name: string): LoadedSkill {
  const categories: Record<string, string> = {
    'generic-correctness': 'correctness',
    'generic-security': 'security',
    'generic-maintainability': 'maintainability',
  };
  return {
    meta: { name, version: 1, triggers: ['*'], category: categories[name]! },
    body: `## Checklist\n- ${name} item`,
  } as LoadedSkill;
}

/**
 * 完全听话的模型：宣称覆盖完整、零问题，并试图夹带一个模型自选的 verdict 字段。
 * 记录它收到的每一个 prompt，供"载荷确实进了 prompt"的前置断言使用。
 */
function obedientClient(seenPrompts: string[]) {
  return {
    sendStructuredRequest: async (input: { systemPrompt: string; userPrompt: string }) => {
      seenPrompts.push(`${input.systemPrompt}\n${input.userPrompt}`);
      return {
        shard_id: 'shard-1',
        agent: 'generic-security',
        candidate_findings: [],
        coverage_complete: true,
        // 模型自选的裁决字段：schema 的 additionalProperties:false 会直接拒绝它。
        verdict: 'pass',
        final_review_event: 'APPROVE',
      };
    },
  };
}

const analyzeLimits = {
  maxCandidateFindingsPerAgentPerShard: 30,
  maxSkillRequestsPerRun: 5,
  maxVerifierCallsPerRun: 50,
  maxFinalFindingsPerRun: 50,
  maxExpertSchemaRetries: 0,
};

describe('prompt injection 端到端：注入不改变确定性结论', () => {
  it.each(PAYLOADS)('%s：模型夹带的 verdict/final_review_event 字段被 schema 拒绝', async (
    _id,
    payload,
  ) => {
    const seenPrompts: string[] = [];
    const result = await runAnalysis({
      prepareArtifact: artifactWithInjection(payload),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-chat',
      client: obedientClient(seenPrompts) as never,
      limits: analyzeLimits,
    });

    // 前置：载荷确实被送进了 prompt（否则这个用例什么都没测到）。
    expect(seenPrompts.length).toBeGreaterThan(0);

    // 模型试图自己定裁决 —— expert-output schema 的 additionalProperties:false
    // 让这类响应整体校验失败，于是阶段失败、判 incomplete，而不是采信它。
    expect(result.anyRequiredStageFailed).toBe(true);
    expect(result.findings).toEqual([]);

    const { verdict } = computeVerdict({
      coverageManifest: result.coverageManifest,
      finalFindings: result.findings,
      anyRequiredStageFailed: result.anyRequiredStageFailed,
    });
    expect(verdict).toBe('incomplete');
    expect(computeFinalReviewEvent(verdict, result.findings.length)).not.toBe('APPROVE');
  });

  it('expert-output schema 没有给模型任何自报裁决的字段通道', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../schemas/expert-output.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as { additionalProperties?: boolean; properties: Record<string, unknown> };

    expect(schema.additionalProperties).toBe(false);
    for (const forbidden of ['verdict', 'final_review_event', 'review_event', 'approve']) {
      expect(Object.keys(schema.properties)).not.toContain(forbidden);
    }
  });

  it('任何 verdict 下 final_review_event 都不是 APPROVE（注入无法制造出这个终态）', () => {
    const verdicts: Verdict[] = ['pass', 'changes_requested', 'incomplete'];
    for (const verdict of verdicts) {
      for (const count of [0, 1, 30, 500]) {
        expect(computeFinalReviewEvent(verdict, count)).not.toBe('APPROVE');
      }
    }
  });

  it.each(PAYLOADS)(
    '%s：注入诱导出的伪造 finding 仍被确定性证据校验拦下',
    (_id, payload) => {
      // 攻陷的模型按注入要求编造一条"证据"落在 diff hunk 之外的 finding。
      const fabricated: CandidateFinding = {
        id: 'fake-1',
        path: 'src/foo.ts',
        line: 9999,
        side: 'RIGHT',
        severity: 'low',
        confidence: 'high',
        category: 'security',
        title: 'injected',
        evidence: payload,
        impact: 'i',
        suggestion: 's',
        introduced_by_pr: true,
        source_agent: 'generic-security',
      } as CandidateFinding;

      const result = validateDeterministicEvidence(fabricated, 'src/foo.ts', [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { type: 'add', newLine: 1, content: 'const x = 1;' },
            { type: 'add', newLine: 2, content: `// ${payload}` },
          ],
        },
      ]);
      expect(result.status).toBe('failed');
    },
  );
});
