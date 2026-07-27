import { describe, expect, it } from 'vitest';
import {
  loadAllWorkflows,
  loadTrustChainWorkflows,
  loadWorkflow,
  permissionMap,
  type Job,
} from './load-workflows.js';

const REVIEW = 'reusable-pr-review.yml';
const CALLER = 'pr-review-caller.yml';
const WATCHDOG = 'reusable-pr-review-watchdog.yml';

/**
 * Jobs allowed to hold `checks: write`. The Check Run is the authoritative
 * gate, so the set of identities that can write it is a security property:
 * only the two status jobs and the watchdog may move it.
 */
const CHECKS_WRITE_JOBS = new Set(['status-start', 'status-finalize', 'watchdog']);

function jobsOf(name: string): Array<[string, Job]> {
  return Object.entries(loadWorkflow(name).jobs ?? {});
}

describe('Job 权限隔离（设计文档「权限与安全边界」/ docs/AGENTS.md 硬禁令 3、4、6）', () => {
  it('信任链 workflow 的每个 job 都显式声明 permissions（禁止继承默认权限）', () => {
    const missing: string[] = [];
    for (const [name, wf] of loadTrustChainWorkflows()) {
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        if (job.permissions === undefined) missing.push(`${name} / ${jobId}`);
      }
    }
    expect(missing, `以下 job 缺少显式 permissions：\n${missing.join('\n')}`).toEqual([]);
  });

  it('所有 workflow 至少在 workflow 或 job 级声明 permissions，没有一个吃默认权限', () => {
    const implicit: string[] = [];
    for (const [name, wf] of loadAllWorkflows()) {
      if (wf.permissions !== undefined) continue;
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        if (job.permissions === undefined) implicit.push(`${name} / ${jobId}`);
      }
    }
    expect(implicit, `以下 job 使用了仓库默认权限：\n${implicit.join('\n')}`).toEqual([]);
  });

  it('analyze 的 permissions 为空对象，不含任何 GitHub 权限（含 contents: read）', () => {
    const analyze = loadWorkflow(REVIEW).jobs!['analyze'];
    expect(analyze).toBeDefined();
    expect(analyze.permissions).toEqual({});
  });

  it('publish 不持有 checks: write，也不注入 DeepSeek Secret', () => {
    const publish = loadWorkflow(REVIEW).jobs!['publish'];
    const perms = permissionMap(publish.permissions)!;
    expect(perms.checks).toBeUndefined();
    expect(JSON.stringify(publish)).not.toMatch(/DEEPSEEK/i);
  });

  it('publish 只持有 contents:read / pull-requests:write / issues:write', () => {
    const perms = permissionMap(loadWorkflow(REVIEW).jobs!['publish'].permissions)!;
    expect(perms).toEqual({
      contents: 'read',
      'pull-requests': 'write',
      issues: 'write',
    });
  });

  it('reusable-pr-review.yml 里只有 analyze 能看到 DEEPSEEK_API_KEY', () => {
    for (const [jobId, job] of jobsOf(REVIEW)) {
      if (jobId === 'analyze') continue;
      expect(JSON.stringify(job), `${jobId} 不应出现 DEEPSEEK`).not.toMatch(/DEEPSEEK/i);
    }
    expect(JSON.stringify(loadWorkflow(REVIEW).jobs!['analyze'])).toMatch(/DEEPSEEK_API_KEY/);
  });

  it('watchdog workflow 完全看不到 DEEPSEEK_API_KEY', () => {
    expect(JSON.stringify(loadWorkflow(WATCHDOG))).not.toMatch(/DEEPSEEK/i);
  });

  it('没有任何 job 申请 contents: write（机器人不合并，硬禁令：不调用 merge API）', () => {
    for (const [name, wf] of loadAllWorkflows()) {
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        const perms = permissionMap(job.permissions);
        if (perms) {
          expect(perms.contents, `${name}/${jobId}`).not.toBe('write');
          expect(perms.__scalar__, `${name}/${jobId} 使用了 write-all`).not.toBe('write-all');
        }
      }
      const top = permissionMap(wf.permissions);
      if (top) {
        expect(top.contents, `${name} (workflow 级)`).not.toBe('write');
        expect(top.__scalar__, `${name} (workflow 级) 使用了 write-all`).not.toBe('write-all');
      }
    }
  });

  it('实际执行的 job 中，checks: write 只出现在 status-start / status-finalize / watchdog', () => {
    for (const [name, wf] of loadAllWorkflows()) {
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        // `uses:` 壳 job 不自己执行任何步骤，它必须声明被调用 workflow 所需权限的并集，
        // 由下面那条"壳 job 权限 == 被调用方并集"的用例单独约束。
        if (job.uses) continue;
        const perms = permissionMap(job.permissions);
        if (perms?.checks === 'write') {
          expect(CHECKS_WRITE_JOBS.has(jobId), `${name}/${jobId} 不应持有 checks: write`).toBe(
            true,
          );
        }
      }
    }
  });

  it('caller 的壳 job 权限恰好等于被调用 workflow 各 job 权限的并集（不过度授权）', () => {
    const caller = loadWorkflow(CALLER);
    const cases: Array<[string, string]> = [
      ['review', REVIEW],
      ['watchdog', WATCHDOG],
    ];
    for (const [shellJobId, calleeFile] of cases) {
      const shell = caller.jobs![shellJobId];
      expect(shell, `${CALLER} 缺少 ${shellJobId} job`).toBeDefined();
      expect(shell.uses, `${shellJobId} 应该是调用 reusable workflow 的壳 job`).toBeDefined();

      const union: Record<string, string> = {};
      for (const job of Object.values(loadWorkflow(calleeFile).jobs ?? {})) {
        for (const [scope, level] of Object.entries(permissionMap(job.permissions) ?? {})) {
          // write 胜过 read
          if (union[scope] !== 'write') union[scope] = level;
        }
      }
      expect(
        permissionMap(shell.permissions),
        `${CALLER}/${shellJobId} 的权限与 ${calleeFile} 所需并集不符——多出来的都是越权`,
      ).toEqual(union);
    }
  });
});
