import { describe, expect, it } from 'vitest';
import { loadAllWorkflows, loadWorkflow, type Job, type Workflow } from './load-workflows.js';

const NIGHTLY = 'nightly.yml';

function jobCallsPaidEval(job: Job): boolean {
  const blob = JSON.stringify(job);
  return /run-evaluation\.mjs/.test(blob) || /DEEPSEEK_API_KEY/.test(blob);
}

function skipsSchedule(job: Job): boolean {
  const cond = typeof job.if === 'string' ? job.if : '';
  return (
    /github\.event_name\s*==\s*'workflow_dispatch'/.test(cond) ||
    /github\.event_name\s*!=\s*'schedule'/.test(cond)
  );
}

function hasScheduleTrigger(wf: Workflow): boolean {
  const on = wf.on as { schedule?: unknown } | undefined;
  return Boolean(on?.schedule);
}

describe('付费评测不得被 schedule 自动触发', () => {
  it('nightly.yml 的 evaluation job 在 schedule 事件下不跑', () => {
    const wf = loadWorkflow(NIGHTLY);
    const evaluation = wf.jobs?.evaluation;
    expect(evaluation, 'evaluation job 必须存在，否则这份护栏扫空了').toBeTruthy();
    expect(hasScheduleTrigger(wf), 'nightly 仍应保留 schedule 给免费的 stress job').toBe(true);
    expect(
      skipsSchedule(evaluation!),
      'schedule 会拉起整份 Nightly；evaluation 调用 DeepSeek，必须显式跳过 schedule',
    ).toBe(true);
  });

  it('没有任何会调用 DeepSeek / run-evaluation.mjs 的 job 会在 schedule 下执行', () => {
    const leaks: string[] = [];
    for (const [name, wf] of loadAllWorkflows()) {
      if (!hasScheduleTrigger(wf)) continue;
      for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
        if (jobCallsPaidEval(job) && !skipsSchedule(job)) {
          leaks.push(`${name} / ${jobId}`);
        }
      }
    }
    expect(leaks, `以下 job 会在 cron 里烧 DeepSeek token：\n${leaks.join('\n')}`).toEqual([]);
  });
});
