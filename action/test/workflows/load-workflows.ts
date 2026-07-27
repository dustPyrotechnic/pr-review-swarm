import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// NOTE: use fileURLToPath, not `new URL(...).pathname` — the latter returns a
// percent-encoded path, which breaks readdirSync/readFileSync for any checkout
// whose absolute path contains spaces or non-ASCII characters.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const WORKFLOW_DIR = join(ROOT, '.github/workflows');

/**
 * Workflows that are part of the PR-review trust chain: they run against
 * untrusted PR content with `pull_request_target` credentials, or they hold
 * `checks: write`. `ci.yml` is deliberately NOT in this set — it is this
 * repository's own CI, it never handles untrusted PR content with write
 * credentials, and it is not consumed by any downstream repository.
 */
export const TRUST_CHAIN = [
  'reusable-pr-review.yml',
  'reusable-pr-review-watchdog.yml',
  'pr-review-caller.yml',
] as const;

export interface Job {
  uses?: string;
  permissions?: Record<string, string> | string;
  secrets?: unknown;
  steps?: Array<{
    uses?: string;
    with?: Record<string, unknown>;
    run?: string;
    env?: Record<string, string>;
  }>;
  [k: string]: unknown;
}

export interface Workflow {
  permissions?: Record<string, string> | string;
  jobs?: Record<string, Job>;
  [k: string]: unknown;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

export function loadWorkflow(name: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOW_DIR, name), 'utf8')) as Workflow;
}

export function loadAllWorkflows(): Array<[string, Workflow]> {
  return workflowFiles().map((f) => [f, loadWorkflow(f)] as [string, Workflow]);
}

export function loadTrustChainWorkflows(): Array<[string, Workflow]> {
  return TRUST_CHAIN.map((f) => [f, loadWorkflow(f)] as [string, Workflow]);
}

export function rawWorkflowText(): Array<[string, string]> {
  return workflowFiles().map(
    (f) => [f, readFileSync(join(WORKFLOW_DIR, f), 'utf8')] as [string, string],
  );
}

/** Normalises a `permissions:` value to a map; `{}` for the empty-object form. */
export function permissionMap(perms: Job['permissions']): Record<string, string> | null {
  if (perms === undefined) return null;
  if (typeof perms === 'string') return { __scalar__: perms };
  return perms;
}
