import { describe, expect, it, vi } from 'vitest';
import { executePublish } from '../../src/entrypoints/publish.js';
import { planReviewBatches } from '../../src/lib/publish-manifest.js';
import type { Finding } from '../../src/lib/arbiter.js';
import type { CoverageManifest } from '../../src/entrypoints/prepare.js';

/**
 * finding 守恒（对抗性测试加固计划 Task 5.2）。
 *
 * 设计文档：inline 定位失败时 finding 降级到 Review body，"不因单条 inline 定位失败而丢弃
 * 整个 finding"；分批发布时"索引完整"。这两条都是"静默漏审"的直接来源——一条经过完整
 * 验证的 finding 一旦在发布环节丢掉，外部完全观测不到。
 */
const identityTuple = {
  headRepo: 'octo/head-repo',
  headSha: 'headsha123',
  baseRepo: 'octo/repo',
  baseRef: 'main',
  baseSha: 'basesha456',
  mergeBaseSha: 'mergebasesha789',
};

const engineCtx = {
  engineRevision: 'engine-1',
  policyRevision: 'policy-1',
  model: 'deepseek-chat',
  schemaVersion: 'finding-v1',
};

const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };

/** src/foo.ts 的 diff：新侧 1-3 行可定位。 */
const LOCATABLE_PATCH = ['@@ -1,2 +1,3 @@', ' context line', '+added line', ' context line 2'].join(
  '\n',
);

function makeFinding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    path: 'src/foo.ts',
    line: 2,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: `title-${id}`,
    evidence: `evidence-${id}`,
    impact: `impact-${id}`,
    suggestion: `suggestion-${id}`,
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
    ...overrides,
  };
}

function makeCoverageManifest(): CoverageManifest {
  return {
    files: [{ path: 'src/foo.ts', treatment: 'reviewed', shard_id: 's1', status: 'success' }],
    shards_complete: true,
    hard_limit_hit: false,
    pulls_files_pagination_truncated: false,
    missing_patch_files: [],
    token_usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
}

function makeMockOctokit() {
  const createdReviews: Array<{ body: string; comments?: Array<{ path: string; line: number }> }> =
    [];
  const createdComments: string[] = [];
  return {
    createdReviews,
    createdComments,
    paginate: vi.fn(
      async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
        const { data } = await fn(params);
        return data;
      },
    ),
    rest: {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        listFiles: vi
          .fn()
          .mockResolvedValue({ data: [{ filename: 'src/foo.ts', patch: LOCATABLE_PATCH }] }),
        createReview: vi.fn(async (params: { body: string; comments?: Array<{ path: string; line: number }> }) => {
          createdReviews.push(params);
          return { data: { id: createdReviews.length } };
        }),
        updateReview: vi.fn().mockResolvedValue({ data: {} }),
        dismissReview: vi.fn().mockResolvedValue({ data: {} }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        updateReviewComment: vi.fn().mockResolvedValue({ data: {} }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn(async (params: { body: string }) => {
          createdComments.push(params.body);
          return { data: { id: 999 } };
        }),
        updateComment: vi.fn(async (params: { body: string }) => {
          createdComments.push(params.body);
          return { data: {} };
        }),
      },
    },
    _botUser: BOT_USER,
  };
}

async function publish(
  octokit: ReturnType<typeof makeMockOctokit>,
  findings: Finding[],
  reviewBatchLimits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 },
) {
  return executePublish({
    octokit: octokit as never,
    owner: 'octo',
    repo: 'repo',
    prNumber: 42,
    currentIdentityTuple: identityTuple,
    expectedIdentityTuple: identityTuple,
    findings,
    coverageManifest: makeCoverageManifest(),
    anyRequiredStageFailed: false,
    reviewBatchLimits,
    ...engineCtx,
  });
}

describe('finding 守恒：验证通过的 finding 一条都不能丢', () => {
  it('inline 定位失败的 finding 降级到 Review body，一条都不少', async () => {
    // 20 条 finding，其中 8 条指向已被重命名/删除的文件，inline 无法定位。
    const locatable = Array.from({ length: 12 }, (_, i) => makeFinding(`ok-${i}`));
    const unlocatable = Array.from({ length: 8 }, (_, i) =>
      makeFinding(`gone-${i}`, { path: 'src/deleted.ts' }),
    );
    const findings = [...locatable, ...unlocatable];

    const octokit = makeMockOctokit();
    const result = await publish(octokit, findings);

    const allBodies = octokit.createdReviews.map((r) => r.body).join('\n');
    const inlineCount = octokit.createdReviews.reduce(
      (sum, r) => sum + (r.comments?.length ?? 0),
      0,
    );

    // 定位成功的走 inline，定位失败的必须出现在 Review body 里。
    expect(inlineCount, 'inline 评论数应等于可定位的 finding 数').toBe(locatable.length);
    for (const finding of unlocatable) {
      expect(allBodies, `${finding.id} 定位失败后从 Review body 里消失了`).toContain(finding.id);
    }
    expect(result.verdictSummary.final_findings_count).toBe(findings.length);
  });

  it('每一条 finding 要么进 inline 评论、要么进 Review body，恰好一次', async () => {
    // 混合可定位与不可定位，比例约 2:1。id 补零到定宽：不然 title-f-1 是 title-f-10..19
    // 的前缀，按子串统计会把一条 finding 数成十条。
    const findings = Array.from({ length: 20 }, (_, i) =>
      makeFinding(`f-${String(i).padStart(3, '0')}`, i % 3 === 0 ? { path: 'src/deleted.ts' } : {}),
    );

    const octokit = makeMockOctokit();
    await publish(octokit, findings);

    // inline 评论正文由 buildInlineComments 拼成，含 finding.title（这里就是 title-f-N）。
    const inlineBodies = octokit.createdReviews.flatMap((r) =>
      (r.comments ?? []).map((c) => (c as unknown as { body: string }).body),
    );
    const reviewBodies = octokit.createdReviews.map((r) => r.body);

    for (const finding of findings) {
      const inInline = inlineBodies.filter((b) => b.includes(finding.title)).length;
      const inBody = reviewBodies.filter((b) => b.includes(finding.title)).length;
      expect(
        inInline + inBody,
        `${finding.id} 应恰好出现一次（inline=${inInline}, body=${inBody}）`,
      ).toBe(1);
    }

    // 前置健全性：两条通道都确实被用到了，否则这条断言退化成只测一条路径。
    expect(inlineBodies.length, '本用例应当产生 inline 评论').toBeGreaterThan(0);
    expect(
      reviewBodies.some((b) => b.includes('title-f-000')),
      '本用例应当产生降级到 body 的 finding',
    ).toBe(true);
  });

  it('分批发布时所有 finding 都出现在某个批次里，且批次之间无重复', async () => {
    const findings = Array.from({ length: 200 }, (_, i) => makeFinding(`f-${i}`));
    const batches = planReviewBatches(findings, {
      maxFindingsPerReviewBatch: 20,
      maxReviewBodyChars: 60000,
    });

    expect(batches.length).toBeGreaterThan(1);

    const seen = new Map<string, number>();
    for (const batch of batches) {
      for (const finding of batch.findings) {
        seen.set(finding.id, (seen.get(finding.id) ?? 0) + 1);
      }
    }

    // 并集 == 全集
    expect([...seen.keys()].sort()).toEqual(findings.map((f) => f.id).sort());
    // 交集为空：每条恰好出现一次
    const duplicated = [...seen.entries()].filter(([, count]) => count !== 1);
    expect(duplicated, `以下 finding 出现在多个批次里：${JSON.stringify(duplicated)}`).toEqual([]);
  });

  it('批次编号连续且 batchCount 一致（索引完整，便于按 batch_index 恢复）', () => {
    const findings = Array.from({ length: 200 }, (_, i) => makeFinding(`f-${i}`));
    const batches = planReviewBatches(findings, {
      maxFindingsPerReviewBatch: 20,
      maxReviewBodyChars: 60000,
    });

    expect(batches.map((b) => b.batchIndex)).toEqual(batches.map((_, i) => i));
    for (const batch of batches) {
      expect(batch.batchCount).toBe(batches.length);
    }
  });

  it('单条 finding 超大时也自成一批，不被丢弃', () => {
    const huge = makeFinding('huge', { evidence: 'x'.repeat(200_000) });
    const batches = planReviewBatches([makeFinding('small'), huge], {
      maxFindingsPerReviewBatch: 20,
      maxReviewBodyChars: 1000,
    });

    const allIds = batches.flatMap((b) => b.findings.map((f) => f.id));
    expect(allIds).toContain('huge');
    expect(allIds).toContain('small');
  });

  it('摘要评论的问题索引包含全部 finding id', async () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding(`f-${i}`));
    const octokit = makeMockOctokit();
    await publish(octokit, findings);

    expect(octokit.createdComments).toHaveLength(1);
    const summary = octokit.createdComments[0]!;
    for (const finding of findings) {
      expect(summary, `摘要评论的问题索引里缺少 ${finding.id}`).toContain(finding.id);
    }
  });

  it('verdict 里的 final_findings_count 与实际 finding 数一致', async () => {
    for (const count of [0, 1, 25, 200]) {
      const findings = Array.from({ length: count }, (_, i) => makeFinding(`f-${i}`));
      const octokit = makeMockOctokit();
      const result = await publish(octokit, findings);
      expect(result.verdictSummary.final_findings_count, `count=${count}`).toBe(count);
    }
  });
});
