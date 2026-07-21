import { describe, expect, it, vi } from 'vitest';
import { runAnalysis } from './analyze.js';
import { validate } from '../lib/schema-validator.js';
import type { PrepareArtifact } from './prepare.js';
import type { LoadedSkill } from '../lib/skill-loader.js';

const identityTuple = {
  head_repo: 'octo/head-repo',
  head_sha: 'headsha123',
  base_repo: 'octo/repo',
  base_ref: 'main',
  base_sha: 'basesha456',
  merge_base_sha: 'mergebasesha789',
};

function makeArtifact(overrides: Partial<PrepareArtifact> = {}): PrepareArtifact {
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
                newLines: 1,
                lines: [{ type: 'add', newLine: 1, content: 'const x = 1;' }],
              },
            ],
            contextRefs: [],
            contextContents: {},
          },
        ],
      },
    ],
    coverage_manifest: {
      files: [{ path: 'src/foo.ts', treatment: 'reviewed', shard_id: 'shard-1', status: 'success' }],
      shards_complete: true,
      hard_limit_hit: false,
      pulls_files_pagination_truncated: false,
      missing_patch_files: [],
      token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
    ...overrides,
  };
}

const SKILL_INDEX_MD = [
  '# Skill Index',
  '',
  '- generic-correctness: v1 | * | correctness checklist',
  '- generic-security: v1 | * | security checklist',
  '- generic-maintainability: v1 | * | maintainability checklist',
  '- swift-review: v3 | *.swift | swift checklist',
].join('\n');

function fakeLoadSkill(name: string): LoadedSkill {
  const bodies: Record<string, string> = {
    'generic-correctness': '## Checklist\n- correctness item',
    'generic-security': '## Checklist\n- security item',
    'generic-maintainability': '## Checklist\n- maintainability item',
    'swift-review': '## Checklist\n- swift item',
  };
  const categories: Record<string, string> = {
    'generic-correctness': 'correctness',
    'generic-security': 'security',
    'generic-maintainability': 'maintainability',
    'swift-review': 'correctness',
  };
  return {
    meta: { name, version: 1, triggers: ['*'], category: categories[name]! },
    body: bodies[name]!,
  };
}

function emptyExpertOutput(shardId: string, agent: string) {
  return { shard_id: shardId, agent, candidate_findings: [], coverage_complete: true };
}

const baseLimits = {
  maxCandidateFindingsPerAgentPerShard: 30,
  maxSkillRequestsPerRun: 3,
  maxVerifierCallsPerRun: 200,
  maxFinalFindingsPerRun: 200,
};

describe('runAnalysis', () => {
  it('runs the 3 generic agents per shard and returns an empty, complete result when nothing is found', async () => {
    const client = { sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string }) => {
      const agent = req.systemPrompt.includes('generic-correctness') ? 'generic-correctness'
        : req.systemPrompt.includes('generic-security') ? 'generic-security' : 'generic-maintainability';
      return Promise.resolve(emptyExpertOutput('shard-1', agent));
    }) };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(3);
    expect(result.findings).toEqual([]);
    expect(result.hardLimitHit).toBe(false);
    expect(result.anyRequiredStageFailed).toBe(false);
  });

  it('produces a schema-valid Finding after a candidate passes deterministic + verifier checks', async () => {
    const candidateFinding = {
      id: 'cf-1',
      path: 'src/foo.ts',
      line: 1,
      side: 'RIGHT',
      severity: 'high',
      confidence: 'high',
      category: 'correctness',
      title: 'issue',
      evidence: 'evidence',
      impact: 'impact',
      suggestion: 'suggestion',
      introduced_by_pr: true,
      source_agent: 'generic-correctness',
    };

    const client = {
      sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string; userPrompt: string }) => {
        if (req.systemPrompt.includes('independent verifier')) {
          return Promise.resolve({ status: 'confirmed' });
        }
        if (req.systemPrompt.includes('generic-correctness')) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'generic-correctness',
            candidate_findings: [candidateFinding],
            coverage_complete: true,
          });
        }
        const agent = req.systemPrompt.includes('generic-security') ? 'generic-security' : 'generic-maintainability';
        return Promise.resolve(emptyExpertOutput('shard-1', agent));
      }),
    };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.findings).toHaveLength(1);
    const validation = validate('https://pr-review-swarm/schemas/finding.schema.json', result.findings[0]);
    expect(validation.valid).toBe(true);
  });

  it('stops scheduling further work once an expert reports coverage_complete: false (hard limit)', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockResolvedValue({
        shard_id: 'shard-1',
        agent: 'generic-correctness',
        candidate_findings: [],
        coverage_complete: false,
      }),
    };

    const artifact = makeArtifact({
      shards: [
        { id: 'shard-1', files: [{ path: 'src/foo.ts', hunks: [], contextRefs: [], contextContents: {} }] },
        { id: 'shard-2', files: [{ path: 'src/bar.ts', hunks: [], contextRefs: [], contextContents: {} }] },
      ],
    });

    const result = await runAnalysis({
      prepareArtifact: artifact,
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.hardLimitHit).toBe(true);
    // only the first agent call for shard-1 should have happened before stopping
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });

  it('runs one supplementary round when an expert requests a valid skill', async () => {
    let call = 0;
    const client = {
      sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string }) => {
        call += 1;
        if (req.systemPrompt.includes('independent verifier')) {
          return Promise.resolve({ status: 'confirmed' });
        }
        if (call === 1) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'generic-correctness',
            candidate_findings: [],
            coverage_complete: true,
            skill_requests: ['swift-review'],
          });
        }
        if (req.systemPrompt.includes('swift item')) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'targeted-supplement',
            candidate_findings: [],
            coverage_complete: true,
          });
        }
        return Promise.resolve(emptyExpertOutput('shard-1', 'generic'));
      }),
    };

    await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    // 3 generic agents + 1 supplementary round = 4 expert calls (no findings, so no verifier calls)
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(4);
    const supplementCall = client.sendStructuredRequest.mock.calls.find(([req]) =>
      (req as { systemPrompt: string }).systemPrompt.includes('swift item'),
    );
    expect(supplementCall).toBeTruthy();
  });

  it('marks anyRequiredStageFailed when the verifier is unavailable for a candidate', async () => {
    const candidateFinding = {
      id: 'cf-1',
      path: 'src/foo.ts',
      line: 1,
      side: 'RIGHT',
      severity: 'high',
      confidence: 'high',
      category: 'correctness',
      title: 'issue',
      evidence: 'evidence',
      impact: 'impact',
      suggestion: 'suggestion',
      introduced_by_pr: true,
      source_agent: 'generic-correctness',
    };

    const client = {
      sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('independent verifier')) {
          return Promise.reject(new Error('timeout'));
        }
        if (req.systemPrompt.includes('generic-correctness')) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'generic-correctness',
            candidate_findings: [candidateFinding],
            coverage_complete: true,
          });
        }
        const agent = req.systemPrompt.includes('generic-security') ? 'generic-security' : 'generic-maintainability';
        return Promise.resolve(emptyExpertOutput('shard-1', agent));
      }),
    };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.anyRequiredStageFailed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('marks anyRequiredStageFailed instead of throwing when an expert call itself fails (e.g. DeepSeek outage)', async () => {
    const client = {
      sendStructuredRequest: vi.fn().mockRejectedValue(new Error('DeepSeek is down')),
    };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.anyRequiredStageFailed).toBe(true);
    expect(result.findings).toEqual([]);
    // should stop scheduling further expert calls once one has failed
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
  });

  it('marks anyRequiredStageFailed instead of throwing when loading an equipped skill fails', async () => {
    const brokenLoadSkill = (name: string): LoadedSkill => {
      if (name === 'generic-correctness') {
        throw new Error('malformed front matter in generic-correctness.md');
      }
      return fakeLoadSkill(name);
    };
    const client = { sendStructuredRequest: vi.fn() };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: brokenLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.anyRequiredStageFailed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(client.sendStructuredRequest).not.toHaveBeenCalled();
  });

  it('marks anyRequiredStageFailed instead of throwing when loading a requested supplementary skill fails', async () => {
    const brokenLoadSkill = (name: string): LoadedSkill => {
      if (name === 'swift-review') {
        throw new Error('malformed front matter in swift-review.md');
      }
      return fakeLoadSkill(name);
    };
    const client = {
      sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('generic-correctness')) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'generic-correctness',
            candidate_findings: [],
            coverage_complete: true,
            skill_requests: ['swift-review'],
          });
        }
        const agent = req.systemPrompt.includes('generic-security') ? 'generic-security' : 'generic-maintainability';
        return Promise.resolve(emptyExpertOutput('shard-1', agent));
      }),
    };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: brokenLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: baseLimits,
    });

    expect(result.anyRequiredStageFailed).toBe(true);
    expect(result.findings).toEqual([]);
    // only the 3 generic-agent calls should have happened; the supplementary
    // round must never reach client.sendStructuredRequest once skill loading fails
    expect(client.sendStructuredRequest).toHaveBeenCalledTimes(3);
  });

  it('records a diagnostic entry for a candidate dropped once maxVerifierCallsPerRun is exhausted', async () => {
    const candidateFinding = {
      id: 'cf-dropped',
      path: 'src/foo.ts',
      line: 1,
      side: 'RIGHT',
      severity: 'high',
      confidence: 'high',
      category: 'correctness',
      title: 'issue',
      evidence: 'evidence',
      impact: 'impact',
      suggestion: 'suggestion',
      introduced_by_pr: true,
      source_agent: 'generic-correctness',
    };

    const client = {
      sendStructuredRequest: vi.fn().mockImplementation((req: { systemPrompt: string }) => {
        if (req.systemPrompt.includes('generic-correctness')) {
          return Promise.resolve({
            shard_id: 'shard-1',
            agent: 'generic-correctness',
            candidate_findings: [candidateFinding],
            coverage_complete: true,
          });
        }
        const agent = req.systemPrompt.includes('generic-security') ? 'generic-security' : 'generic-maintainability';
        return Promise.resolve(emptyExpertOutput('shard-1', agent));
      }),
    };

    const result = await runAnalysis({
      prepareArtifact: makeArtifact(),
      skillIndexMd: SKILL_INDEX_MD,
      loadSkillFn: fakeLoadSkill,
      model: 'deepseek-test-model',
      client,
      limits: { ...baseLimits, maxVerifierCallsPerRun: 0 },
    });

    expect(result.hardLimitHit).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.internalDiagnostics).toContainEqual(
      expect.objectContaining({ id: 'cf-dropped', outcome: 'rejected_verifier' }),
    );
  });
});
