import { describe, expect, it } from 'vitest';
import { loadAllWorkflows, loadWorkflow } from './load-workflows.js';

const NIGHTLY = 'nightly.yml';

describe('CI 不得跑付费评测', () => {
  it('nightly.yml 没有 evaluation job，也不调用 run-evaluation.mjs', () => {
    const wf = loadWorkflow(NIGHTLY);
    expect(wf.jobs?.evaluation, 'evaluation 会打 DeepSeek，必须从 nightly 删掉').toBeUndefined();
    expect(
      Boolean((wf.on as { schedule?: unknown } | undefined)?.schedule),
      'nightly 仍应保留 schedule 给免费的 stress job',
    ).toBe(true);
    expect(wf.jobs?.stress, '免费 stress 必须还在').toBeTruthy();
    for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
      expect(
        /run-evaluation\.mjs/.test(JSON.stringify(job)),
        `${jobId} 不应调用付费评测`,
      ).toBe(false);
    }
  });

  it('没有任何 workflow job 调用 run-evaluation.mjs', () => {
    const leaks: string[] = [];
    for (const [name, wf] of loadAllWorkflows()) {
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        if (/run-evaluation\.mjs/.test(JSON.stringify(job))) leaks.push(`${name} / ${jobId}`);
      }
    }
    expect(leaks, `以下 job 会烧 DeepSeek token：\n${leaks.join('\n')}`).toEqual([]);
  });
});
