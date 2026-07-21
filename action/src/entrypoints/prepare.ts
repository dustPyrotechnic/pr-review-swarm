import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import {
  fetchIdentityTuple,
  identityTuplesEqual,
  toSchemaIdentityTuple,
  type IdentityTuple,
  type SchemaIdentityTuple,
} from '../lib/identity-tuple.js';
import { loadRepoConfig } from '../lib/repo-config.js';
import { getOctokitFromInput } from '../lib/github-client.js';
import { fetchFileContent } from '../lib/github-content.js';
import { checkPaginationGuard, type PrFileRef } from '../lib/pr-files-pagination-guard.js';
import { classifyFile, type FileTreatment } from '../lib/file-classifier.js';
import { parsePatch, type DiffHunk } from '../lib/diff-parser.js';
import { resolveContext, type RepoTreeEntry, type ContextFileRef } from '../lib/context-resolver.js';
import { scanAndRedactSecrets } from '../lib/secret-scanner.js';
import { shardFiles, type ShardInput } from '../lib/sharding.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface PrepareShardFile {
  path: string;
  hunks: DiffHunk[];
  contextRefs: ContextFileRef[];
  contextContents: Record<string, string>;
}

export interface PrepareShard {
  id: string;
  files: PrepareShardFile[];
}

export interface CoverageManifestFileEntry {
  path: string;
  treatment: FileTreatment;
  shard_id: string;
  status: 'success' | 'failed';
  skip_reason?: string;
}

export interface CoverageManifest {
  files: CoverageManifestFileEntry[];
  shards_complete: boolean;
  hard_limit_hit: boolean;
  pulls_files_pagination_truncated: boolean;
  missing_patch_files: string[];
  token_usage: { prompt_tokens: number; completion_tokens: number };
}

export interface PrepareArtifact {
  identity_tuple: SchemaIdentityTuple;
  shards: PrepareShard[];
  coverage_manifest: CoverageManifest;
}

export interface PrepareCoreInput {
  identityTuple: IdentityTuple;
  files: Array<PrFileRef & { status: string }>;
  fullFileContents: Record<string, string>;
  tree: RepoTreeEntry[];
  repoConfig: { ignore_globs: string[]; generated_globs: string[] };
  limits: {
    maxPrFilesPerPage: number;
    maxFilesPerShard: number;
    maxBytesPerShard: number;
    maxShards: number;
  };
}

export interface PrepareCoreResult {
  incomplete: boolean;
  artifact: PrepareArtifact;
}

export function buildPrepareArtifact(input: PrepareCoreInput): PrepareCoreResult {
  const paginationResult = checkPaginationGuard(input.files, input.limits.maxPrFilesPerPage);

  const classifications = new Map(
    input.files.map((f) => [f.filename, classifyFile({ filename: f.filename }, input.repoConfig)]),
  );

  const reviewableFiles = input.files.filter(
    (f) => classifications.get(f.filename)!.treatment === 'reviewed',
  );

  const missingPatchForReviewable = paginationResult.missingPatchFiles.filter((name) =>
    reviewableFiles.some((f) => f.filename === name),
  );

  const contextRefsByFile = new Map<string, ContextFileRef[]>();
  for (const file of reviewableFiles) {
    const refs = resolveContext({
      changedFilePaths: [file.filename],
      changedFileContents: { [file.filename]: input.fullFileContents[file.filename] ?? '' },
      tree: input.tree,
    });
    contextRefsByFile.set(file.filename, refs);
  }

  const shardSizeInputs: ShardInput[] = reviewableFiles.map((f) => ({
    path: f.filename,
    sizeBytes: Buffer.byteLength(f.patch ?? input.fullFileContents[f.filename] ?? '', 'utf-8'),
  }));

  const shardingResult = shardFiles(shardSizeInputs, {
    maxFilesPerShard: input.limits.maxFilesPerShard,
    maxBytesPerShard: input.limits.maxBytesPerShard,
    maxShards: input.limits.maxShards,
  });

  const shardIdByPath = new Map<string, string>();
  for (const shard of shardingResult.shards) {
    for (const path of shard.files) {
      shardIdByPath.set(path, shard.id);
    }
  }

  const reviewableFileByPath = new Map(reviewableFiles.map((f) => [f.filename, f]));

  const shards: PrepareShard[] = shardingResult.shards.map((shard) => ({
    id: shard.id,
    files: shard.files.map((path) => {
      const file = reviewableFileByPath.get(path)!;
      const { redactedContent } = scanAndRedactSecrets(file.patch ?? '');
      const parsed = parsePatch(path, redactedContent);
      const contextRefs = contextRefsByFile.get(path) ?? [];
      const contextContents: Record<string, string> = {};
      for (const ref of contextRefs) {
        // analyze has no contents:read, so every referenced file's content must
        // already be embedded here. Only populated when the caller supplied it
        // in fullFileContents (currently: the changed files themselves — see
        // the `run()` TODO below for context-ref targets outside the diff).
        contextContents[ref.path] = scanAndRedactSecrets(
          input.fullFileContents[ref.path] ?? '',
        ).redactedContent;
      }
      return {
        path,
        hunks: parsed.hunks,
        contextRefs,
        contextContents,
      };
    }),
  }));

  const manifestFiles: CoverageManifestFileEntry[] = input.files.map((f) => {
    const classification = classifications.get(f.filename)!;
    const shardId = shardIdByPath.get(f.filename);
    const isReviewable = classification.treatment === 'reviewed';
    const status: 'success' | 'failed' = isReviewable && !shardId ? 'failed' : 'success';
    return {
      path: f.filename,
      treatment: classification.treatment,
      shard_id: shardId ?? '',
      status,
      ...(classification.skipReason ? { skip_reason: classification.skipReason } : {}),
    };
  });

  const hardLimitHit = paginationResult.paginationTruncated || shardingResult.incomplete;
  const incomplete = hardLimitHit || missingPatchForReviewable.length > 0;

  const coverageManifest: CoverageManifest = {
    files: manifestFiles,
    shards_complete: !shardingResult.incomplete,
    hard_limit_hit: hardLimitHit,
    pulls_files_pagination_truncated: paginationResult.paginationTruncated,
    missing_patch_files: missingPatchForReviewable,
    token_usage: { prompt_tokens: 0, completion_tokens: 0 },
  };

  const artifact: PrepareArtifact = {
    identity_tuple: toSchemaIdentityTuple(input.identityTuple),
    shards,
    coverage_manifest: coverageManifest,
  };

  return { incomplete, artifact };
}

async function fetchFullFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const content = await fetchFileContent(octokit, { owner, repo, path, ref });
  return content ?? '';
}

export async function run(): Promise<void> {
  const pr = context.payload.pull_request;
  const prNumberInput = core.getInput('pr_number');
  const prNumber = pr ? pr.number : Number(prNumberInput);
  if (!prNumber) {
    throw new Error('prepare: unable to determine pull request number');
  }

  const expectedIdentityTupleRaw = core.getInput('identity_tuple', { required: true });
  const expectedIdentityTuple = JSON.parse(expectedIdentityTupleRaw) as IdentityTuple;

  const octokit = getOctokitFromInput();
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const identityTuple = await fetchIdentityTuple(octokit, owner, repo, prNumber);
  if (!identityTuplesEqual(identityTuple, expectedIdentityTuple)) {
    core.setOutput('stale', 'true');
    return;
  }

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const repoConfig = await loadRepoConfig(octokit, owner, repo, identityTuple.baseSha);

  const { data: treeData } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: identityTuple.headSha,
    recursive: 'true',
  });
  const tree: RepoTreeEntry[] = treeData.tree
    .filter((entry): entry is typeof entry & { path: string; sha: string; type: string } =>
      Boolean(entry.path && entry.sha && entry.type),
    )
    .map((entry) => ({
      path: entry.path,
      sha: entry.sha,
      type: entry.type === 'blob' ? 'blob' : 'tree',
    }));

  const reviewableCandidates = files.filter(
    (f) => classifyFile({ filename: f.filename }, repoConfig).treatment === 'reviewed',
  );

  const fullFileContents: Record<string, string> = {};
  await Promise.all(
    reviewableCandidates.map(async (file) => {
      fullFileContents[file.filename] = await fetchFullFileContent(
        octokit,
        owner,
        repo,
        file.filename,
        identityTuple.headSha,
      );
    }),
  );

  // analyze has no contents:read, so every context-resolver target (e.g. a
  // same-directory import that isn't itself a changed file) must also be
  // fetched here, not just the reviewable changed files above.
  const additionalContextPaths = new Set<string>();
  for (const file of reviewableCandidates) {
    const refs = resolveContext({
      changedFilePaths: [file.filename],
      changedFileContents: { [file.filename]: fullFileContents[file.filename] ?? '' },
      tree,
    });
    for (const ref of refs) {
      if (!(ref.path in fullFileContents)) {
        additionalContextPaths.add(ref.path);
      }
    }
  }
  await Promise.all(
    [...additionalContextPaths].map(async (path) => {
      fullFileContents[path] = await fetchFullFileContent(octokit, owner, repo, path, identityTuple.headSha);
    }),
  );

  const { incomplete, artifact } = buildPrepareArtifact({
    identityTuple,
    files,
    fullFileContents,
    tree,
    repoConfig,
    limits: {
      maxPrFilesPerPage: centralLimits.maxPrFilesPerPage,
      maxFilesPerShard: centralLimits.maxFilesPerShard,
      maxBytesPerShard: centralLimits.maxBytesPerShard,
      maxShards: centralLimits.maxShardsPerRun,
    },
  });

  core.setOutput('stale', 'false');
  core.setOutput('incomplete', String(incomplete));
  core.setOutput('prepare_artifact', JSON.stringify(artifact));
}
