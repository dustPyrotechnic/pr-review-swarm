import { describe, expect, it, vi } from 'vitest';
import { executePublish } from '../../src/entrypoints/publish.js';
import { encodeBatchMarker } from '../../src/lib/hidden-marker.js';
import { upsertSummaryComment } from '../../src/lib/summary-comment.js';
import type { Finding } from '../../src/lib/arbiter.js';
import type { CoverageManifest } from '../../src/entrypoints/prepare.js';

/**
 * 伪造隐藏 marker 攻击（对抗性测试加固计划 Task 5.1）。
 *
 * 攻击者在自己的 PR 上发一条评论/Review，正文里塞进
 * `<!-- pr-review-swarm:review_set_id=...;batch=0/1;digest=... -->`，
 * 诱导 publish 认为"这批已经发过了"从而跳过发布——即让机器人闭嘴。
 *
 * 设计文档「批量发布与 GitHub 对象」一节明确要求：对账时拉取全部 Review 后要
 * **筛选出发布身份自己提交的记录**，再解析隐藏注释。
 */
const BOT = { login: 'github-actions[bot]', type: 'Bot' as const };
const ATTACKER = { login: 'attacker', type: 'User' as const };

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

const reviewBatchLimits = { maxFindingsPerReviewBatch: 20, maxReviewBodyChars: 60000 };
const DEFAULT_PATCH = ['@@ -1,2 +1,3 @@', ' context line', '+added line', ' context line 2'].join(
  '\n',
);

function makeFinding(id: string): Finding {
  return {
    id,
    path: 'src/foo.ts',
    line: 2,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 't',
    evidence: 'e',
    impact: 'i',
    suggestion: 's',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    evidence_validation: { status: 'passed' },
    verifier_conclusion: { status: 'confirmed' },
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

interface ReviewStub {
  id: number;
  body: string | null;
  state?: string;
  user?: { login: string; type: string };
}

function makeMockOctokit(
  overrides: {
    listReviews?: ReviewStub[];
    listComments?: Array<{ id: number; body: string | null; user?: { login: string; type: string } }>;
  } = {},
) {
  const files = [{ filename: 'src/foo.ts', patch: DEFAULT_PATCH }];
  return {
    paginate: vi.fn(
      async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
        const { data } = await fn(params);
        return data;
      },
    ),
    rest: {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({ data: overrides.listReviews ?? [] }),
        listFiles: vi.fn().mockResolvedValue({ data: files }),
        createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
        updateReview: vi.fn().mockResolvedValue({ data: {} }),
        dismissReview: vi.fn().mockResolvedValue({ data: {} }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        updateReviewComment: vi.fn().mockResolvedValue({ data: {} }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: overrides.listComments ?? [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        updateComment: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

const findings = [makeFinding('cf-1')];

/**
 * 取机器人自己这一轮会写出的 Review 正文（含真实隐藏 marker）。
 *
 * 刻意不在测试里重新推导 review_set_id：publish 内部先把身份元组转成 snake_case
 * （toSchemaIdentityTuple）再参与哈希，测试里手算极易算出一个对不上的 id，让"伪造 marker"
 * 因为根本没匹配上而假绿。真跑一次再取回来，是唯一不会漂移的做法。
 */
async function botPublishedReviewBody(): Promise<string> {
  const octokit = makeMockOctokit();
  await publishWith(octokit);
  const call = octokit.rest.pulls.createReview.mock.calls[0]?.[0] as { body: string } | undefined;
  if (!call?.body) throw new Error('前置构造失败：机器人这一轮没有提交任何 Review');
  return call.body;
}

/** 从机器人自己的正文里抠出隐藏 marker 原文。 */
function extractMarker(body: string): string {
  const m = /<!-- pr-review-swarm:review_set_id=[^>]*-->/.exec(body);
  if (!m) throw new Error('前置构造失败：机器人的 Review 正文里没有隐藏 marker');
  return m[0];
}

async function publishWith(octokit: ReturnType<typeof makeMockOctokit>) {
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

describe('伪造 marker 不能让机器人跳过发布', () => {
  it('只采信发布身份自己提交的 Review 上的 marker', async () => {
    // 攻击者原样抄走了机器人这一轮的真实 marker（review_set_id 与 digest 都对）。
    const genuineMarker = extractMarker(await botPublishedReviewBody());
    const octokit = makeMockOctokit({
      listReviews: [
        { id: 7, body: `looks legit\n\n${genuineMarker}`, state: 'COMMENTED', user: ATTACKER },
      ],
    });

    const result = await publishWith(octokit);

    expect(octokit.rest.pulls.createReview, '本批次仍必须完整发布').toHaveBeenCalledTimes(1);
    expect(result.verdictSummary.verdict).toBe('changes_requested');
  });

  it('攻击者伪造的 digest 不匹配 marker 也不能把本次运行拖成 incomplete', async () => {
    // 这是更省事的攻击：只要 review_set_id 对上，用一个错的 digest 就能触发
    // "digest 不匹配 → incomplete 并停止发布"的保守分支，等于拒绝服务。
    const genuine = extractMarker(await botPublishedReviewBody());
    const tampered = genuine.replace(/digest=[^ ]+/, 'digest=deliberately-wrong-digest');
    expect(tampered, '前置构造失败：digest 没被改动').not.toBe(genuine);

    const octokit = makeMockOctokit({
      listReviews: [{ id: 7, body: tampered, state: 'COMMENTED', user: ATTACKER }],
    });

    const result = await publishWith(octokit);

    expect(result.verdictSummary.verdict).toBe('changes_requested');
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('机器人自己发布过的同批次（digest 一致）仍然正确跳过', async () => {
    // 前置健全性：上面两条不能靠"永远不跳过"来通过。先真发一次拿到机器人自己的
    // Review 正文（含真实 marker），再把它当作已存在的 Review 重放。
    const octokit = makeMockOctokit();
    const first = await publishWith(octokit);
    const body = octokit.rest.pulls.createReview.mock.calls[0]![0] as { body: string };

    const replay = makeMockOctokit({
      listReviews: [{ id: 7, body: body.body, state: 'CHANGES_REQUESTED', user: BOT }],
    });
    const second = await publishWith(replay);

    expect(first.verdictSummary.verdict).toBe('changes_requested');
    expect(second.verdictSummary.verdict).toBe('changes_requested');
    expect(replay.rest.pulls.createReview, '同一批次不应重复发布').not.toHaveBeenCalled();
  });

  it('不去 dismiss/编辑不属于自己的 Review（哪怕它带着旧 review_set_id 的 marker）', async () => {
    // 人类 reviewer 引用机器人的 Review 正文时会连隐藏注释一起复制过去，
    // 这会让机器人把人家的 CHANGES_REQUESTED 给 dismiss 掉。
    const foreignMarker = encodeBatchMarker({
      reviewSetId: 'some-older-review-set-id',
      batchIndex: 0,
      batchCount: 1,
      digest: 'd',
    });
    const octokit = makeMockOctokit({
      listReviews: [
        { id: 11, body: `我同意上面的意见\n\n${foreignMarker}`, state: 'CHANGES_REQUESTED', user: ATTACKER },
      ],
    });

    await publishWith(octokit);

    expect(octokit.rest.pulls.dismissReview).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReview).not.toHaveBeenCalled();
  });

  it('marker 被截断/字段缺失/digest 非法 → 视为无效 marker，不跳过发布', async () => {
    const broken = [
      '<!-- pr-review-swarm:review_set_id=;batch=0/1;digest=d -->',
      '<!-- pr-review-swarm:review_set_id=x;batch=0/1 -->',
      '<!-- pr-review-swarm:review_set_id=x;batch=notanumber/1;digest=d -->',
      '<!-- pr-review-swarm:review_set_id=x;batch=0/1;digest= -->',
    ];
    for (const body of broken) {
      const octokit = makeMockOctokit({
        listReviews: [{ id: 7, body, state: 'COMMENTED', user: BOT }],
      });
      await publishWith(octokit);
      expect(octokit.rest.pulls.createReview, `无效 marker「${body}」不应导致跳过`).toHaveBeenCalled();
    }
  });
});

describe('伪造摘要评论 marker 不能诱导机器人改写他人评论', () => {
  const summaryCtx = { owner: 'octo', repo: 'repo', prNumber: 42 };

  it('只更新发布身份自己的摘要评论，攻击者的同 marker 评论不被改写', async () => {
    const octokit = makeMockOctokit();
    // 攻击者复制了稳定身份 marker。
    const forged =
      '看起来像机器人发的\n<!-- pr-review-swarm:marker=summary;repo=octo/repo;pr=42 -->';
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 555, body: forged, user: ATTACKER }],
    });

    await upsertSummaryComment(octokit as never, summaryCtx, 'new body');

    expect(octokit.rest.issues.updateComment, '不应改写攻击者的评论').not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment, '应当另起一条自己的摘要评论').toHaveBeenCalledTimes(1);
  });

  it('自己发过的摘要评论仍然被原地更新（不会每轮新建）', async () => {
    const octokit = makeMockOctokit();
    const own = '上一轮摘要\n<!-- pr-review-swarm:marker=summary;repo=octo/repo;pr=42 -->';
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 556, body: own, user: BOT }],
    });

    await upsertSummaryComment(octokit as never, summaryCtx, 'new body');

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
