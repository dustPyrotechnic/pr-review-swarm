import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import maliciousPaths from '../../test/fixtures/malicious-paths.json' with { type: 'json' };
import { validateDeterministicEvidence } from './deterministic-evidence-validator.js';
import type { DiffHunk } from './diff-parser.js';
import type { CandidateFinding } from './expert-runner.js';

function makeFinding(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: 'cf-1',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    severity: 'high',
    confidence: 'high',
    category: 'correctness',
    title: 'title',
    evidence: 'evidence',
    impact: 'impact',
    suggestion: 'suggestion',
    introduced_by_pr: true,
    source_agent: 'generic-correctness',
    ...overrides,
  };
}

describe('validateDeterministicEvidence', () => {
  it('passes when the line is a newly added line within a hunk (rule 1)', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 8,
        oldLines: 1,
        newStart: 8,
        newLines: 3,
        lines: [
          { type: 'context', oldLine: 8, newLine: 8, content: 'unchanged' },
          { type: 'add', newLine: 9, content: 'new line' },
          { type: 'add', newLine: 10, content: 'target line' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('passed');
  });

  it('passes when the line is unchanged context but sits within a hunk that also modified nearby lines (rule 2)', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 8,
        oldLines: 3,
        newStart: 8,
        newLines: 3,
        lines: [
          { type: 'del', oldLine: 8, content: 'removed line' },
          { type: 'add', newLine: 8, content: 'replacement line' },
          { type: 'context', oldLine: 9, newLine: 9, content: 'unchanged, but in the same hunk' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 9, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('passed');
  });

  it('fails when the file was touched elsewhere but this line is outside every hunk range', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 100,
        oldLines: 1,
        newStart: 100,
        newLines: 2,
        lines: [
          { type: 'context', oldLine: 100, newLine: 100, content: 'unrelated' },
          { type: 'add', newLine: 101, content: 'unrelated addition' },
        ],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('failed');
    expect(result.reason).toBeTruthy();
  });

  it('fails when there are no hunks for the file at all', () => {
    const result = validateDeterministicEvidence(makeFinding({ line: 10, side: 'RIGHT' }), 'src/foo.ts', []);

    expect(result.status).toBe('failed');
  });

  it('defers cross-file causal claims to the verifier without evaluating line rules', () => {
    const result = validateDeterministicEvidence(
      makeFinding({ line: 10, side: 'RIGHT', cross_file_causal_claim: true }),
      'src/foo.ts',
      [],
    );

    expect(result.status).toBe('deferred_to_verifier');
  });

  it('fails when the finding path does not match the file the hunks belong to', () => {
    const hunks: DiffHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [{ type: 'add', newLine: 1, content: 'x' }],
      },
    ];

    const result = validateDeterministicEvidence(makeFinding({ path: 'src/other.ts' }), 'src/foo.ts', hunks);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/path/i);
  });
});

// ---------------------------------------------------------------------------
// 恶意文件名矩阵（对抗性测试加固计划 Task 4.2）
// ---------------------------------------------------------------------------

const MALICIOUS_PATHS: Array<[string, string]> = maliciousPaths.paths.map((p) => [p.id, p.path]);

const REAL_FILE = 'src/foo.ts';
const REAL_HUNKS: DiffHunk[] = [
  {
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 2,
    lines: [
      { type: 'context', oldLine: 10, newLine: 10, content: 'const a = 1;' },
      { type: 'add', newLine: 11, content: 'const b = 2;' },
    ],
  },
];

describe('恶意路径一律拒绝或安全归一化', () => {
  it('语料非空（防止 JSON 读错导致空跑假绿）', () => {
    expect(MALICIOUS_PATHS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(MALICIOUS_PATHS)('%s 不能通过确定性证据校验', (_id, path) => {
    // 真实 hunk 属于 src/foo.ts；任何与它不一致的路径都必须被判 failed，
    // 不允许靠归一化（./、//、. 段）绕成"看起来相同"的路径。
    const result = validateDeterministicEvidence(makeFinding({ path, line: 11 }), REAL_FILE, REAL_HUNKS);
    expect(result.status, `${_id} 意外通过了校验`).toBe('failed');
  });

  it.each(MALICIOUS_PATHS)('%s 不会 crash（返回失败结果而非抛异常）', (_id, path) => {
    expect(() =>
      validateDeterministicEvidence(makeFinding({ path, line: 11 }), REAL_FILE, REAL_HUNKS),
    ).not.toThrow();
    // 也不允许在 filePath 侧传入恶意值时抛异常。
    expect(() =>
      validateDeterministicEvidence(makeFinding({ path, line: 11 }), path, REAL_HUNKS),
    ).not.toThrow();
  });

  it.each(MALICIOUS_PATHS)('%s 即使与 filePath 完全相同也不因此获得额外信任', (_id, path) => {
    // path === filePath 时路径比对这一关会过，但行号仍必须落在真实变更 hunk 内。
    const outOfRange = validateDeterministicEvidence(
      makeFinding({ path, line: 9999 }),
      path,
      REAL_HUNKS,
    );
    expect(outOfRange.status).toBe('failed');
  });

  it('确定性校验不做任何文件系统读取（越界路径无从逃逸）', () => {
    // 它只拿 finding、filePath 和已解析的 hunks 做比对，源码里不出现任何 fs/path 读取。
    const source = readFileSync(
      new URL('./deterministic-evidence-validator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toMatch(/from 'node:fs'|require\('node:fs'\)|readFile|existsSync/);
    expect(source).not.toMatch(/from 'node:path'/);
  });
});
