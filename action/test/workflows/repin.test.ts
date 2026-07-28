import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — 仓库根目录的维护脚本，无类型声明
import { findSelfActionRefs, repinText } from '../../../scripts/repin.mjs';
import { TRUST_CHAIN, WORKFLOW_DIR } from './load-workflows.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const SAMPLE = `jobs:
  analyze:
    steps:
      - uses: dustPyrotechnic/pr-review-swarm/action@${OLD}
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
      - uses: dustPyrotechnic/pr-review-swarm/action@${OLD}
  local:
    uses: ./.github/workflows/reusable-pr-review.yml
`;

describe('repin：统一改写中央仓库自身 action 的 pin', () => {
  it('把全部自身 action 引用改写到目标 SHA，并报告替换数量', () => {
    const result = repinText(SAMPLE, NEW);

    expect(result.replaced).toBe(2);
    expect(result.text).toContain(`dustPyrotechnic/pr-review-swarm/action@${NEW}`);
    expect(result.text).not.toContain(OLD);
  });

  it('不碰第三方 action 的 pin', () => {
    const result = repinText(SAMPLE, NEW);
    expect(result.text).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2');
  });

  it('不碰同仓库相对路径的 uses', () => {
    const result = repinText(SAMPLE, NEW);
    expect(result.text).toContain('uses: ./.github/workflows/reusable-pr-review.yml');
  });

  it('拒绝非 40 位 SHA 的目标 ref，避免把可变 tag 写进信任链', () => {
    expect(() => repinText(SAMPLE, 'v1')).toThrow(/40/);
  });

  it('findSelfActionRefs 报告每个引用的行号与 SHA', () => {
    expect(findSelfActionRefs(SAMPLE)).toEqual([
      { line: 4, sha: OLD },
      { line: 6, sha: OLD },
    ]);
  });
});

describe('供应链：信任链里自身 action 的 pin 必须完全一致', () => {
  const refs = TRUST_CHAIN.flatMap((file) =>
    findSelfActionRefs(readFileSync(join(WORKFLOW_DIR, file), 'utf8')).map(
      (r: { line: number; sha: string }) => `${file}:${r.line} ${r.sha}`,
    ),
  );

  it('扫到了预期数量的自身 action 引用（防止空扫描假绿）', () => {
    expect(refs.length).toBeGreaterThanOrEqual(6);
  });

  it('所有自身 action 引用指向同一个 commit（防止只改了一半的部分 repin）', () => {
    const shas = new Set(refs.map((r) => r.split(' ')[1]));
    expect([...shas], `自身 action pin 不一致：\n${refs.join('\n')}`).toHaveLength(1);
  });
});
