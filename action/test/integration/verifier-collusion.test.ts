import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../../src/entrypoints/analyze.js';
import { arbitrate } from '../../src/lib/arbiter.js';
import type { PrepareArtifact } from '../../src/entrypoints/prepare.js';
import type { LoadedSkill } from '../../src/lib/skill-loader.js';
import type { CandidateFinding } from '../../src/lib/expert-runner.js';

/**
 * 防御纵深（docs/AGENTS.md 硬禁令 7）。
 *
 * 现有测试都假设 verifier 是诚实的。真实风险是专家与 verifier 用同一个模型、被同一次注入
 * 同时攻陷。这里的 fake verifier **无条件返回 confirmed**，用来证明确定性校验层能独立兜住。
 */
const identityTuple = {
  head_repo: 'octo/head-repo',
  head_sha: 'headsha123',
  base_repo: 'octo/repo',
  base_ref: 'main',
  base_sha: 'basesha456',
  merge_base_sha: 'mergebasesha789',
};

const HUNK = {
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 2,
  lines: [
    { type: 'add' as const, newLine: 10, content: 'const a = 1;' },
    { type: 'context' as const, newLine: 11, oldLine: 10, content: 'const b = 2;' },
  ],
};

function artifact(): PrepareArtifact {
  return {
    identity_tuple: identityTuple,
    shards: [
      {
        id: 'shard-1',
        files: [
          { path: 'src/foo.ts', hunks: [HUNK], contextRefs: [], contextContents: {} },
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

function baseCandidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'c1',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'security',
    title: 't',
    evidence: 'const a = 1;',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-security',
    ...overrides,
  } as CandidateFinding;
}

/**
 * 同时扮演被攻陷的专家和被攻陷的 verifier：
 * 专家吐出调用方指定的 candidate，verifier 一律 confirmed。
 */
function collusiveClient(candidates: CandidateFinding[]) {
  const verifierCalls: CandidateFinding[] = [];
  const client = {
    sendStructuredRequest: async (input: { jsonSchema: { $id?: string }; userPrompt: string }) => {
      const isVerifier = String(input.jsonSchema?.$id ?? '').includes('verifier-conclusion');
      if (isVerifier) {
        verifierCalls.push(baseCandidate());
        return { status: 'confirmed', notes: '成立' };
      }
      return {
        shard_id: 'shard-1',
        agent: 'generic-security',
        candidate_findings: candidates,
        coverage_complete: true,
      };
    },
  };
  return { client, verifierCalls };
}

const limits = {
  maxCandidateFindingsPerAgentPerShard: 30,
  maxSkillRequestsPerRun: 5,
  maxVerifierCallsPerRun: 50,
  maxFinalFindingsPerRun: 50,
  maxExpertSchemaRetries: 0,
};

async function analyzeWith(candidates: CandidateFinding[]) {
  const { client, verifierCalls } = collusiveClient(candidates);
  const result = await runAnalysis({
    prepareArtifact: artifact(),
    skillIndexMd: SKILL_INDEX_MD,
    loadSkillFn: fakeLoadSkill,
    model: 'deepseek-chat',
    client: client as never,
    limits,
  });
  return { result, verifierCalls };
}

describe('防御纵深：verifier 被攻陷时确定性校验仍然拦截', () => {
  it('前置健全性检查：证据落在 hunk 内的 candidate 在同一 fake 下确实能成为 finding', async () => {
    // 没有这条，下面每一条"被拦下"都可能只是因为整个管线根本没产出 finding。
    const { result } = await analyzeWith([baseCandidate()]);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('verifier 无条件返回「成立」，行号落在 diff hunk 之外的 candidate 仍不能成为 finding', async () => {
    const { result } = await analyzeWith([baseCandidate({ id: 'out-of-hunk', line: 9999 })]);
    expect(result.findings.map((f) => f.id)).not.toContain('out-of-hunk');
  });

  it('行号刚好越过 hunk 边界 ±1 也被拒绝', async () => {
    for (const line of [HUNK.newStart - 1, HUNK.newStart + HUNK.newLines]) {
      const { result } = await analyzeWith([baseCandidate({ id: `edge-${line}`, line })]);
      expect(result.findings.map((f) => f.id), `line=${line} 不该通过`).not.toContain(
        `edge-${line}`,
      );
    }
  });

  it('side: LEFT（删除侧）的 candidate 被拒绝', async () => {
    const { result } = await analyzeWith([baseCandidate({ id: 'left-side', side: 'LEFT' })]);
    expect(result.findings.map((f) => f.id)).not.toContain('left-side');
  });

  it.each([
    '../../etc/passwd',
    '/etc/passwd',
    'src/../../../secrets.env',
    'other/file.ts',
  ])('path 越界或与 hunk 不匹配（%s）的 candidate 被拒绝', async (path) => {
    const { result } = await analyzeWith([baseCandidate({ id: 'bad-path', path })]);
    expect(result.findings.map((f) => f.id)).not.toContain('bad-path');
  });

  it('确定性校验失败时 verifier 根本不会被调用（拦截发生在更早的一层）', async () => {
    const { verifierCalls } = await analyzeWith([baseCandidate({ id: 'x', line: 9999 })]);
    expect(verifierCalls).toHaveLength(0);
  });

  it('主审不能新增未经验证流程的 finding（硬禁令 7）', () => {
    // arbitrate 的输出严格来自它收到的 VerifiedCandidate 列表，没有凭空生成的通道。
    expect(arbitrate([]).findings).toEqual([]);

    const failed = arbitrate([
      {
        finding: baseCandidate({ id: 'never-verified' }),
        deterministicStatus: 'failed',
        deterministicReason: 'out of hunk',
      },
    ]);
    expect(failed.findings).toEqual([]);

    const rejected = arbitrate([
      {
        finding: baseCandidate({ id: 'verifier-rejected' }),
        deterministicStatus: 'passed',
        verifierConclusion: { status: 'rejected', notes: 'no' },
      },
    ]);
    expect(rejected.findings).toEqual([]);
  });

  it('每条最终 finding 都同时带有确定性 passed 与 verifier confirmed 的记录', async () => {
    const { result } = await analyzeWith([baseCandidate()]);
    for (const finding of result.findings) {
      expect(finding.evidence_validation.status).toBe('passed');
      expect(finding.verifier_conclusion.status).toBe('confirmed');
    }
  });
});
