import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const BENCHMARKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(BENCHMARKS_DIR, 'run-evaluation.mjs');

/**
 * 驱动 run-evaluation.mjs 这个脚本本身，对着一个本地 mock 跑完整流程。
 *
 * 为什么需要：其余测试验证的都是它调用的那些模块。脚本自己的 main()——参数解析、
 * 指标汇总、门槛判定、退出码——在没有 API key 的机器上一行都执行不到。缺了这层，
 * 里面任何一个笔误都要等第一次 nightly 用真金白银去发现。
 */

let server;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

/**
 * 一个最小的 DeepSeek 兼容 mock。客户端强制走 tool call，所以结果要放在
 * `choices[0].message.tool_calls[0].function.arguments` 里（JSON 字符串）。
 */
async function startMock(handler) {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const isVerifier = body.messages[0].content.includes('independent verifier');
      const result = handler({ isVerifier, body });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'submit_result', arguments: JSON.stringify(result) } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function emptyExpertOutput(body) {
  return {
    shard_id: 'shard-1',
    agent: 'generic-correctness',
    candidate_findings: [],
    coverage_complete: true,
  };
}

async function runScript(baseUrl, extraArgs) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [SCRIPT, `--base-url=${baseUrl}`, ...extraArgs],
      { cwd: BENCHMARKS_DIR, env: { ...process.env, DEEPSEEK_API_KEY: 'sk-mock' } },
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('run-evaluation.mjs 脚本本身', () => {
  it('缺 DEEPSEEK_API_KEY 时以退出码 1 失败，而不是空跑成功', async () => {
    const { code, stderr } = await (async () => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--gate'], {
          cwd: BENCHMARKS_DIR,
          env: { ...process.env, DEEPSEEK_API_KEY: '' },
        });
        return { code: 0, stdout };
      } catch (err) {
        return { code: err.code, stderr: err.stderr ?? '' };
      }
    })();

    expect(code).toBe(1);
    expect(stderr).toContain('DEEPSEEK_API_KEY');
  }, 60_000);

  it('DEEPSEEK_API_KEY 是纯空白时同样判为缺失', async () => {
    // workflow 里写的是 ${{ secrets.DEEPSEEK_API_KEY }}。配错成一串空格时
    // `!apiKey` 为 false，会带着无效凭据跑到 API 调用才失败——报出来的是
    // 「上游 401」，掩盖了真正的原因「你没配 key」。
    const { code, stderr } = await (async () => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--gate'], {
          cwd: BENCHMARKS_DIR,
          env: { ...process.env, DEEPSEEK_API_KEY: '   ' },
        });
        return { code: 0, stdout };
      } catch (err) {
        return { code: err.code, stderr: err.stderr ?? '' };
      }
    })();

    expect(code).toBe(1);
    expect(stderr).toContain('DEEPSEEK_API_KEY');
  }, 60_000);

  it('零 finding 的真阴性用例：跑通全流程且门槛通过', async () => {
    const baseUrl = await startMock(({ isVerifier, body }) =>
      isVerifier ? { status: 'confirmed' } : emptyExpertOutput(body),
    );

    const { code, stdout } = await runScript(baseUrl, [
      '--case=comment-only-change',
      '--gate',
      '--repeat=2',
    ]);

    expect(stdout).toContain('召回率');
    expect(stdout).toContain('p95 端到端延迟');
    // 没有 must_find、没有误报，六个门槛都该过。
    expect(stdout).toContain('✓ 全部门槛达标');
    expect(code).toBe(0);
  }, 120_000);

  it('计量层把 mock 返回的 usage 汇总成成本与请求数', async () => {
    const baseUrl = await startMock(({ isVerifier, body }) =>
      isVerifier ? { status: 'confirmed' } : emptyExpertOutput(body),
    );

    const { stdout } = await runScript(baseUrl, ['--case=comment-only-change', '--repeat=1']);

    // 一个 shard × 3 个 agent = 3 次请求，各 800/120 token。
    expect(stdout).toMatch(/成本\/PR\s+\$0\.\d+（3 次请求）/);
  }, 120_000);

  it('--gate 下只跑一轮会被拒：抖动至少要两轮才有定义', async () => {
    const baseUrl = await startMock(({ isVerifier, body }) =>
      isVerifier ? { status: 'confirmed' } : emptyExpertOutput(body),
    );

    const { code, stdout } = await runScript(baseUrl, [
      '--case=comment-only-change',
      '--gate',
      '--repeat=1',
    ]);

    expect(stdout).toContain('--repeat>=2');
    expect(code).toBe(1);
  }, 120_000);

  it('陷阱被命中时 --gate 报红', async () => {
    // subjective-naming-preference 的陷阱：n := len(rows) 那行报一条
    // maintainability，属于 must_not_find。
    const baseUrl = await startMock(({ isVerifier }) => {
      if (isVerifier) return { status: 'confirmed' };
      return {
        shard_id: 'shard-1',
        agent: 'generic-maintainability',
        candidate_findings: [
          {
            id: 'x1',
            path: 'internal/report/builder.go',
            line: 13,
            side: 'RIGHT',
            severity: 'low',
            confidence: 'medium',
            category: 'maintainability',
            title: '变量名过短',
            evidence: 'n 这个名字没有表达含义',
            impact: '可读性下降',
            suggestion: '改成 rowCount',
            introduced_by_pr: true,
            source_agent: 'generic-maintainability',
          },
        ],
        coverage_complete: true,
      };
    });

    const { code, stdout } = await runScript(baseUrl, [
      '--case=subjective-naming-preference',
      '--gate',
      '--repeat=2',
    ]);

    expect(stdout).toContain('must_not_find');
    expect(code).toBe(1);
  }, 120_000);

  it('只在后续轮次出现的误报，也要被打印出来', async () => {
    // 误报门槛取「最差一轮」，但诊断清单若只取首轮，就会出现「因为误报打红、
    // 却不告诉你是哪几条」——而误报正是这个产品最需要能立刻看到细节的指标。
    let expertCalls = 0;
    const baseUrl = await startMock(({ isVerifier }) => {
      if (isVerifier) return { status: 'confirmed' };
      expertCalls += 1;
      // 第一轮（前 3 次 expert 调用，三个 agent）干净；之后才报一条误报。
      if (expertCalls <= 3) {
        return {
          shard_id: 'shard-1',
          agent: 'generic-correctness',
          candidate_findings: [],
          coverage_complete: true,
        };
      }
      return {
        shard_id: 'shard-1',
        agent: 'generic-correctness',
        candidate_findings: [
          {
            id: 'late-fp',
            path: 'internal/scheduler/cron.go',
            // 34（hunk 范围 30..34 的末行）而不是 31：31 是这条用例的陷阱位置，
            // 容差 ±2 会把它正确识别成 must_not_find 命中，那就不是误报了。
            line: 34,
            side: 'RIGHT',
            severity: 'medium',
            confidence: 'medium',
            category: 'correctness',
            title: '只在第二轮冒出来的误报',
            evidence: '注释改动被当成了行为变更',
            impact: '无',
            suggestion: '无',
            introduced_by_pr: true,
            source_agent: 'generic-correctness',
          },
        ],
        coverage_complete: true,
      };
    });

    const { stdout } = await runScript(baseUrl, ['--case=comment-only-change', '--repeat=2']);

    expect(stdout).toContain('internal/scheduler/cron.go:34');
  }, 120_000);

  it('模型报出真阳性时召回率为 100%', async () => {
    const baseUrl = await startMock(({ isVerifier }) => {
      if (isVerifier) return { status: 'confirmed' };
      return {
        shard_id: 'shard-1',
        agent: 'generic-correctness',
        candidate_findings: [
          {
            id: 'y1',
            path: 'pkg/service/user.go',
            line: 19,
            side: 'RIGHT',
            severity: 'high',
            confidence: 'high',
            category: 'correctness',
            title: '未检查错误返回',
            evidence: 'db.Exec 的返回值被丢弃',
            impact: '删除失败时调用方无从得知',
            suggestion: '检查并处理 error',
            introduced_by_pr: true,
            source_agent: 'generic-correctness',
          },
        ],
        coverage_complete: true,
      };
    });

    const { stdout } = await runScript(baseUrl, [
      '--case=go-missing-error-check',
      '--repeat=1',
    ]);

    expect(stdout).toMatch(/召回率\s+100\.0%/);
  }, 120_000);

  it('上游返回 500 时判定 incomplete，而不是当成一次干净的零 finding 审核', async () => {
    server = createServer((req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const { code, stdout } = await runScript(baseUrl, [
      '--case=comment-only-change',
      '--gate',
      '--repeat=2',
    ]);

    // 静默把"模型没回话"记成"没问题"，正是这个产品最危险的失败模式。
    expect(stdout).toContain('incomplete');
    expect(code).toBe(1);
  }, 120_000);
});
