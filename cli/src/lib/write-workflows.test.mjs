import { describe, expect, it, vi } from 'vitest';
import { writeWorkflows } from './write-workflows.mjs';

function makeFs(existing = {}) {
  const written = {};
  return {
    written,
    exists: vi.fn((path) => path in existing),
    writeFile: vi.fn((path, content) => {
      written[path] = content;
    }),
  };
}

describe('writeWorkflows', () => {
  it('writes both listener workflow files pinned to the given ref and target owner/repo', () => {
    const fs = makeFs();
    const result = writeWorkflows({ fs, ref: 'v1', force: false });

    expect(result.written).toEqual([
      '.github/workflows/pr-review.yml',
      '.github/workflows/pr-review-watchdog.yml',
    ]);
    expect(fs.written['.github/workflows/pr-review.yml']).toContain('dustPyrotechnic/pr-review-swarm/.github/workflows/reusable-pr-review.yml@v1');
    expect(fs.written['.github/workflows/pr-review-watchdog.yml']).toContain(
      'dustPyrotechnic/pr-review-swarm/.github/workflows/reusable-pr-review-watchdog.yml@v1',
    );
  });

  it('writes a commit SHA ref verbatim when one is given', () => {
    const sha = 'a'.repeat(40);
    const fs = makeFs();
    writeWorkflows({ fs, ref: sha, force: false });

    expect(fs.written['.github/workflows/pr-review.yml']).toContain(`reusable-pr-review.yml@${sha}`);
    expect(fs.written['.github/workflows/pr-review-watchdog.yml']).toContain(`reusable-pr-review-watchdog.yml@${sha}`);
  });

  it('documents in each generated file how to move off the pinned ref', () => {
    const fs = makeFs();
    writeWorkflows({ fs, ref: 'v1', force: false });

    for (const content of Object.values(fs.written)) {
      expect(content).toContain('pr-agent deploy --force');
    }
  });

  it('refuses to overwrite an existing workflow file without --force', () => {
    const fs = makeFs({ '.github/workflows/pr-review.yml': true });
    expect(() => writeWorkflows({ fs, ref: 'v1', force: false })).toThrow(/--force/);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('overwrites an existing workflow file when --force is set, and reports it', () => {
    const fs = makeFs({ '.github/workflows/pr-review.yml': true });
    const result = writeWorkflows({ fs, ref: 'v1', force: true });

    expect(fs.writeFile).toHaveBeenCalledWith('.github/workflows/pr-review.yml', expect.any(String));
    expect(result.overwritten).toContain('.github/workflows/pr-review.yml');
  });
});
