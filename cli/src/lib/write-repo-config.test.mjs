import { describe, expect, it, vi } from 'vitest';
import { writeRepoConfig } from './write-repo-config.mjs';

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

describe('writeRepoConfig', () => {
  it('writes a default .github/pr-review-swarm.yml with enabled: true', () => {
    const fs = makeFs();
    const result = writeRepoConfig({ fs, force: false });

    expect(result.written).toEqual(['.github/pr-review-swarm.yml']);
    expect(fs.written['.github/pr-review-swarm.yml']).toContain('enabled: true');
  });

  it('does not overwrite an existing repo config without --force, and does not error', () => {
    const fs = makeFs({ '.github/pr-review-swarm.yml': true });
    const result = writeRepoConfig({ fs, force: false });

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['.github/pr-review-swarm.yml']);
  });

  it('overwrites when --force is set', () => {
    const fs = makeFs({ '.github/pr-review-swarm.yml': true });
    const result = writeRepoConfig({ fs, force: true });

    expect(fs.writeFile).toHaveBeenCalled();
    expect(result.written).toEqual(['.github/pr-review-swarm.yml']);
  });
});
