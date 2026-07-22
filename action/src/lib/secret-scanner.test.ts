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

  describe('high-entropy heuristic (catches provider-unrecognized secrets)', () => {
    it('redacts a high-entropy string assigned to a key/token/secret-named variable', () => {
      const content = 'const apiKey = "zQ7!kP2vR9xL4mN8wJ6tH1sB3yF5dC0e";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactedContent).not.toContain('zQ7!kP2vR9xL4mN8wJ6tH1sB3yF5dC0e');
      expect(result.redactedContent).toContain('[REDACTED:high-entropy-secret]');
      expect(result.redactionsCount).toBe(1);
    });

    it('does not redact a low-entropy string even with a sensitive variable name', () => {
      const content = 'const apiKeyPlaceholder = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactedContent).toBe(content);
      expect(result.redactionsCount).toBe(0);
    });

    it('does not redact a high-entropy string assigned to a non-sensitive variable name', () => {
      const content = 'const message = "zQ7!kP2vR9xL4mN8wJ6tH1sB3yF5dC0e";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactedContent).toBe(content);
      expect(result.redactionsCount).toBe(0);
    });

    it('does not redact a short sensitive-named value below the length floor', () => {
      const content = 'const secret = "short";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactedContent).toBe(content);
      expect(result.redactionsCount).toBe(0);
    });

    it('matches password- and credential-named variables too', () => {
      const content =
        'const dbPassword = "xT9!qL2wR7mK4vN8jH1sB3yF5dC0eZ6a";\n' +
        'const authCredential = "yS8!pM3nQ6xJ5vK1wH9tB4rF2dC7eZ0b";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactionsCount).toBe(2);
      expect(result.redactedContent).not.toContain('xT9!qL2wR7mK4vN8jH1sB3yF5dC0eZ6a');
      expect(result.redactedContent).not.toContain('yS8!pM3nQ6xJ5vK1wH9tB4rF2dC7eZ0b');
    });

    it('does not double-redact a value already redacted by a known-provider pattern', () => {
      const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      const result = scanAndRedactSecrets(content);
      expect(result.redactionsCount).toBe(1);
      expect(result.redactedContent).toContain('[REDACTED:aws-access-key-id]');
      expect(result.redactedContent).not.toContain('[REDACTED:high-entropy-secret]');
    });
  });
});
