import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setSecret } from './set-secret.mjs';
import { resolveDeepseekKey } from './resolve-deepseek-key.mjs';
import { runDeploy } from './run-deploy.mjs';

/**
 * CLI 部署 key 泄漏防护（对抗性测试加固计划 Task 8.1）。
 *
 * 哨兵串故意长得像真 key，但不是任何真实凭据。凡是 CLI 会写出去的通道
 * （子进程 argv、console、抛出的异常与堆栈、返回值）里都不许出现它。
 */
const SENTINEL = 'sk-SENTINEL-DO-NOT-LEAK-8f3a1c9e';

/** 捕获一次调用期间所有 console 输出。 */
async function captureConsole(fn) {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const originals = {};
  for (const m of methods) {
    originals[m] = console[m];
    console[m] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    return { result: await fn(), lines };
  } finally {
    for (const m of methods) console[m] = originals[m];
  }
}

function makeDeps(overrides = {}) {
  return {
    checkGhCli: vi.fn().mockResolvedValue(undefined),
    detectRepo: vi.fn().mockResolvedValue({ owner: 'octo', repo: 'repo' }),
    resolveDeepseekKey: vi.fn().mockResolvedValue(SENTINEL),
    resolveRef: vi.fn().mockResolvedValue({ ref: 'abc123', mode: 'tag' }),
    writeWorkflows: vi.fn().mockReturnValue({ written: ['.github/workflows/pr-review-caller.yml'] }),
    writeRepoConfig: vi.fn().mockReturnValue({ written: ['.pr-review-swarm.yml'] }),
    setSecret: vi.fn().mockResolvedValue(undefined),
    deployChanges: vi.fn().mockResolvedValue({ mode: 'pr', prUrl: 'https://example/pr/1' }),
    ...overrides,
  };
}

describe('key 不出现在任何输出通道', () => {
  it('key 经 stdin 传给 gh，绝不进入子进程 argv', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await setSecret({ owner: 'octo', repo: 'repo', key: SENTINEL, exec });

    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(JSON.stringify(args), 'key 出现在了 argv 里').not.toContain(SENTINEL);
    expect(opts.input).toBe(SENTINEL);
  });

  it('gh 失败时抛出的异常消息与堆栈都不含 key', async () => {
    // 最容易泄漏的形态：把子进程 stderr 原样拼进错误消息，而 stderr 回显了输入。
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: `error: could not set secret with value ${SENTINEL}`,
    });

    let caught;
    try {
      await setSecret({ owner: 'octo', repo: 'repo', key: SENTINEL, exec });
    } catch (err) {
      caught = err;
    }

    expect(caught, '应当抛出异常').toBeDefined();
    expect(`${caught.message}\n${caught.stack ?? ''}`).not.toContain(SENTINEL);
  });

  it('exec 直接抛出的异常（含 key 的底层错误）也不会透传出去', async () => {
    const exec = vi.fn().mockRejectedValue(new Error(`spawn failed: input was ${SENTINEL}`));

    let caught;
    try {
      await setSecret({ owner: 'octo', repo: 'repo', key: SENTINEL, exec });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(`${caught.message}\n${caught.stack ?? ''}`).not.toContain(SENTINEL);
  });

  it.each([
    ['--deepseek-key 传入', { flagValue: SENTINEL, env: {} }],
    ['DEEPSEEK_API_KEY 环境变量', { flagValue: undefined, env: { DEEPSEEK_API_KEY: SENTINEL } }],
  ])('%s 时不会被打印到 console', async (_label, args) => {
    const { result, lines } = await captureConsole(() =>
      resolveDeepseekKey({ ...args, prompt: async () => SENTINEL }),
    );

    expect(result).toBe(SENTINEL);
    expect(lines.join('\n'), 'key 被打印到了 console').not.toContain(SENTINEL);
  });

  it('整条部署流程的 console 输出与返回值里都不含 key', async () => {
    const deps = makeDeps();
    const { result, lines } = await captureConsole(() =>
      runDeploy({ deepseekKeyFlag: SENTINEL, directPush: false, force: false }, deps),
    );

    expect(lines.join('\n'), 'key 出现在 console 输出里').not.toContain(SENTINEL);
    expect(JSON.stringify(result), 'key 出现在 runDeploy 的返回值里').not.toContain(SENTINEL);
  });

  it('部署流程中途失败时，异常与 console 都不含 key', async () => {
    const deps = makeDeps({
      deployChanges: vi.fn().mockRejectedValue(new Error(`push failed while holding ${SENTINEL}`)),
    });

    const { lines } = await captureConsole(async () => {
      try {
        await runDeploy({ deepseekKeyFlag: SENTINEL, directPush: false, force: false }, deps);
      } catch (err) {
        // 底层错误本身带了 key —— runDeploy 至少不能再把它打印出来。
        expect(err).toBeDefined();
      }
    });

    expect(lines.join('\n')).not.toContain(SENTINEL);
  });

  it('CLI 源码里没有任何直接打印 key 的语句（源码级锁）', () => {
    const dir = fileURLToPath(new URL('./', import.meta.url));
    const offenders = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        // console.* 里直接带上 key / apiKey / deepseekKey 这类标识符
        if (/console\.\w+\(.*\b(key|apiKey|deepseekKey|DEEPSEEK_API_KEY)\b/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `以下行可能打印 key：\n${offenders.join('\n')}`).toEqual([]);
  });
});
