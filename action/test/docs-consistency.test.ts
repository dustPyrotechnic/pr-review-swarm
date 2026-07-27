import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 规格文档一致性锁。
 *
 * 背景：`README.md` 与 `action/test/integration/CHECKLIST.md` 已明确"机器人永不提交
 * APPROVE"，但设计文档一度仍在多处描述"零 finding 时提交 APPROVE"。同一份规格给出两个
 * 互斥的期望结果时，裁决规则的测试无法给出唯一断言。这个测试把该规格锁进 CI。
 */
const DOCS = [
  'README.md',
  'docs/plans/2026-07-13-pr-review-swarm-design.md',
  'action/test/integration/CHECKLIST.md',
];

/**
 * 允许出现 APPROVE 的语境：
 * - 否定式表述（永不/绝不/不再/不会/不得/不提交/不产生 APPROVE）；
 * - watchdog 回填：识别历史或人工产生的 APPROVED Review，用于把孤儿 Check 回填为 success。
 *   这是全系统唯一保留 APPROVE 语义的地方，它读的是别人的 Review，不是机器人自己提交。
 *
 * 否定词表刻意保持精确：不要加入"没有"这类泛化的否定，它会因为行内别处出现一句无关的
 * "没有提交 Review"而把真正矛盾的表述放行（这个洞在本测试首次落地时确实存在过）。
 */
const NEGATION = /永不|绝不|不再|不会|不得|不提交|不产生|不产出|不给|不是|已移除|历史|回填|人工产生|never/;

describe('规格文档一致性', () => {
  it('没有任何文档还在声称机器人会提交 APPROVE', () => {
    const offenders: string[] = [];
    for (const rel of DOCS) {
      const text = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('APPROVE') && !NEGATION.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `以下行仍在描述机器人提交 APPROVE：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('设计文档顶部带有「不再提交 APPROVE」的修订说明', () => {
    const text = readFileSync(
      new URL('../../docs/plans/2026-07-13-pr-review-swarm-design.md', import.meta.url),
      'utf8',
    );
    const head = text.split('\n').slice(0, 40).join('\n');
    expect(head).toContain('机器人不再提交 APPROVE');
  });
});
