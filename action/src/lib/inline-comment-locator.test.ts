import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import maliciousPaths from '../../test/fixtures/malicious-paths.json' with { type: 'json' };
import { isFindingLocatable } from './inline-comment-locator.js';
import { parsePatch, type ParsedFileDiff } from './diff-parser.js';
import type { Finding } from './arbiter.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
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
    ...overrides,
  };
}

const patch = ['@@ -1,2 +1,3 @@', ' context line', '+added line', ' context line 2'].join('\n');
const fileDiffs: ParsedFileDiff[] = [parsePatch('src/foo.ts', patch)];

describe('isFindingLocatable', () => {
  it('is true for a RIGHT-side finding on an added line', () => {
    // added line lands at newLine 2 (context=1, add=2, context=3)
    expect(isFindingLocatable(makeFinding({ line: 2, side: 'RIGHT' }), fileDiffs)).toBe(true);
  });

  it('is true for a RIGHT-side finding on a context line within the diff', () => {
    expect(isFindingLocatable(makeFinding({ line: 1, side: 'RIGHT' }), fileDiffs)).toBe(true);
  });

  it('is false when the file is not part of the current diff', () => {
    expect(isFindingLocatable(makeFinding({ path: 'src/other.ts' }), fileDiffs)).toBe(false);
  });

  it('is false when the line is outside every hunk of that file', () => {
    expect(isFindingLocatable(makeFinding({ line: 999, side: 'RIGHT' }), fileDiffs)).toBe(false);
  });

  it('is false for a LEFT-side finding when the line is outside the diff entirely', () => {
    expect(isFindingLocatable(makeFinding({ line: 999, side: 'LEFT' }), fileDiffs)).toBe(false);
  });

  it('is false for a LEFT-side finding on a line that only exists as an added line (no pre-PR old line at all)', () => {
    const addOnlyPatch = ['@@ -1,0 +1,2 @@', '+brand new line 1', '+brand new line 2'].join('\n');
    const addOnlyDiffs = [parsePatch('src/new-file.ts', addOnlyPatch)];
    expect(
      isFindingLocatable(makeFinding({ path: 'src/new-file.ts', line: 1, side: 'LEFT' }), addOnlyDiffs),
    ).toBe(false);
  });

  it('is true for a LEFT-side finding on an old context line', () => {
    expect(isFindingLocatable(makeFinding({ line: 1, side: 'LEFT' }), fileDiffs)).toBe(true);
  });

  it('requires both start_line/start_side and line/side to be locatable when start_line is present', () => {
    const locatable = isFindingLocatable(
      makeFinding({ line: 1, side: 'RIGHT', start_line: 999, start_side: 'RIGHT' }),
      fileDiffs,
    );
    expect(locatable).toBe(false);
  });

  it('is true when both start_line/start_side and line/side are locatable', () => {
    const locatable = isFindingLocatable(
      makeFinding({ line: 3, side: 'RIGHT', start_line: 1, start_side: 'RIGHT' }),
      fileDiffs,
    );
    expect(locatable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 恶意文件名矩阵（对抗性测试加固计划 Task 4.2）
// ---------------------------------------------------------------------------

const MALICIOUS_PATHS: Array<[string, string]> = maliciousPaths.paths.map((p) => [p.id, p.path]);

describe('恶意路径的 inline 定位', () => {
  it('语料非空（防止 JSON 读错导致空跑假绿）', () => {
    expect(MALICIOUS_PATHS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(MALICIOUS_PATHS)('%s 定位失败（不匹配任何已解析的 diff）', (_id, path) => {
    expect(isFindingLocatable(makeFinding({ path }), fileDiffs)).toBe(false);
  });

  it.each(MALICIOUS_PATHS)('%s 不会 crash', (_id, path) => {
    expect(() => isFindingLocatable(makeFinding({ path }), fileDiffs)).not.toThrow();
    expect(() => isFindingLocatable(makeFinding({ path }), [])).not.toThrow();
  });

  it('路径比对是精确匹配，不做归一化——./src/foo.ts 不等于 src/foo.ts', () => {
    // 若这里改成 path.normalize 之类的"宽容"比对，攻击者就能用等价路径把 finding
    // 挂到另一个文件的 diff 上。
    expect(isFindingLocatable(makeFinding({ path: './src/foo.ts' }), fileDiffs)).toBe(false);
    expect(isFindingLocatable(makeFinding({ path: 'src//foo.ts' }), fileDiffs)).toBe(false);
    expect(isFindingLocatable(makeFinding({ path: 'src/./foo.ts' }), fileDiffs)).toBe(false);
    // 前置健全性：真实路径确实能定位成功，否则上面三条毫无意义。
    expect(isFindingLocatable(makeFinding({ path: 'src/foo.ts' }), fileDiffs)).toBe(true);
  });

  it('inline 定位不做任何文件系统读取', () => {
    const source = readFileSync(new URL('./inline-comment-locator.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/from 'node:fs'|readFile|existsSync/);
    expect(source).not.toMatch(/from 'node:path'/);
  });
});
