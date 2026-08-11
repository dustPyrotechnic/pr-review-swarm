import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCase, toPrepareArtifact } from './case-loader.mjs';

const created = [];

function makeCase(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-case-'));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true });
  }
});

const SIMPLE_DIFF = [
  'diff --git a/a.go b/a.go',
  'index 1..2 100644',
  '--- a/a.go',
  '+++ b/a.go',
  '@@ -1,2 +1,3 @@',
  ' package main',
  ' ',
  '+func Leak() {}',
  '',
].join('\n');

const SIMPLE_EXPECTED = JSON.stringify([
  { path: 'a.go', line: 3, category: 'correctness', must_find: true },
]);

describe('loadCase', () => {
  it('读出 diff、expected 与可选的 PR 描述', () => {
    const dir = makeCase({
      'diff.patch': SIMPLE_DIFF,
      'expected-findings.json': SIMPLE_EXPECTED,
      'pr-description.md': '修个 bug',
    });

    const c = loadCase(dir);

    expect(c.name).toBe(dir.split('/').pop());
    expect(c.files).toHaveLength(1);
    expect(c.files[0].path).toBe('a.go');
    expect(c.expected).toHaveLength(1);
    expect(c.prDescription).toBe('修个 bug');
  });

  it('没有 pr-description.md 时为空串而不是 undefined', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
    expect(loadCase(dir).prDescription).toBe('');
  });

  it('读取 context/ 下的全文作为 verifier 上下文', () => {
    const dir = makeCase({
      'diff.patch': SIMPLE_DIFF,
      'expected-findings.json': SIMPLE_EXPECTED,
      'context/a.go': 'package main\n\nfunc Leak() {}\n',
    });

    const c = loadCase(dir);
    expect(c.contextContents['a.go']).toContain('func Leak()');
  });

  it('缺 diff.patch 直接报错，而不是当成空 diff 跑出 0 召回', () => {
    const dir = makeCase({ 'expected-findings.json': SIMPLE_EXPECTED });
    expect(() => loadCase(dir)).toThrow(/diff\.patch/);
  });

  it('缺 expected-findings.json 直接报错', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF });
    expect(() => loadCase(dir)).toThrow(/expected-findings\.json/);
  });

  it('expected 不是数组时报错', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': '{}' });
    expect(() => loadCase(dir)).toThrow(/数组/);
  });

  it('expected 缺必填字段时报错并指出是哪一条', () => {
    const dir = makeCase({
      'diff.patch': SIMPLE_DIFF,
      'expected-findings.json': JSON.stringify([{ path: 'a.go', line: 3 }]),
    });
    expect(() => loadCase(dir)).toThrow(/\[0\]/);
  });

  it('expected 里的 path 必须真的出现在 diff 里', () => {
    const dir = makeCase({
      'diff.patch': SIMPLE_DIFF,
      'expected-findings.json': JSON.stringify([
        { path: 'nope.go', line: 3, category: 'correctness', must_find: true },
      ]),
    });
    // 打错文件名的 expected 会让该条永远无法命中，表现为"模型漏报"，
    // 实际是 fixture 写错了。这类错误必须在加载期就炸掉。
    expect(() => loadCase(dir)).toThrow(/nope\.go/);
  });
});

describe('toPrepareArtifact', () => {
  const deps = {
    parsePatch: (path, patch) => ({
      path,
      hunks: patch === '' ? [] : [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [] }],
    }),
    shardFiles: (files) => ({ shards: [{ id: 'shard-1', files: files.map((f) => f.path) }] }),
    classifyFile: ({ filename }) =>
      filename.endsWith('.png')
        ? { treatment: 'skipped_binary', skipReason: 'binary' }
        : { treatment: 'reviewed' },
    limits: { maxFilesPerShard: 20, maxBytesPerShard: 100000, maxShards: 5 },
  };

  it.each(['parsePatch', 'shardFiles', 'classifyFile'])(
    '缺少依赖 %s 时直接报错，而不是静默降级',
    (missing) => {
      const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
      const broken = { ...deps };
      delete broken[missing];

      // classifyFile 若有「全按 reviewed 处理」的兜底，lockfile / vendor /
      // 生成文件那几条误报陷阱用例会悄悄失效，而指标看着一切正常。
      expect(() => toPrepareArtifact(loadCase(dir), broken)).toThrow(new RegExp(missing));
    },
  );

  it('产出的结构含 identity_tuple / shards / coverage_manifest', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
    const artifact = toPrepareArtifact(loadCase(dir), deps);

    expect(artifact.identity_tuple).toBeDefined();
    expect(artifact.shards).toHaveLength(1);
    expect(artifact.shards[0].files[0].path).toBe('a.go');
    expect(artifact.coverage_manifest.files.map((f) => f.path)).toEqual(['a.go']);
  });

  it('coverage_manifest 初始为「完整、未截断」', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
    const artifact = toPrepareArtifact(loadCase(dir), deps);
    const cm = artifact.coverage_manifest;

    // 评测输入必须是干净的：若这里预置了 hard_limit_hit=true，
    // 整轮评测都会被判 incomplete，指标全部失真。
    expect(cm.hard_limit_hit).toBe(false);
    expect(cm.shards_complete).toBe(true);
    expect(cm.pulls_files_pagination_truncated).toBe(false);
    expect(cm.missing_patch_files).toEqual([]);
  });

  it('identity_tuple 随 case 名变化，避免不同用例互相当成同一次审核', () => {
    const d1 = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
    const d2 = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });

    const a1 = toPrepareArtifact(loadCase(d1), deps);
    const a2 = toPrepareArtifact(loadCase(d2), deps);

    expect(a1.identity_tuple.head_sha).not.toBe(a2.identity_tuple.head_sha);
  });

  it('context 缺失时 contextContents 为空对象而不是 undefined', () => {
    const dir = makeCase({ 'diff.patch': SIMPLE_DIFF, 'expected-findings.json': SIMPLE_EXPECTED });
    const artifact = toPrepareArtifact(loadCase(dir), deps);
    expect(artifact.shards[0].files[0].contextContents).toEqual({});
  });

  it('二进制文件（无 hunk）不进 shard，但在 coverage_manifest 里留痕', () => {
    const dir = makeCase({
      'diff.patch': [
        SIMPLE_DIFF,
        'diff --git a/logo.png b/logo.png',
        'index 1..2 100644',
        'Binary files a/logo.png and b/logo.png differ',
        '',
      ].join('\n'),
      'expected-findings.json': SIMPLE_EXPECTED,
    });

    const artifact = toPrepareArtifact(loadCase(dir), deps);

    expect(artifact.shards[0].files.map((f) => f.path)).toEqual(['a.go']);
    // 文件不能凭空消失（对应 Task 4.1 的覆盖清单守恒）。
    const entry = artifact.coverage_manifest.files.find((f) => f.path === 'logo.png');
    expect(entry).toBeDefined();
    expect(entry.treatment).toBe('skipped_binary');
  });
});
