import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrepareArtifact, writePrepareArtifactToFile } from './prepare.js';
import { validate } from '../lib/schema-validator.js';
import type { RepoTreeEntry } from '../lib/context-resolver.js';

const identityTuple = {
  headRepo: 'octo/head-repo',
  headSha: 'headsha123',
  baseRepo: 'octo/repo',
  baseRef: 'main',
  baseSha: 'basesha456',
  mergeBaseSha: 'mergebasesha789',
};

const generousLimits = {
  maxPrFilesPerPage: 3000,
  maxFilesPerShard: 100,
  maxBytesPerShard: 100_000,
  maxShards: 100,
};

const emptyRepoConfig = { ignore_globs: [], generated_globs: [] };

describe('buildPrepareArtifact', () => {
  it('builds a valid single-shard artifact for one reviewable file with a patch', () => {
    const result = buildPrepareArtifact({
      identityTuple,
      files: [{ filename: 'src/foo.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' }],
      fullFileContents: { 'src/foo.ts': 'a\nb\n' },
      tree: [{ path: 'src/foo.ts', sha: 'sha-foo', type: 'blob' }],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    expect(result.incomplete).toBe(false);
    expect(result.artifact.shards).toHaveLength(1);
    expect(result.artifact.shards[0]?.files[0]?.path).toBe('src/foo.ts');
    expect(result.artifact.shards[0]?.files[0]?.hunks).toHaveLength(1);
    expect(result.artifact.coverage_manifest.files).toContainEqual(
      expect.objectContaining({ path: 'src/foo.ts', treatment: 'reviewed', status: 'success' }),
    );

    const validation = validate('https://pr-review-swarm/schemas/prepare-artifact.schema.json', result.artifact);
    expect(validation.valid).toBe(true);
  });

  it('classifies a binary file as skipped and excludes it from shards', () => {
    const result = buildPrepareArtifact({
      identityTuple,
      files: [{ filename: 'assets/logo.png', status: 'added' }],
      fullFileContents: {},
      tree: [{ path: 'assets/logo.png', sha: 'sha-logo', type: 'blob' }],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    expect(result.artifact.shards.flatMap((s) => s.files).some((f) => f.path === 'assets/logo.png')).toBe(
      false,
    );
    expect(result.artifact.coverage_manifest.files).toContainEqual(
      expect.objectContaining({ path: 'assets/logo.png', treatment: 'skipped_binary', status: 'success' }),
    );
    expect(result.incomplete).toBe(false);
  });

  it('marks incomplete and records missing_patch_files for a reviewable file with no patch', () => {
    const result = buildPrepareArtifact({
      identityTuple,
      files: [{ filename: 'src/huge.ts', status: 'modified' }],
      fullFileContents: {},
      tree: [{ path: 'src/huge.ts', sha: 'sha-huge', type: 'blob' }],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    expect(result.incomplete).toBe(true);
    expect(result.artifact.coverage_manifest.missing_patch_files).toEqual(['src/huge.ts']);
  });

  it('flags pulls_files_pagination_truncated and incomplete when the file count reaches the page limit', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      patch: '@@ -1,1 +1,1 @@\n-a\n+b',
    }));

    const result = buildPrepareArtifact({
      identityTuple,
      files,
      fullFileContents: {},
      tree: files.map((f) => ({ path: f.filename, sha: `sha-${f.filename}`, type: 'blob' as const })),
      repoConfig: emptyRepoConfig,
      limits: { ...generousLimits, maxPrFilesPerPage: 3 },
    });

    expect(result.artifact.coverage_manifest.pulls_files_pagination_truncated).toBe(true);
    expect(result.artifact.coverage_manifest.hard_limit_hit).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it('marks shards_complete false and a file status failed when sharding hits maxShards', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((filename) => ({
      filename,
      status: 'modified',
      patch: '@@ -1,1 +1,1 @@\n-x\n+y',
    }));

    const result = buildPrepareArtifact({
      identityTuple,
      files,
      fullFileContents: {},
      tree: files.map((f) => ({ path: f.filename, sha: `sha-${f.filename}`, type: 'blob' as const })),
      repoConfig: emptyRepoConfig,
      limits: { ...generousLimits, maxFilesPerShard: 1, maxShards: 1 },
    });

    expect(result.artifact.coverage_manifest.shards_complete).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.artifact.coverage_manifest.files.some((f) => f.status === 'failed')).toBe(true);
  });

  it('attaches resolved context refs to the file entry within its shard', () => {
    const result = buildPrepareArtifact({
      identityTuple,
      files: [{ filename: 'src/foo.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }],
      fullFileContents: { 'src/foo.ts': "import { helper } from './bar';\n" },
      tree: [
        { path: 'src/foo.ts', sha: 'sha-foo', type: 'blob' },
        { path: 'src/bar.ts', sha: 'sha-bar', type: 'blob' },
      ],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    const fileEntry = result.artifact.shards[0]?.files[0];
    expect(fileEntry?.contextRefs).toContainEqual({
      path: 'src/bar.ts',
      reason: 'same_directory_import',
      sha: 'sha-bar',
    });
  });

  it('embeds the content of each context ref inline, since analyze cannot fetch anything itself', () => {
    const result = buildPrepareArtifact({
      identityTuple,
      files: [{ filename: 'src/foo.ts', status: 'modified', patch: '@@ -1,1 +1,1 @@\n-a\n+b' }],
      fullFileContents: {
        'src/foo.ts': "import { helper } from './bar';\n",
        'src/bar.ts': 'export function helper() {}\n',
      },
      tree: [
        { path: 'src/foo.ts', sha: 'sha-foo', type: 'blob' },
        { path: 'src/bar.ts', sha: 'sha-bar', type: 'blob' },
      ],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    const fileEntry = result.artifact.shards[0]?.files[0];
    expect(fileEntry?.contextContents['src/bar.ts']).toBe('export function helper() {}\n');
    expect(fileEntry?.contextContents['src/foo.ts']).toBe("import { helper } from './bar';\n");
  });

  it('redacts secrets found in a patch before it is parsed into hunks', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = buildPrepareArtifact({
      identityTuple,
      files: [
        { filename: 'src/foo.ts', status: 'modified', patch: `@@ -1,1 +1,1 @@\n-old\n+${token}` },
      ],
      fullFileContents: {},
      tree: [{ path: 'src/foo.ts', sha: 'sha-foo', type: 'blob' }],
      repoConfig: emptyRepoConfig,
      limits: generousLimits,
    });

    const hunkContents = result.artifact.shards[0]?.files[0]?.hunks.flatMap((h) =>
      h.lines.map((l) => l.content),
    );
    expect(hunkContents?.join('\n')).not.toContain(token);
  });
});

describe('writePrepareArtifactToFile', () => {
  it('writes the artifact as JSON to the given path, round-trippable via JSON.parse', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prepare-artifact-'));
    try {
      const filePath = path.join(dir, 'prepare-artifact.json');
      const artifact = {
        identity_tuple: {
          head_repo: 'octo/head-repo',
          head_sha: 'headsha123',
          base_repo: 'octo/repo',
          base_ref: 'main',
          base_sha: 'basesha456',
          merge_base_sha: 'mergebasesha789',
        },
        shards: [],
        coverage_manifest: {
          files: [],
          shards_complete: true,
          hard_limit_hit: false,
          pulls_files_pagination_truncated: false,
          missing_patch_files: [],
          token_usage: { prompt_tokens: 0, completion_tokens: 0 },
        },
      };

      writePrepareArtifactToFile(artifact, filePath);

      const written = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(written).toEqual(artifact);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 覆盖清单守恒（对抗性测试加固计划 Task 4.1）
//
// 这是防"静默漏审"最有力的单条不变式：PR 变更的每一个文件都必须在覆盖清单里留下记录，
// 要么被审了，要么写明为什么没审。一个文件都不能凭空消失。
// ---------------------------------------------------------------------------

const SKIPPED_TREATMENTS = [
  'skipped_binary',
  'skipped_generated',
  'skipped_vendor',
  'skipped_lockfile',
  'skipped_budget',
];

/** 覆盖普通修改、新增、删除、重命名、二进制、生成文件、lockfile、vendor、空文件、只改 mode、submodule、symlink。 */
function diverseFiles(): Array<{ filename: string; status: string; patch?: string }> {
  const patch = '@@ -1,1 +1,2 @@\n a\n+b';
  const files: Array<{ filename: string; status: string; patch?: string }> = [
    { filename: 'src/modified.ts', status: 'modified', patch },
    { filename: 'src/added.ts', status: 'added', patch: '@@ -0,0 +1,1 @@\n+a' },
    { filename: 'src/removed.ts', status: 'removed', patch: '@@ -1,1 +0,0 @@\n-a' },
    { filename: 'src/renamed-new.ts', status: 'renamed', patch },
    { filename: 'assets/logo.png', status: 'added' },
    { filename: 'assets/photo.jpg', status: 'modified' },
    { filename: 'src/generated.pb.go', status: 'modified', patch },
    { filename: 'package-lock.json', status: 'modified', patch },
    { filename: 'pnpm-lock.yaml', status: 'modified', patch },
    { filename: 'vendor/dep/index.js', status: 'modified', patch },
    { filename: 'src/empty.ts', status: 'added', patch: '@@ -0,0 +0,0 @@' },
    { filename: 'src/mode-only.sh', status: 'changed' },
    { filename: 'third_party/sub', status: 'modified' },
    { filename: 'src/link.ts', status: 'added' },
  ];
  // 补到 40 个普通文件，确保规模够大、跨多个分片。
  for (let i = files.length; i < 40; i += 1) {
    files.push({ filename: `src/bulk/file-${i}.ts`, status: 'modified', patch });
  }
  return files;
}

const diverseRepoConfig = { ignore_globs: [], generated_globs: ['**/*.pb.go'] };

function buildDiverse(
  overrides: Partial<{
    files: Array<{ filename: string; status: string; patch?: string }>;
    limits: { maxPrFilesPerPage: number; maxFilesPerShard: number; maxBytesPerShard: number; maxShards: number };
  }> = {},
) {
  const files = overrides.files ?? diverseFiles();
  const fullFileContents: Record<string, string> = {};
  const tree: RepoTreeEntry[] = [];
  for (const f of files) {
    fullFileContents[f.filename] = 'a\nb\n';
    tree.push({ path: f.filename, sha: `sha-${f.filename}`, type: 'blob' });
  }
  return buildPrepareArtifact({
    identityTuple,
    files,
    fullFileContents,
    tree,
    repoConfig: diverseRepoConfig,
    limits: overrides.limits ?? generousLimits,
  });
}

describe('覆盖清单守恒', () => {
  it('变更文件集合 == 覆盖清单记录的文件集合（一个都不能少、一个都不能多）', () => {
    const files = diverseFiles();
    const result = buildDiverse({ files });

    const inputPaths = [...new Set(files.map((f) => f.filename))].sort();
    const manifestPaths = [...new Set(result.artifact.coverage_manifest.files.map((f) => f.path))].sort();

    expect(manifestPaths).toEqual(inputPaths);
  });

  it('覆盖清单里没有重复条目（同一文件只登记一次）', () => {
    const manifest = buildDiverse().artifact.coverage_manifest;
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it('每个被跳过的文件都有非空的 skip_reason', () => {
    const manifest = buildDiverse().artifact.coverage_manifest;
    const skipped = manifest.files.filter((f) => SKIPPED_TREATMENTS.includes(f.treatment));

    expect(skipped.length, '语料里应当确实包含被跳过的文件，否则这条断言什么都没测到').toBeGreaterThan(0);
    for (const entry of skipped) {
      expect(entry.skip_reason, `${entry.path} (${entry.treatment}) 缺少 skip_reason`).toBeTruthy();
    }
  });

  it('每个被审的文件都记录了所属分片，且该分片确实包含它', () => {
    const result = buildDiverse();
    const reviewed = result.artifact.coverage_manifest.files.filter((f) => f.treatment === 'reviewed');
    expect(reviewed.length).toBeGreaterThan(0);

    const shardById = new Map(result.artifact.shards.map((s) => [s.id, s]));
    for (const entry of reviewed) {
      expect(entry.shard_id, `${entry.path} 没记录 shard_id`).toBeTruthy();
      const shard = shardById.get(entry.shard_id);
      expect(shard, `${entry.path} 的 shard_id=${entry.shard_id} 不存在`).toBeDefined();
      expect(
        shard!.files.map((f) => f.path),
        `${entry.path} 声称属于 ${entry.shard_id}，但该分片里没有它`,
      ).toContain(entry.path);
    }
  });

  it('分片里出现的每个文件都在覆盖清单里有对应条目（反向守恒）', () => {
    const result = buildDiverse();
    const manifestPaths = new Set(result.artifact.coverage_manifest.files.map((f) => f.path));
    for (const shard of result.artifact.shards) {
      for (const file of shard.files) {
        expect(manifestPaths, `分片 ${shard.id} 里的 ${file.path} 不在覆盖清单里`).toContain(file.path);
      }
    }
  });

  it('任一文件缺 patch → incomplete，而不是把它从清单里悄悄去掉', () => {
    const files = [
      { filename: 'src/ok.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
      { filename: 'src/no-patch.ts', status: 'modified' },
    ];
    const result = buildDiverse({ files });

    expect(result.incomplete).toBe(true);
    expect(result.artifact.coverage_manifest.files.map((f) => f.path)).toContain('src/no-patch.ts');
  });

  it('repo-config ignore_globs 命中的文件仍留在清单里并带 skip_reason（不是凭空消失）', () => {
    const files = [
      { filename: 'src/ok.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
      { filename: 'docs/notes.md', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    ];
    const result = buildPrepareArtifact({
      identityTuple,
      files,
      fullFileContents: { 'src/ok.ts': 'a\nb\n', 'docs/notes.md': 'a\nb\n' },
      tree: [
        { path: 'src/ok.ts', sha: 's1', type: 'blob' as const },
        { path: 'docs/notes.md', sha: 's2', type: 'blob' as const },
      ],
      repoConfig: { ignore_globs: ['docs/**'], generated_globs: [] },
      limits: generousLimits,
    });

    const entry = result.artifact.coverage_manifest.files.find((f) => f.path === 'docs/notes.md');
    expect(entry, '被 ignore_globs 命中的文件不能从覆盖清单里消失').toBeDefined();
    expect(entry!.skip_reason).toContain('ignore_globs');
  });

  it('命中分片预算上限时被挤掉的文件仍留在清单里（标记 skipped_budget，不静默丢弃）', () => {
    const files = diverseFiles();
    const result = buildDiverse({
      files,
      limits: { maxPrFilesPerPage: 3000, maxFilesPerShard: 2, maxBytesPerShard: 100, maxShards: 1 },
    });

    const manifestPaths = [...new Set(result.artifact.coverage_manifest.files.map((f) => f.path))].sort();
    expect(manifestPaths).toEqual([...new Set(files.map((f) => f.filename))].sort());
    expect(result.incomplete).toBe(true);
  });
});
