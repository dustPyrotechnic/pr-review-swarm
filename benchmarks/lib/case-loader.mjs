import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { splitUnifiedDiff } from './split-patch.mjs';

/**
 * 一个 benchmark 用例目录的布局：
 *
 *   cases/<name>/diff.patch               完整 git diff（必需）
 *   cases/<name>/expected-findings.json   对账期望（必需）
 *   cases/<name>/pr-description.md        PR 描述（可选）
 *   cases/<name>/repo-config.json         该用例的 ignore_globs / generated_globs（可选）
 *   cases/<name>/context/<path>           该文件的全文，作为 verifier 上下文（可选）
 *
 * 加载期就把 fixture 自身的错误炸掉，是这一层的主要职责：expected 里写错一个
 * 文件名，表现出来是"模型漏报了一条"，但真实原因是用例写错了。让这类错误伪装
 * 成指标下降，是回归评测最容易失效的方式。
 */
export function loadCase(caseDir) {
  const name = basename(caseDir);

  const diffPath = join(caseDir, 'diff.patch');
  if (!existsSync(diffPath)) {
    throw new Error(`用例 ${name}: 缺少 diff.patch`);
  }
  const expectedPath = join(caseDir, 'expected-findings.json');
  if (!existsSync(expectedPath)) {
    throw new Error(`用例 ${name}: 缺少 expected-findings.json`);
  }

  const files = splitUnifiedDiff(readFileSync(diffPath, 'utf-8'));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf-8'));
  assertExpectedShape(name, expected, files);

  const prDescriptionPath = join(caseDir, 'pr-description.md');
  const prDescription = existsSync(prDescriptionPath)
    ? readFileSync(prDescriptionPath, 'utf-8')
    : '';

  const repoConfigPath = join(caseDir, 'repo-config.json');
  const rawRepoConfig = existsSync(repoConfigPath)
    ? JSON.parse(readFileSync(repoConfigPath, 'utf-8'))
    : {};

  return {
    name,
    dir: caseDir,
    files,
    expected,
    prDescription,
    // 生产里这两组 glob 来自目标仓库的 .github/pr-review-swarm.yml。用例要覆盖
    // "生成文件/vendor 目录不该被审"这类误报陷阱，就必须能给出自己的配置。
    repoConfig: {
      ignore_globs: rawRepoConfig.ignore_globs ?? [],
      generated_globs: rawRepoConfig.generated_globs ?? [],
    },
    contextContents: readContextDir(join(caseDir, 'context')),
  };
}

function assertExpectedShape(caseName, expected, files) {
  if (!Array.isArray(expected)) {
    throw new Error(`用例 ${caseName}: expected-findings.json 必须是数组`);
  }

  const diffPaths = new Set(files.map((f) => f.path));

  expected.forEach((entry, i) => {
    const where = `用例 ${caseName} expected[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${where}: 必须是对象`);
    }
    for (const [field, check] of [
      ['path', (v) => typeof v === 'string' && v.length > 0],
      ['line', (v) => Number.isInteger(v) && v >= 1],
      ['category', (v) => typeof v === 'string' && v.length > 0],
      ['must_find', (v) => typeof v === 'boolean'],
    ]) {
      if (!check(entry[field])) {
        throw new Error(`${where}: 字段 ${field} 缺失或类型不对（收到 ${JSON.stringify(entry[field])}）`);
      }
    }
    if (!diffPaths.has(entry.path)) {
      throw new Error(
        `${where}: path "${entry.path}" 没有出现在 diff.patch 里。` +
          `diff 涉及的文件是：${[...diffPaths].join(', ')}`,
      );
    }
  });
}

/**
 * context/ 下的目录结构镜像仓库路径，读成 `{ 仓库相对路径: 全文 }`。
 */
function readContextDir(contextRoot) {
  if (!existsSync(contextRoot)) {
    return {};
  }
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out[relative(contextRoot, full).split(sep).join('/')] = readFileSync(full, 'utf-8');
      }
    }
  };
  walk(contextRoot);
  return out;
}

/**
 * 把一个已加载的用例组装成 analyze 管线的输入（PrepareArtifact）。
 *
 * `parsePatch` / `shardFiles` 由调用方注入 —— 它们是 action 的真实实现（经
 * esbuild 打包成 ESM，见 pipeline.mjs）。评测必须复用生产代码的 diff 解析与
 * 分片，否则度量的是"benchmark 自己那套解析"的召回率，没有意义。
 */
export function toPrepareArtifact(loadedCase, deps) {
  const { parsePatch, shardFiles, classifyFile, limits } = deps;

  // 三个依赖都必传，不给默认值。尤其是 classifyFile：给它一个「全部按 reviewed
  // 处理」的兜底，忘传时不会报错，只会把 lockfile / vendor / 生成文件统统送进
  // 模型——于是那几条误报陷阱用例悄悄失效，而指标看起来一切正常。
  for (const name of ['parsePatch', 'shardFiles', 'classifyFile']) {
    if (typeof deps[name] !== 'function') {
      throw new Error(`toPrepareArtifact: 缺少依赖 ${name}（应传入 action 的生产实现）`);
    }
  }

  const parsed = loadedCase.files.map((f) => {
    // 走生产的 classifyFile：lockfile / vendor / 生成文件这类误报陷阱，
    // 靠的正是这一层把文件挡在模型之外。评测若自己另写一套分类，
    // 这些用例验证的就不是真实行为。
    const classification = classifyFile(
      { filename: f.path },
      loadedCase.repoConfig ?? { ignore_globs: [], generated_globs: [] },
    );
    return { ...f, parsed: parsePatch(f.path, f.patch), classification };
  });

  // 除了被分类器跳过的，无 hunk 的文件（二进制、纯模式变更）同样不进 shard。
  // 两类都必须在 coverage_manifest 里留痕 —— 文件不能凭空消失。
  const reviewable = parsed.filter(
    (f) => f.classification.treatment === 'reviewed' && f.parsed.hunks.length > 0,
  );
  const skipped = parsed.filter((f) => !reviewable.includes(f));

  const { shards: shardPlan } = shardFiles(
    reviewable.map((f) => ({ path: f.path, sizeBytes: Buffer.byteLength(f.patch, 'utf8') })),
    limits,
  );

  const byPath = new Map(reviewable.map((f) => [f.path, f]));
  const shards = shardPlan.map((shard) => ({
    id: shard.id,
    files: shard.files.map((path) => {
      const file = byPath.get(path);
      const contextContents = {};
      const contextRefs = [];
      if (loadedCase.contextContents[path] !== undefined) {
        contextContents[path] = loadedCase.contextContents[path];
        contextRefs.push({
          path,
          reason: 'same_file_full_content',
          sha: sha1(loadedCase.contextContents[path]),
        });
      }
      return { path, hunks: file.parsed.hunks, contextRefs, contextContents };
    }),
  }));

  const shardIdByPath = new Map();
  for (const shard of shardPlan) {
    for (const path of shard.files) {
      shardIdByPath.set(path, shard.id);
    }
  }

  const manifestFiles = [
    ...reviewable.map((f) => ({
      path: f.path,
      treatment: 'reviewed',
      shard_id: shardIdByPath.get(f.path) ?? '',
      status: 'success',
    })),
    ...skipped.map((f) => ({
      path: f.path,
      treatment:
        f.classification.treatment === 'reviewed' ? 'skipped_binary' : f.classification.treatment,
      shard_id: '',
      status: 'success',
      skip_reason:
        f.classification.skipReason ?? 'no hunks in diff (binary or mode-only change)',
    })),
  ];

  return {
    identity_tuple: identityTupleFor(loadedCase),
    shards,
    coverage_manifest: {
      files: manifestFiles,
      shards_complete: true,
      hard_limit_hit: false,
      pulls_files_pagination_truncated: false,
      missing_patch_files: [],
      token_usage: { prompt_tokens: 0, completion_tokens: 0 },
    },
  };
}

/**
 * 每个用例一个稳定但互不相同的身份元组。相同会让不同用例在任何按身份对账的
 * 下游逻辑里被当成同一次审核。
 */
function identityTupleFor(loadedCase) {
  const sha = sha1(`${loadedCase.name}\n${loadedCase.dir}`);
  return {
    head_repo: 'benchmarks/local',
    head_sha: sha,
    base_repo: 'benchmarks/local',
    base_ref: 'main',
    base_sha: sha1(`base:${loadedCase.name}`),
    merge_base_sha: sha1(`base:${loadedCase.name}`),
  };
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}
