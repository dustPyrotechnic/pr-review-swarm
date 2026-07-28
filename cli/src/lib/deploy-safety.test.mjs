import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setSecret } from './set-secret.mjs';
import { deployChanges } from './deploy-changes.mjs';
import { runDeploy } from './run-deploy.mjs';

/**
 * 部署幂等与前置检查（对抗性测试加固计划 Task 8.2）。
 */
const CLI_LIB_DIR = fileURLToPath(new URL('./', import.meta.url));

const MALICIOUS_REPO_NAMES = [
  'owner/repo; rm -rf /',
  'owner/repo && curl evil.example',
  'owner/repo`whoami`',
  'owner/repo$(id)',
  'owner/repo|tee /tmp/pwned',
  "owner/repo'; DROP TABLE--",
  'owner/repo\nrm -rf /',
];

describe('命令注入：仓库名含特殊字符', () => {
  it.each(MALICIOUS_REPO_NAMES)('%j 作为 owner/repo 时被当作单个参数，不拼进 shell', async (name) => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await setSecret({ owner: name, repo: 'r', key: 'k', exec });

    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    // 恶意串必须原封不动地待在**一个** argv 元素里，而不是被拆成多个 token。
    expect(args).toContain(`${name}/r`);
    expect(args.filter((a) => a.includes('rm -rf') || a.includes('whoami')).length).toBeLessThanOrEqual(1);
  });

  it('CLI 从不使用 shell 执行子进程（结构性断言，注入在源头不可能）', () => {
    const offenders = [];
    for (const file of readdirSync(CLI_LIB_DIR).filter(
      (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'),
    )) {
      const source = readFileSync(join(CLI_LIB_DIR, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        if (/\bshell\s*:\s*true/.test(line)) offenders.push(`${file}:${i + 1}: shell: true`);
        if (/\bexecSync\s*\(|\bexec\s*\(\s*`/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `以下位置可能引入 shell 注入：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('所有子进程调用都走 execFile（argv 数组），不做字符串拼接', () => {
    for (const file of ['deploy-changes.mjs', 'detect-repo.mjs', 'set-secret.mjs']) {
      const source = readFileSync(join(CLI_LIB_DIR, file), 'utf8');
      expect(source, `${file} 应使用 execFile 或 spawn 的 argv 形式`).toMatch(
        /execFile|spawn\(/,
      );
      expect(source, `${file} 不应 import child_process 的 exec（字符串命令）`).not.toMatch(
        /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*'node:child_process'/,
      );
    }
  });
});

describe('部署幂等：中断后重跑收敛，不产生第二个 PR', () => {
  /** 模拟一个真实的 git/gh：分支和 PR 的存在性跨多次 deploy 调用保持。 */
  function makeWorld({ branchExists = false, prExists = false } = {}) {
    const world = { branchExists, prExists };
    const calls = [];
    const exec = vi.fn(async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));

      if (cmd === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        if (world.branchExists) {
          const err = new Error("fatal: a branch named 'pr-review-swarm/deploy' already exists");
          err.code = 128;
          throw err;
        }
        world.branchExists = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        if (world.prExists) {
          const err = new Error('a pull request for branch "pr-review-swarm/deploy" already exists');
          err.code = 1;
          throw err;
        }
        world.prExists = true;
        return { code: 0, stdout: 'https://example/pr/1\n', stderr: '' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { code: 0, stdout: world.prExists ? 'https://example/pr/1\n' : '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    return { world, calls, exec };
  }

  function makeExec(existingBranch) {
    return makeWorld({ branchExists: existingBranch });
  }

  it('首次部署：建分支、提交、推送、开 PR', async () => {
    const { exec, calls } = makeExec(false);
    const result = await deployChanges({ paths: ['a.yml'], directPush: false, exec });

    expect(result.mode).toBe('pr');
    expect(calls.some((c) => c.startsWith('git checkout -b'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('gh pr create'))).toHaveLength(1);
  });

  it('在「已写文件、未设 secret」处中断后重跑：切到已有分支，不直接崩掉', async () => {
    // 真实的重跑路径：上一次跑到 setSecret 前失败，工作区已有那条分支。
    const { exec, calls } = makeExec(true);
    const result = await deployChanges({ paths: ['a.yml'], directPush: false, exec }).catch(
      (err) => err,
    );

    expect(result instanceof Error, '分支已存在时直接抛出，重跑无法收敛').toBe(false);
    expect(calls, '应当退回到切换分支').toContain('git checkout pr-review-swarm/deploy');
  });

  it('完整重跑两次：只创建一条分支、只开一个 PR，第二次复用已有 PR', async () => {
    const { exec, calls } = makeWorld();

    const first = await deployChanges({ paths: ['a.yml'], directPush: false, exec });
    const second = await deployChanges({ paths: ['a.yml'], directPush: false, exec });

    expect(first.prUrl).toBe('https://example/pr/1');
    expect(second.prUrl, '第二次应复用同一个 PR').toBe('https://example/pr/1');
    expect(second.reusedExistingPr).toBe(true);

    // gh pr create 尝试了两次，但只有第一次真的建成；不会出现第二个 PR。
    expect(calls.filter((c) => c.startsWith('git checkout -b'))).toHaveLength(2);
    expect(calls.filter((c) => c === 'git checkout pr-review-swarm/deploy')).toHaveLength(1);
  });
});

describe('部署前置检查', () => {
  function makeDeps(overrides = {}) {
    return {
      checkGhCli: vi.fn().mockResolvedValue(undefined),
      detectRepo: vi.fn().mockResolvedValue({ owner: 'octo', repo: 'repo' }),
      resolveDeepseekKey: vi.fn().mockResolvedValue('k'),
      resolveRef: vi.fn().mockResolvedValue({ ref: 'v1', mode: 'tag' }),
      writeWorkflows: vi.fn().mockReturnValue({ written: ['w.yml'] }),
      writeRepoConfig: vi.fn().mockReturnValue({ written: ['c.yml'] }),
      setSecret: vi.fn().mockResolvedValue(undefined),
      deployChanges: vi.fn().mockResolvedValue({ mode: 'pr', prUrl: 'u' }),
      ...overrides,
    };
  }

  it('gh 前置检查失败时立刻中止，不写任何文件、不设 secret', async () => {
    const deps = makeDeps({
      checkGhCli: vi.fn().mockRejectedValue(new Error('gh is not installed')),
    });

    await expect(runDeploy({ directPush: false, force: false }, deps)).rejects.toThrow(/gh/);
    expect(deps.writeWorkflows).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
    expect(deps.deployChanges).not.toHaveBeenCalled();
  });

  it('仓库探测失败时同样在写文件前中止', async () => {
    const deps = makeDeps({
      detectRepo: vi.fn().mockRejectedValue(new Error('not inside a git repository')),
    });

    await expect(runDeploy({ directPush: false, force: false }, deps)).rejects.toThrow(/git/);
    expect(deps.writeWorkflows).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
  });

  it('--direct-push 的结果里带有醒目警告（绕过了 PR 审查这件事必须可见）', async () => {
    const { exec } = { exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }) };
    const result = await deployChanges({ paths: ['a.yml'], directPush: true, exec });

    expect(result.mode).toBe('direct-push');
    expect(result.warning, '--direct-push 必须给出警告').toBeTruthy();
    expect(result.warning).toMatch(/⚠️|without going through a PR/);
  });

  it('--pin-sha 时写进 workflow 的 ref 是完整 40 位十六进制 SHA', async () => {
    const sha = 'ae91f170ebae5fde58c6bd7a29b8fc08619e990d';
    const deps = makeDeps({
      resolveRef: vi.fn().mockResolvedValue({ ref: sha, mode: 'sha' }),
    });

    const result = await runDeploy({ directPush: false, force: false, pinSha: true }, deps);

    expect(result.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(deps.writeWorkflows).toHaveBeenCalledWith(expect.objectContaining({ ref: sha }));
  });
});
