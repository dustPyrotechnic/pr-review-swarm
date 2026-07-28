import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPrepareArtifactFromFile } from './analyze.js';
import { readAnalyzeArtifactFromFile } from './publish.js';
import type { PrepareArtifact } from './prepare.js';

/**
 * prepare → analyze 的 artifact 文件传输攻击面（对抗性测试加固计划 Task 7.3）。
 *
 * `docs/plans/2026-07-27-prepare-artifact-file-transport.md` 刚把这条链路从 job output
 * 改成文件 + upload/download-artifact，此前零覆盖。analyze 持有 DeepSeek Secret 且
 * `permissions: {}`，它对这个文件的信任是完全隐式的。
 *
 * 注意：这些用例毫秒级，放在 PR 阻塞通道而不是 nightly —— 计划把它们归在 Phase 7 下，
 * 但归在那里的理由是"跑得慢"，而这一组并不慢。
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'artifact-attack-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);

function write(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content);
  return p;
}

function validArtifact(): PrepareArtifact {
  return {
    identity_tuple: {
      head_repo: 'octo/head-repo',
      head_sha: 'headsha123',
      base_repo: 'octo/repo',
      base_ref: 'main',
      base_sha: 'basesha456',
      merge_base_sha: 'mergebasesha789',
    },
    shards: [
      {
        id: 'shard-1',
        files: [
          {
            path: 'src/foo.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ type: 'add', newLine: 1, content: 'const x = 1;' }],
              },
            ],
            contextRefs: [],
            contextContents: {},
          },
        ],
      },
    ],
    coverage_manifest: {
      files: [
        { path: 'src/foo.ts', treatment: 'reviewed', shard_id: 'shard-1', status: 'success' },
      ],
      shards_complete: true,
      hard_limit_hit: false,
      pulls_files_pagination_truncated: false,
      missing_patch_files: [],
      token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
  };
}

describe('prepare artifact 读取：不可信文件必须被拒绝，而不是静默继续', () => {
  it('前置健全性：合法 artifact 能正常读出来', () => {
    const p = write('ok.json', JSON.stringify(validArtifact()));
    const artifact = readPrepareArtifactFromFile(p);
    expect(artifact.shards).toHaveLength(1);
  });

  it('文件不存在 → 明确失败，不静默按空输入继续', () => {
    expect(() => readPrepareArtifactFromFile(file('missing.json'))).toThrow(/prepare.artifact/i);
  });

  it('空文件 / 0 字节 → 拒绝', () => {
    const p = write('empty.json', '');
    expect(() => readPrepareArtifactFromFile(p)).toThrow();
  });

  it.each([
    ['截断的 JSON', '{"identity_tuple":{'],
    ['非 JSON 文本', 'not json at all'],
    ['只有空白', '   \n\t  '],
    ['BOM 前缀', '﻿{"shards":[]}'],
  ])('%s → 拒绝且错误信息可定位', (_label, content) => {
    const p = write('bad.json', content);
    expect(() => readPrepareArtifactFromFile(p)).toThrow(/prepare.artifact/i);
  });

  it.each([
    ['顶层是数组', '[]'],
    ['顶层是字符串', '"hello"'],
    ['顶层是 null', 'null'],
    ['缺 shards', JSON.stringify({ identity_tuple: {}, coverage_manifest: {} })],
    ['缺 coverage_manifest', JSON.stringify({ identity_tuple: {}, shards: [] })],
    ['多出未知字段', JSON.stringify({ ...validArtifact(), __injected: 'x' })],
  ])('合法 JSON 但 schema 不符（%s）→ 拒绝', (_label, content) => {
    const p = write('schema-bad.json', content);
    expect(() => readPrepareArtifactFromFile(p)).toThrow(/schema/i);
  });

  it('超过大小上限 → 在解析**前**按大小拒绝（一个 1GB 的文件不能先被读进内存）', () => {
    const p = write('big.json', JSON.stringify(validArtifact()));
    expect(() => readPrepareArtifactFromFile(p, { maxBytes: 10 })).toThrow(/大小|size|bytes/i);
  });

  it('大小上限的错误发生在读文件之前（用一个必然解析失败的内容验证）', () => {
    // 内容是非法 JSON：如果实现先读再判大小，抛出的会是 JSON 解析错误而不是大小错误。
    const p = write('big-invalid.json', 'x'.repeat(5000));
    expect(() => readPrepareArtifactFromFile(p, { maxBytes: 100 })).toThrow(/大小|size|bytes/i);
  });

  it('指向仓库外文件的符号链接：内容仍要过完整校验，不因来源特殊而放行', () => {
    // download-artifact 解包出的符号链接是真实存在的攻击形态。这里不试图阻止读软链
    // （Node 会透明跟随），而是断言"跟随之后的内容照样要过 schema"。
    const target = write('outside.txt', 'root:x:0:0:root:/root:/bin/bash');
    const link = file('link.json');
    symlinkSync(target, link);

    expect(() => readPrepareArtifactFromFile(link)).toThrow(/prepare.artifact|schema/i);
  });

  it('内容合法但含恶意 finding 路径时，读取层不做业务判断（由下游确定性校验负责）', () => {
    // 明确边界：artifact 读取层只保证"结构合法"，不保证"内容可信"。
    // 完整性校验不是信任证明——路径/行号仍要走 deterministic-evidence-validator。
    const artifact = validArtifact();
    artifact.shards[0]!.files[0]!.path = '../../etc/passwd';
    const p = write('malicious-path.json', JSON.stringify(artifact));

    const parsed = readPrepareArtifactFromFile(p);
    expect(parsed.shards[0]!.files[0]!.path).toBe('../../etc/passwd');
  });
});

describe('analyze artifact 读取（publish 侧）', () => {
  it('文件不存在 → 返回 undefined（analyze 被跳过是正常路径，不是错误）', () => {
    expect(readAnalyzeArtifactFromFile(file('missing.json'))).toBeUndefined();
  });

  it('文件存在但内容非法 → 拒绝，而不是当成"零 finding"继续发布', () => {
    // 这是最危险的静默失败：损坏的 artifact 被当成"什么问题都没有"，
    // 于是发出一个 pass 的 COMMENT。
    const p = write('broken.json', '{"findings":');
    expect(() => readAnalyzeArtifactFromFile(p)).toThrow(/analyze.artifact/i);
  });

  it.each([
    ['顶层是数组', '[]'],
    ['缺 findings', JSON.stringify({ coverage_manifest: {} })],
    ['findings 不是数组', JSON.stringify({ findings: 'none', coverage_manifest: {} })],
  ])('schema 不符（%s）→ 拒绝', (_label, content) => {
    const p = write('bad.json', content);
    expect(() => readAnalyzeArtifactFromFile(p)).toThrow(/schema|analyze.artifact/i);
  });
});
