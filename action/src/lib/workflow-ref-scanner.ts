import yaml from 'js-yaml';

/**
 * Static scanner for docs/AGENTS.md hard rules 1 and 2: no workflow may ever
 * place PR head code on the runner's disk.
 *
 * This replaces the single regex `ref:\s*.*github\.event\.pull_request\.head`
 * that the `forbidden-pr-head-ref-scan` CI job used to run. That regex was
 * bypassable by `github.head_ref`, `format()`/`fromJSON()` wrapping, routing
 * the value through `env:` first, splitting `ref:` from its value across
 * lines, YAML anchors, and by fetching the PR ref in a `run:` script instead.
 *
 * The distinction the scanner draws is *not* "does this workflow mention the
 * PR head" — this project legitimately has to pass `head_sha` to its own
 * action as data (prepare needs it to call the API). The distinction is
 * "does the PR head end up checked out on disk", i.e. it is the `ref:` of an
 * `actions/checkout` step, or a shell command that fetches it.
 */
export interface Violation {
  /** 1-indexed line in the scanned text, or 0 when it cannot be located. */
  line: number;
  rule: 'checkout-ref-pr-head' | 'checkout-ref-tainted-env' | 'shell-pr-head-fetch';
  snippet: string;
}

/**
 * Matched against whitespace-stripped text so that `github . event . pull_request
 * . head . sha`, multi-line expressions and `format('{0}', ...)` wrappers all
 * normalise to the same shape. Deliberately anchored on the trailing
 * `pull_request.head` / `head_ref` rather than the leading `github.event.`, so
 * that `fromJSON(toJSON(github.event)).pull_request.head.sha` is caught too.
 */
const PR_HEAD_EXPR = /pull_request\.head\b|\bhead_ref\b/;

/** Shell patterns that pull the PR head down without `actions/checkout`. */
const SHELL_FETCH_PATTERNS: Array<[RegExp, string]> = [
  [/\bgh\s+pr\s+checkout\b/, 'gh pr checkout'],
  [/\bpull\/[^/\s]+\/head\b/, 'git fetch pull/<n>/head'],
  [/\bgit\s+checkout\s+FETCH_HEAD\b/, 'git checkout FETCH_HEAD'],
];

const CHECKOUT_ACTION = /(^|\/)actions\/checkout(@|$)/;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function mentionsPrHead(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return PR_HEAD_EXPR.test(stripWhitespace(value));
}

/** `${{ env.FOO }}`, `$FOO`, `${FOO}` — every way a ref can name an env var. */
function referencedEnvNames(value: string): string[] {
  const names: string[] = [];
  const compact = stripWhitespace(value);
  for (const m of compact.matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[1]) names.push(m[1]);
  }
  for (const m of value.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

/** Best-effort 1-indexed line lookup for a value, for actionable error output. */
function locate(text: string, needle: string): number {
  const lines = text.split('\n');
  const compactNeedle = stripWhitespace(needle);
  if (!compactNeedle) return 0;
  const exact = lines.findIndex((l) => l.includes(needle));
  if (exact >= 0) return exact + 1;
  const loose = lines.findIndex((l) => stripWhitespace(l).includes(compactNeedle));
  return loose >= 0 ? loose + 1 : 0;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collects every env var name, at any nesting level, tainted by a PR head expression. */
function collectTaintedEnvNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTaintedEnvNames(item, into);
    return;
  }
  if (!isDict(node)) return;

  const env = node.env;
  if (isDict(env)) {
    for (const [name, value] of Object.entries(env)) {
      if (mentionsPrHead(value)) into.add(name);
    }
  }
  for (const value of Object.values(node)) collectTaintedEnvNames(value, into);
}

function scanStep(step: Dict, text: string, tainted: Set<string>, out: Violation[]): void {
  const uses = typeof step.uses === 'string' ? step.uses : undefined;
  const run = typeof step.run === 'string' ? step.run : undefined;

  if (uses && CHECKOUT_ACTION.test(uses)) {
    const withBlock = isDict(step.with) ? step.with : undefined;
    const ref = withBlock?.ref;
    if (typeof ref === 'string') {
      if (mentionsPrHead(ref)) {
        out.push({ line: locate(text, ref), rule: 'checkout-ref-pr-head', snippet: ref.trim() });
      } else if (referencedEnvNames(ref).some((n) => tainted.has(n))) {
        out.push({
          line: locate(text, ref),
          rule: 'checkout-ref-tainted-env',
          snippet: ref.trim(),
        });
      }
    }
  }

  if (run) {
    for (const [pattern, label] of SHELL_FETCH_PATTERNS) {
      if (pattern.test(run)) {
        out.push({
          line: locate(text, run.split('\n')[0] ?? run),
          rule: 'shell-pr-head-fetch',
          snippet: label,
        });
        break;
      }
    }
  }
}

function walkForSteps(node: unknown, text: string, tainted: Set<string>, out: Violation[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkForSteps(item, text, tainted, out);
    return;
  }
  if (!isDict(node)) return;

  if (typeof node.uses === 'string' || typeof node.run === 'string') {
    scanStep(node, text, tainted, out);
  }
  for (const value of Object.values(node)) walkForSteps(value, text, tainted, out);
}

/**
 * Line-based fallback for text js-yaml cannot parse. Malformed YAML must not
 * become a bypass: a file that does not parse is scanned conservatively, and
 * (separately) actionlint rejects it in CI anyway.
 */
function scanRawLines(text: string): Violation[] {
  const out: Violation[] = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const compact = stripWhitespace(line);
    if (/(^|[^A-Za-z0-9_-])ref:/.test(compact) && PR_HEAD_EXPR.test(compact)) {
      out.push({ line: i + 1, rule: 'checkout-ref-pr-head', snippet: line.trim() });
      return;
    }
    for (const [pattern, label] of SHELL_FETCH_PATTERNS) {
      if (pattern.test(line)) {
        out.push({ line: i + 1, rule: 'shell-pr-head-fetch', snippet: label });
        return;
      }
    }
  });

  // `ref:` on its own line with the expression on the next one.
  lines.forEach((line, i) => {
    if (!/^\s*ref:\s*$/.test(line)) return;
    const next = lines[i + 1];
    if (next && PR_HEAD_EXPR.test(stripWhitespace(next))) {
      out.push({ line: i + 2, rule: 'checkout-ref-pr-head', snippet: next.trim() });
    }
  });

  return out;
}

export function scanWorkflowForPrHeadRefs(text: string): Violation[] {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return scanRawLines(text);
  }
  if (!isDict(doc) && !Array.isArray(doc)) return [];

  const tainted = new Set<string>();
  collectTaintedEnvNames(doc, tainted);

  const out: Violation[] = [];
  walkForSteps(doc, text, tainted, out);
  return out;
}
