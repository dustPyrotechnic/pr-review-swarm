import { describe, expect, it } from 'vitest';
import { parsePatch } from './diff-parser.js';

describe('parsePatch', () => {
  it('parses a single hunk with context, add, and del lines', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' unchanged line',
      '-removed line',
      '+added line 1',
      '+added line 2',
    ].join('\n');

    const result = parsePatch('src/foo.ts', patch);

    expect(result.path).toBe('src/foo.ts');
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(hunk.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, content: 'unchanged line' },
      { type: 'del', oldLine: 2, content: 'removed line' },
      { type: 'add', newLine: 2, content: 'added line 1' },
      { type: 'add', newLine: 3, content: 'added line 2' },
    ]);
  });

  it('parses multiple hunks in one patch', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+b2',
      '@@ -10,1 +10,2 @@',
      ' c',
      '+d',
    ].join('\n');

    const result = parsePatch('src/foo.ts', patch);

    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
  });

  it('defaults hunk line counts to 1 when the comma count is omitted', () => {
    const patch = ['@@ -5 +5 @@', ' only line'].join('\n');

    const result = parsePatch('src/foo.ts', patch);

    expect(result.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  it('ignores "no newline at end of file" marker lines', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n');

    const result = parsePatch('src/foo.ts', patch);

    expect(result.hunks[0]!.lines).toEqual([
      { type: 'del', oldLine: 1, content: 'old' },
      { type: 'add', newLine: 1, content: 'new' },
    ]);
  });

  it('returns no hunks for an empty patch', () => {
    const result = parsePatch('src/foo.ts', '');
    expect(result.hunks).toEqual([]);
  });
});
