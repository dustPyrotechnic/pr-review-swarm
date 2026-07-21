import { describe, expect, it } from 'vitest';
import { buildPrepareArtifact } from './prepare.js';
import { validate } from '../lib/schema-validator.js';

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
