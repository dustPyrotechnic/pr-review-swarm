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

  it('defaults the watchdog sweep to every 30 minutes', () => {
    const fs = makeFs();
    const result = writeWorkflows({ fs, ref: 'v1', force: false });

    expect(fs.written['.github/workflows/pr-review-watchdog.yml']).toContain(
      "- cron: '*/30 * * * *'",
    );
    expect(result.watchdogInterval.label).toBe('30m');
  });

  it('honours a custom watchdog interval and reports the resulting worst case', () => {
    const fs = makeFs();
    const result = writeWorkflows({ fs, ref: 'v1', force: false, watchdogInterval: '10h' });

    const watchdog = fs.written['.github/workflows/pr-review-watchdog.yml'];
    expect(watchdog).toContain("- cron: '0 */10 * * *'");
    // 生成的注释必须写真实的最坏延迟（10 分钟阈值 + 10 小时最长间隙），不能只复述标称间隔。
    expect(watchdog).toContain('10h 10m');
    expect(result.watchdogInterval.maxGapMinutes).toBe(600);
  });

  // 间隔非法时必须在碰任何文件之前就炸掉，否则会留下"新 pr-review.yml + 旧 watchdog"
  // 这种半套配置。
  it('rejects a bad interval without writing anything', () => {
    const fs = makeFs();
    expect(() => writeWorkflows({ fs, ref: 'v1', force: false, watchdogInterval: '5m' })).toThrow(
      /at least 30m/,
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
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
