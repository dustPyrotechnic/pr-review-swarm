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

// The patterns above only catch known provider token formats. A secret with
// no recognizable prefix (or one assembled outside a single string literal,
// which no static regex can ever catch — see secret-scanner design notes)
// slips through entirely. As a second, name-gated heuristic: a string
// literal assigned to something that reads like a credential variable, with
// high enough randomness to be plausibly a real secret rather than a word or
// placeholder, gets redacted too. This mirrors the entropy heuristic used by
// gitleaks/trufflehog; it trades a small false-positive rate (uncommon
// high-entropy strings named like a key) for catching secrets none of the
// provider-specific patterns above recognize.
const SENSITIVE_NAME_RE = /(key|token|secret|password|credential|auth)/i;
const QUOTED_ASSIGNMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]{1,2}\s*['"`]([^'"`\n]{16,})['"`]/g;
const HIGH_ENTROPY_MIN_LENGTH = 16;
const HIGH_ENTROPY_THRESHOLD = 3.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redactHighEntropySecrets(content: string, onRedact: () => void): string {
  return content.replace(QUOTED_ASSIGNMENT_RE, (full, name: string, value: string) => {
    if (value.startsWith('[REDACTED:')) return full;
    if (!SENSITIVE_NAME_RE.test(name)) return full;
    if (value.length < HIGH_ENTROPY_MIN_LENGTH) return full;
    if (shannonEntropy(value) < HIGH_ENTROPY_THRESHOLD) return full;

    onRedact();
    return full.replace(value, '[REDACTED:high-entropy-secret]');
  });
}

export function scanAndRedactSecrets(content: string): SecretScanResult {
  let redactedContent = content;
  let redactionsCount = 0;

  for (const pattern of SECRET_PATTERNS) {
    redactedContent = redactedContent.replace(pattern.regex, () => {
      redactionsCount += 1;
      return `[REDACTED:${pattern.name}]`;
    });
  }

  redactedContent = redactHighEntropySecrets(redactedContent, () => {
    redactionsCount += 1;
  });

  return { redactedContent, redactionsCount };
}
