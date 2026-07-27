import { describe, expect, it } from 'vitest';
import { rawWorkflowText } from './load-workflows.js';
import { scanWorkflowForPrHeadRefs } from '../../src/lib/workflow-ref-scanner.js';

/**
 * docs/AGENTS.md 硬禁令 1 与 2：仓库内**任何** workflow 都不得 checkout PR head、
 * 不得安装 PR 依赖、不得执行 PR 中的代码。这个测试是 CI 的 `forbidden-pr-head-ref-scan`
 * job 实际运行的内容。
 */
describe('硬禁令 1/2：仓库内所有 workflow 都不 checkout PR head', () => {
  const files = rawWorkflowText();

  it('至少扫到了预期的 workflow 文件（防止 glob 写错导致空扫描假绿）', () => {
    const names = files.map(([name]) => name);
    expect(names).toContain('reusable-pr-review.yml');
    expect(names).toContain('reusable-pr-review-watchdog.yml');
    expect(names).toContain('pr-review-caller.yml');
    expect(names).toContain('ci.yml');
  });

  it.each(files)('%s', (name, text) => {
    const violations = scanWorkflowForPrHeadRefs(text);
    expect(
      violations,
      `${name} 违反硬禁令 1/2：\n${violations.map((v) => `  L${v.line} [${v.rule}] ${v.snippet}`).join('\n')}`,
    ).toEqual([]);
  });
});
