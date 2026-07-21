import { describe, expect, it } from 'vitest';
import { classifyFile } from './file-classifier.js';

const emptyGlobs = { ignore_globs: [], generated_globs: [] };

describe('classifyFile', () => {
  it('classifies a normal source file as reviewed', () => {
    const result = classifyFile({ filename: 'src/foo.ts' }, emptyGlobs);
    expect(result.treatment).toBe('reviewed');
  });

  it('classifies a known binary extension as skipped_binary', () => {
    const result = classifyFile({ filename: 'assets/logo.png' }, emptyGlobs);
    expect(result.treatment).toBe('skipped_binary');
    expect(result.skipReason).toBeTruthy();
  });

  it('classifies package-lock.json as skipped_lockfile', () => {
    const result = classifyFile({ filename: 'package-lock.json' }, emptyGlobs);
    expect(result.treatment).toBe('skipped_lockfile');
  });

  it('classifies yarn.lock as skipped_lockfile', () => {
    const result = classifyFile({ filename: 'yarn.lock' }, emptyGlobs);
    expect(result.treatment).toBe('skipped_lockfile');
  });

  it('classifies a file matching repo-config ignore_globs as skipped_vendor', () => {
    const result = classifyFile(
      { filename: 'third_party/lib/foo.js' },
      { ignore_globs: ['third_party/**'], generated_globs: [] },
    );
    expect(result.treatment).toBe('skipped_vendor');
  });

  it('classifies a file matching repo-config generated_globs as skipped_generated', () => {
    const result = classifyFile(
      { filename: 'src/generated/api.ts' },
      { ignore_globs: [], generated_globs: ['src/generated/**'] },
    );
    expect(result.treatment).toBe('skipped_generated');
  });

  it('prioritizes binary detection over glob-based rules', () => {
    const result = classifyFile(
      { filename: 'third_party/logo.png' },
      { ignore_globs: ['third_party/**'], generated_globs: [] },
    );
    expect(result.treatment).toBe('skipped_binary');
  });
});
