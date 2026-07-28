import { describe, expect, it } from 'vitest';
import { parsePatch } from './diff-parser.js';

/**
 * diff 解析的资源压力（对抗性测试加固计划 Task 7.2，nightly 通道）。
 *
 * 输入全部程序生成，不往仓库提交大文件。要证明的是"不 OOM、不指数级回溯、不 hang"，
 * 而不是"很快"。
 */
function buildHunk(lineCount: number, lineContent = 'const x = 1;'): string {
  const lines = [`@@ -1,${lineCount} +1,${lineCount} @@`];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(`+${lineContent}`);
  }
  return lines.join('\n');
}

describe('diff-parser 资源压力', () => {
  it('单 hunk 10 万行：解析完成且行号连续，耗时 < 30s', () => {
    const patch = buildHunk(100_000);

    const t0 = performance.now();
    const parsed = parsePatch('src/huge.ts', patch);
    const elapsed = performance.now() - t0;

    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]!.lines).toHaveLength(100_000);
    // 抽查首尾行号，确认没有在大输入下静默错位。
    expect(parsed.hunks[0]!.lines[0]!.newLine).toBe(1);
    expect(parsed.hunks[0]!.lines[99_999]!.newLine).toBe(100_000);
    expect(elapsed, `耗时 ${elapsed}ms`).toBeLessThan(30_000);
  });

  it('单行 20 万字符：不发生指数级回溯（ReDoS 检测，耗时 < 1s）', () => {
    // 经典的灾难性回溯诱饵：超长同类字符 + 尾部不匹配。
    const evilLine = `${'a'.repeat(200_000)}!`;
    const patch = `@@ -1,1 +1,1 @@\n+${evilLine}`;

    const t0 = performance.now();
    const parsed = parsePatch('src/long-line.ts', patch);
    const elapsed = performance.now() - t0;

    expect(parsed.hunks[0]!.lines[0]!.content).toHaveLength(200_001);
    expect(elapsed, `耗时 ${elapsed}ms，疑似正则回溯`).toBeLessThan(1000);
  });

  it.each([
    ['空白 + @ 混淆', `@@ -1,1 +1,1 @@\n+${'@'.repeat(50_000)}`],
    ['大量伪 hunk 头', Array.from({ length: 20_000 }, () => '@@ -1,0 +1,0 @@').join('\n')],
    ['全是 +/- 前缀字符', `@@ -1,1 +1,1 @@\n+${'+-'.repeat(100_000)}`],
  ])('畸形超大输入（%s）不 hang、不抛异常', (_label, patch) => {
    const t0 = performance.now();
    expect(() => parsePatch('src/weird.ts', patch)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('5000 个小 hunk：全部解析出来，一个都不丢', () => {
    const hunks: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const start = i * 10 + 1;
      hunks.push(`@@ -${start},1 +${start},1 @@`, `+line ${i}`);
    }

    const parsed = parsePatch('src/many-hunks.ts', hunks.join('\n'));
    expect(parsed.hunks).toHaveLength(5000);
  });

  it('50MB 级 diff：不 OOM，解析结果与输入规模一致', () => {
    // 每行约 500 字符 × 10 万行 ≈ 50MB。
    const patch = buildHunk(100_000, 'x'.repeat(500));

    const parsed = parsePatch('src/massive.ts', patch);
    expect(parsed.hunks[0]!.lines).toHaveLength(100_000);
  });
});
