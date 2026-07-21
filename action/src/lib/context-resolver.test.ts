import { describe, expect, it } from 'vitest';
import { resolveContext, type RepoTreeEntry } from './context-resolver.js';

const tree: RepoTreeEntry[] = [
  { path: 'src/foo.ts', sha: 'sha-foo', type: 'blob' },
  { path: 'src/bar.ts', sha: 'sha-bar', type: 'blob' },
  { path: 'src/foo.test.ts', sha: 'sha-foo-test', type: 'blob' },
  { path: 'src/unrelated.ts', sha: 'sha-unrelated', type: 'blob' },
  { path: 'src', sha: 'sha-src-dir', type: 'tree' },
];

describe('resolveContext', () => {
  it('adds the changed file itself as same_file_full_content', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts'],
      changedFileContents: { 'src/foo.ts': '' },
      tree,
    });

    expect(result).toContainEqual({
      path: 'src/foo.ts',
      reason: 'same_file_full_content',
      sha: 'sha-foo',
    });
  });

  it('adds a same-directory relative import as same_directory_import', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts'],
      changedFileContents: { 'src/foo.ts': "import { helper } from './bar';\n" },
      tree,
    });

    expect(result).toContainEqual({
      path: 'src/bar.ts',
      reason: 'same_directory_import',
      sha: 'sha-bar',
    });
  });

  it('does not add an import target that already is a changed file', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts', 'src/bar.ts'],
      changedFileContents: {
        'src/foo.ts': "import { helper } from './bar';\n",
        'src/bar.ts': '',
      },
      tree,
    });

    expect(result.filter((r) => r.reason === 'same_directory_import')).toEqual([]);
  });

  it('adds a naming-matched test file as matching_test_file', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts'],
      changedFileContents: { 'src/foo.ts': '' },
      tree,
    });

    expect(result).toContainEqual({
      path: 'src/foo.test.ts',
      reason: 'matching_test_file',
      sha: 'sha-foo-test',
    });
  });

  it('does not add an import target or test file that does not exist in the tree', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts'],
      changedFileContents: { 'src/foo.ts': "import { x } from './does-not-exist';\n" },
      tree,
    });

    expect(result.some((r) => r.path === 'src/does-not-exist.ts')).toBe(false);
  });

  it('never adds an unrelated file with no relationship to the changed file', () => {
    const result = resolveContext({
      changedFilePaths: ['src/foo.ts'],
      changedFileContents: { 'src/foo.ts': '' },
      tree,
    });

    expect(result.some((r) => r.path === 'src/unrelated.ts')).toBe(false);
  });
});
