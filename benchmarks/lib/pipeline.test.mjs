import { describe, expect, it } from 'vitest';
import { loadPipeline } from './pipeline.mjs';

/**
 * 这一组是评测的"接线正确"守卫。评测跑绿但其实加载的是空模块、或 skills 目录
 * 解析到仓库外面（于是每个 agent 都没装备任何 checklist），从指标上完全看不出来
 * ——只会表现为召回率莫名偏低。
 */
describe('loadPipeline', () => {
  it('导出 analyze 管线的真实实现', async () => {
    const p = await loadPipeline();

    expect(typeof p.runAnalysis).toBe('function');
    expect(typeof p.parsePatch).toBe('function');
    expect(typeof p.shardFiles).toBe('function');
    expect(typeof p.createDeepSeekClient).toBe('function');
    expect(typeof p.readIndexMd).toBe('function');
  }, 60_000);

  it('parsePatch 是生产实现：行号按新文件侧计算', async () => {
    const { parsePatch } = await loadPipeline();
    const parsed = parsePatch('a.go', ['@@ -1,2 +1,3 @@', ' package main', ' ', '+func X() {}'].join('\n'));

    expect(parsed.hunks).toHaveLength(1);
    const added = parsed.hunks[0].lines.filter((l) => l.type === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].newLine).toBe(3);
  }, 60_000);

  it('skills 目录解析到仓库根的 skills/，index.md 能读到', async () => {
    const { readIndexMd } = await loadPipeline();
    const index = readIndexMd();

    // 读错目录会抛 ENOENT；读到空文件则所有 agent 都不装备 checklist。
    expect(index.length).toBeGreaterThan(0);
    expect(index).toContain('generic-correctness');
  }, 60_000);

  it('loadSkill 能取到三个 generic agent 的正文', async () => {
    const { loadSkill } = await loadPipeline();

    for (const name of ['generic-correctness', 'generic-security', 'generic-maintainability']) {
      const skill = loadSkill(name);
      expect(skill.body.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('centralLimits 带出真实的硬上限配置', async () => {
    const { centralLimits } = await loadPipeline();

    expect(centralLimits.maxCandidateFindingsPerAgentPerShard).toBeGreaterThan(0);
    expect(centralLimits.maxVerifierCallsPerRun).toBeGreaterThan(0);
  }, 60_000);
});
