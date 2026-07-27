import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustChainWorkflows, TRUST_CHAIN, WORKFLOW_DIR } from './load-workflows.js';

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOW_DIR, name), 'utf8');

const FULL_SHA = /@[0-9a-f]{40}$/;

/**
 * 设计文档 L38："reusable workflow 及其内部 custom action、第三方 Action 均固定到完整
 * commit SHA。" 这里的断言范围限定为进入 PR 审核信任链的三个 workflow —— 它们的步骤运行在
 * 持有 DEEPSEEK Secret（analyze）或 pull-requests: write（publish）的 Job 里，一个被劫持的
 * 可变 tag 就等于把这些凭据交出去。
 *
 * `ci.yml` 刻意不在范围内：它是本仓库自身的 CI，不处理不可信 PR 内容，也不持有这两类凭据，
 * 不在 PR 审核的信任链上。
 */
describe('供应链：信任链 workflow 的第三方 action 固定到完整 commit SHA', () => {
  it('所有 uses: 引用要么是本地路径，要么 pin 到 40 位 SHA', () => {
    const violations: string[] = [];
    for (const [file, wf] of loadTrustChainWorkflows()) {
      const walk = (obj: unknown, path: string): void => {
        if (Array.isArray(obj)) {
          obj.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (k === 'uses' && typeof v === 'string') {
              const isLocal = v.startsWith('./') || v.startsWith('.github/');
              if (!isLocal && !FULL_SHA.test(v)) violations.push(`${file} ${path}: ${v}`);
            } else {
              walk(v, `${path}.${k}`);
            }
          }
        }
      };
      walk(wf, '');
    }
    expect(violations, `未 pin 到完整 SHA：\n${violations.join('\n')}`).toEqual([]);
  });

  it('扫描范围覆盖了全部三个信任链 workflow（防止空扫描假绿）', () => {
    expect(loadTrustChainWorkflows().map(([f]) => f)).toEqual([...TRUST_CHAIN]);
    const usesCount = loadTrustChainWorkflows()
      .map(([, wf]) => JSON.stringify(wf).match(/"uses"/g)?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(usesCount).toBeGreaterThanOrEqual(10);
  });

  it('每个 pin 旁边都有版本注释，说明这个 SHA 对应哪个 tag', () => {
    // 纯 SHA 无法人工审阅"这是不是我想要的版本"，必须留下可核对的 tag 注释。
    const missing: string[] = [];
    for (const file of TRUST_CHAIN) {
      const text = readWorkflow(file);
      text.split('\n').forEach((line, i) => {
        const m = /uses:\s*(\S+@[0-9a-f]{40})\s*(#.*)?$/.exec(line);
        if (!m) return;
        const isOwnAction = m[1]!.startsWith('dustPyrotechnic/pr-review-swarm/');
        if (!isOwnAction && !m[2]) missing.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(missing, `以下 pin 缺少版本注释：\n${missing.join('\n')}`).toEqual([]);
  });
});
