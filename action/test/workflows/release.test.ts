import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — 仓库根目录的维护脚本，无类型声明
import { runRelease, tagsFor } from '../../../scripts/release.mjs';

const SHA = 'c'.repeat(40);

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    headSha: vi.fn().mockResolvedValue(SHA),
    repin: vi.fn().mockResolvedValue({ replaced: 6, changed: true }),
    git: vi.fn().mockResolvedValue(''),
    log: vi.fn(),
    ...overrides,
  };
}

describe('tagsFor', () => {
  it('把语义化版本拆成不可变 tag 与可移动大版本 tag', () => {
    expect(tagsFor('1.2.3')).toEqual({ tag: 'v1.2.3', majorTag: 'v1' });
  });

  it('接受带 v 前缀的写法', () => {
    expect(tagsFor('v2.0.0')).toEqual({ tag: 'v2.0.0', majorTag: 'v2' });
  });

  it('拒绝不完整的版本号', () => {
    expect(() => tagsFor('1.2')).toThrow(/x\.y\.z/);
  });
});

describe('runRelease', () => {
  it('先把内部 action pin 同步到 HEAD 并提交，再打 tag', async () => {
    const deps = makeDeps();
    await runRelease({ version: '1.2.3', push: false }, deps);

    expect(deps.repin).toHaveBeenCalledWith(SHA);
    const commands = deps.git.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    const commitIdx = commands.findIndex((c: string) => c.startsWith('commit'));
    const tagIdx = commands.findIndex((c: string) => c.startsWith('tag -a v1.2.3'));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(commitIdx);
  });

  it('把大版本 tag 强制移动到这次发布的 commit', async () => {
    const deps = makeDeps();
    await runRelease({ version: '1.2.3', push: false }, deps);

    const commands = deps.git.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    expect(commands).toContain('tag -f v1');
  });

  it('默认不推送，只打印待执行的推送命令，避免误发布', async () => {
    const deps = makeDeps();
    const result = await runRelease({ version: '1.2.3', push: false }, deps);

    const commands = deps.git.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    expect(commands.some((c: string) => c.startsWith('push'))).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.pendingPush.join('\n')).toMatch(/--force.*v1|v1.*--force/s);
  });

  it('带 push 时推送 commit、不可变 tag，并强制推送大版本 tag', async () => {
    const deps = makeDeps();
    const result = await runRelease({ version: '1.2.3', push: true }, deps);

    const commands = deps.git.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    expect(commands).toContain('push origin HEAD');
    expect(commands).toContain('push origin v1.2.3');
    expect(commands).toContain('push --force origin v1');
    expect(result.pushed).toBe(true);
  });

  it('工作区不干净时直接失败，不打 tag', async () => {
    const deps = makeDeps({ isClean: vi.fn().mockResolvedValue(false) });

    await expect(runRelease({ version: '1.2.3', push: false }, deps)).rejects.toThrow(/工作区/);
    expect(deps.git).not.toHaveBeenCalled();
  });

  it('pin 已经是最新时跳过提交，仍然照常打 tag', async () => {
    const deps = makeDeps({ repin: vi.fn().mockResolvedValue({ replaced: 6, changed: false }) });
    await runRelease({ version: '1.2.3', push: false }, deps);

    const commands = deps.git.mock.calls.map((c: unknown[]) => (c[0] as string[]).join(' '));
    expect(commands.some((c: string) => c.startsWith('commit'))).toBe(false);
    expect(commands).toContain('tag -f v1');
  });
});
