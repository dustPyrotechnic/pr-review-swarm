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

  // 最坏清理延迟 = 超时阈值 + 扫描间隔，缩间隔的收益是线性的、很小的，代价（空跑轮次、
  // 抖动碰撞面、速率配额）却是成倍的。这条把下界钉住，免得以后有人"为了更及时"随手
  // 调回 */10 —— 那样每天多跑上百轮，换来的只是最坏延迟从 40 分钟变成 20 分钟。
  it('schedules the watchdog no denser than every 30 minutes', () => {
    const fs = makeFs();
    writeWorkflows({ fs, ref: 'v1', force: false });

    const watchdog = fs.written['.github/workflows/pr-review-watchdog.yml'];
    const cron = /- cron: '\*\/(\d+) \* \* \* \*'/.exec(watchdog);
    expect(cron, 'watchdog 必须是 */N 分钟形式的 cron').not.toBeNull();
    expect(Number(cron[1])).toBeGreaterThanOrEqual(30);
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
