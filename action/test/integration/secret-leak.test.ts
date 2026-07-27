import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanAndRedactSecrets } from '../../src/lib/secret-scanner.js';
import { createDeepSeekClient } from '../../src/lib/deepseek-client.js';

/**
 * docs/AGENTS.md 硬禁令 5：禁止把 GITHUB_TOKEN 之外的凭据写入 artifact / 日志。
 * CHECKLIST 的 26 条对账里对这条是零覆盖。
 *
 * 哨兵串故意长得像真 key，但不是任何真实凭据。
 */
const SENTINEL = 'sk-SENTINEL-DO-NOT-LEAK-8f3a1c9e';

const analyzeSource = (): string =>
  readFileSync(fileURLToPath(new URL('../../src/entrypoints/analyze.ts', import.meta.url)), 'utf-8');

describe('Secret 哨兵不得出现在任何输出通道', () => {
  it('DeepSeek client 抛出的网络错误里不含 API key（最容易泄漏的路径）', async () => {
    // 真实世界里最常见的泄漏形态：底层 HTTP 栈把整个请求（含 Authorization 头）
    // 塞进错误消息，客户端再把它原样拼进自己的错误里，最后经 core.warning 落进 job 日志。
    const client = createDeepSeekClient({
      apiKey: SENTINEL,
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(
          `connect ECONNREFUSED 1.2.3.4:443 (request headers: Authorization: Bearer ${SENTINEL})`,
        );
      },
    });

    await expect(
      client.sendStructuredRequest({
        model: 'deepseek-chat',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: { type: 'object' },
      }),
    ).rejects.toThrow(/deepseek-client/);

    let message = '';
    try {
      await client.sendStructuredRequest({
        model: 'deepseek-chat',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: { type: 'object' },
      });
    } catch (err) {
      message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    }
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('[REDACTED:deepseek-api-key]');
  });

  it('API key 出现在响应体里时也不会经由错误消息逃逸', async () => {
    const client = createDeepSeekClient({
      apiKey: SENTINEL,
      maxRetries: 0,
      sleep: async () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: `invalid key ${SENTINEL}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    let message = '';
    try {
      await client.sendStructuredRequest({
        model: 'deepseek-chat',
        systemPrompt: 's',
        userPrompt: 'u',
        jsonSchema: { type: 'object' },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(SENTINEL);
  });

  it('analyze 把 DEEPSEEK_API_KEY 注册为 Actions Secret，日志全局遮罩（纵深防御）', () => {
    const source = analyzeSource();
    expect(source).toContain('core.setSecret(apiKey)');
    // 必须在客户端创建之前注册，否则中间任何一次抛错都不受遮罩保护。
    // 比对的是调用点 `createDeepSeekClient({`，不是顶部 import 里的同名标识符。
    const callSite = source.indexOf('createDeepSeekClient({');
    expect(callSite).toBeGreaterThan(0);
    expect(source.indexOf('core.setSecret(apiKey)')).toBeLessThan(callSite);
  });

  it('analyze 写出的 artifact 结构里没有任何诊断/错误消息字段', () => {
    // stageFailureReason 只走 core.warning，绝不进 artifact —— artifact 会被
    // upload-artifact 长期留存，且下游 publish 会读它。
    const source = analyzeSource();
    const artifactShape = /export interface AnalyzeArtifact \{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
    expect(artifactShape).toContain('findings');
    expect(artifactShape).toContain('coverage_manifest');
    expect(artifactShape).not.toMatch(/stageFailureReason|stage_failure_reason|error|diagnostic/i);
  });
});

describe('secret-scanner 脱敏 PR 内容中的疑似凭据，不把完整凭据送进 prompt', () => {
  const payloads: Array<[string, string, string]> = [
    // [用例名, 送进扫描器的内容, 绝不能出现在输出里的片段]
    [
      'AWS secret access key（无引号的 env 式赋值）',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'wJalrXUtnFEMI',
    ],
    [
      'GitHub PAT',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
    ],
    [
      'RSA 私钥块',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
      'MIIEow',
    ],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    ],
    [
      'Anthropic 风格 key（带引号的高熵赋值）',
      'const apiKey = "sk-ant-api03-Xq7Zt2Lm9Wk4Pv8Rn3Bc6Yd1Hf5Gj0Ts";',
      'sk-ant-api03-Xq7Zt2Lm9Wk4Pv8Rn3Bc6Yd1Hf5Gj0Ts',
    ],
  ];

  it.each(payloads)('%s 被脱敏', (_name, content, mustNotAppear) => {
    const { redactedContent, redactionsCount } = scanAndRedactSecrets(content);
    expect(redactedContent).not.toContain(mustNotAppear);
    expect(redactionsCount).toBeGreaterThan(0);
  });

  it('不误报：普通代码与低熵占位符原样保留', () => {
    const benign = [
      'const timeout = 30;',
      'password = "changeme"',
      'API_KEY=your-api-key-here',
      '// TODO: rotate the token before release',
    ].join('\n');
    expect(scanAndRedactSecrets(benign).redactedContent).toBe(benign);
  });
});
