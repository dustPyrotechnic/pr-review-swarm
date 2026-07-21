export interface SecretScanResult {
  redactedContent: string;
  redactionsCount: number;
}

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'slack-token', regex: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'aws-access-key-id', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
];

export function scanAndRedactSecrets(content: string): SecretScanResult {
  let redactedContent = content;
  let redactionsCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    redactedContent = redactedContent.replace(pattern.regex, () => {
      redactionsCount += 1;
      return `[REDACTED:${pattern.name}]`;
    });
  }

  return { redactedContent, redactionsCount };
}
