import { describe, expect, it } from 'vitest';
import { scanAndRedactSecrets } from './secret-scanner.js';

describe('scanAndRedactSecrets', () => {
  it('redacts an AWS access key id', () => {
    const result = scanAndRedactSecrets('const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(result.redactedContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.redactedContent).toContain('[REDACTED:aws-access-key-id]');
    expect(result.redactionsCount).toBe(1);
  });

  it('redacts a GitHub personal access token', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = scanAndRedactSecrets(`export TOKEN=${token}`);
    expect(result.redactedContent).not.toContain(token);
    expect(result.redactionsCount).toBe(1);
  });

  it('redacts a GitHub App user-to-server token (ghu_ prefix)', () => {
    const token = 'ghu_' + 'c'.repeat(36);
    const result = scanAndRedactSecrets(`export TOKEN=${token}`);
    expect(result.redactedContent).not.toContain(token);
    expect(result.redactionsCount).toBe(1);
  });

  it('redacts a private key block', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
    const result = scanAndRedactSecrets(`some code\n${block}\nmore code`);
    expect(result.redactedContent).not.toContain('MIIBOgIBAAJBAK');
    expect(result.redactedContent).toContain('[REDACTED:private-key]');
    expect(result.redactionsCount).toBe(1);
  });

  it('redacts a Slack token', () => {
    const token = 'xoxb-1234567890-abcdefghijklmnop';
    const result = scanAndRedactSecrets(`slackToken := "${token}"`);
    expect(result.redactedContent).not.toContain(token);
    expect(result.redactionsCount).toBe(1);
  });

  it('leaves ordinary code untouched and reports zero redactions', () => {
    const code = 'function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const result = scanAndRedactSecrets(code);
    expect(result.redactedContent).toBe(code);
    expect(result.redactionsCount).toBe(0);
  });

  it('counts multiple distinct secrets in the same content', () => {
    const token = 'ghp_' + 'b'.repeat(36);
    const content = `const a = "AKIAIOSFODNN7EXAMPLE";\nconst b = "${token}";`;
    const result = scanAndRedactSecrets(content);
    expect(result.redactionsCount).toBe(2);
  });
});
