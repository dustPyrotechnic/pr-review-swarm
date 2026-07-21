import { describe, expect, it } from 'vitest';
import { checkPaginationGuard } from './pr-files-pagination-guard.js';

describe('checkPaginationGuard', () => {
  it('is not truncated when file count is below the limit', () => {
    const result = checkPaginationGuard(
      [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }],
      3000,
    );
    expect(result.paginationTruncated).toBe(false);
  });

  it('flags truncation when file count reaches the limit', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: '@@ -1 +1 @@\n+x',
    }));
    const result = checkPaginationGuard(files, 5);
    expect(result.paginationTruncated).toBe(true);
  });

  it('collects filenames of files missing a patch field', () => {
    const files = [
      { filename: 'has-patch.ts', patch: '@@ -1 +1 @@\n+x' },
      { filename: 'no-patch.bin' },
    ];
    const result = checkPaginationGuard(files, 3000);
    expect(result.missingPatchFiles).toEqual(['no-patch.bin']);
  });

  it('returns an empty missingPatchFiles list when all files have patches', () => {
    const files = [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }];
    const result = checkPaginationGuard(files, 3000);
    expect(result.missingPatchFiles).toEqual([]);
  });
});
