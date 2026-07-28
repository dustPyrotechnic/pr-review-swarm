#!/usr/bin/env node
// release.mjs —— 发布一次中央仓库版本。
//
// 使用方仓库里的 caller workflow 现在钉在移动的大版本 tag（v1）上，所以"发布"就是：
//   1. 把信任链 workflow 内部的自身 action pin 同步到本次发布的 commit（不可变 SHA）
//   2. 打一个不可变 tag vX.Y.Z
//   3. 把大版本 tag v1 强制移动到同一个 commit —— 这一步之后，所有使用方自动生效
//
// 推送是显式的：默认只做本地改动并打印待执行的 push 命令，确认无误后再加 --push。
//
//   node scripts/release.mjs 1.2.3 [--push]

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { repinText, TRUST_CHAIN_FILES } from './repin.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function tagsFor(version) {
  const cleaned = String(version).replace(/^v/, '');
  const m = /^(\d+)\.\d+\.\d+$/.exec(cleaned);
  if (!m) throw new Error(`版本号必须是 x.y.z 形式，收到：${version}`);
  return { tag: `v${cleaned}`, majorTag: `v${m[1]}` };
}

export async function runRelease({ version, push }, deps) {
  const { isClean, headSha, repin, git, log } = deps;
  const { tag, majorTag } = tagsFor(version);

  if (!(await isClean())) {
    throw new Error('工作区有未提交的改动 —— 发布必须从干净的工作区开始');
  }

  const sha = await headSha();
  const { replaced, changed } = await repin(sha);
  log(`内部 action pin -> ${sha.slice(0, 12)}（${replaced} 处${changed ? '' : '，已是最新'}）`);

  if (changed) {
    await git(['add', '--', ...TRUST_CHAIN_FILES]);
    await git(['commit', '-m', `chore(release): pin action refs to ${sha.slice(0, 12)} for ${tag}`]);
  }

  await git(['tag', '-a', tag, '-m', `Release ${tag}`]);
  await git(['tag', '-f', majorTag]);

  const pendingPush = [
    'git push origin HEAD',
    `git push origin ${tag}`,
    `git push --force origin ${majorTag}`,
  ];

  if (!push) {
    log('\n本地已就绪，未推送。确认无误后执行：');
    for (const cmd of pendingPush) log(`  ${cmd}`);
    return { tag, majorTag, sha, pushed: false, pendingPush };
  }

  await git(['push', 'origin', 'HEAD']);
  await git(['push', 'origin', tag]);
  await git(['push', '--force', 'origin', majorTag]);
  log(`\n✅ ${tag} 已发布，${majorTag} 已指向 ${sha.slice(0, 12)} —— 使用方仓库下次 PR 即生效。`);

  return { tag, majorTag, sha, pushed: true, pendingPush };
}

async function gitReal(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT });
  return stdout;
}

function realDeps() {
  return {
    isClean: async () => (await gitReal(['status', '--porcelain'])).trim() === '',
    headSha: async () => (await gitReal(['rev-parse', 'HEAD'])).trim(),
    repin: async (sha) => {
      let replaced = 0;
      let changed = false;
      for (const rel of TRUST_CHAIN_FILES) {
        const path = join(REPO_ROOT, rel);
        const before = readFileSync(path, 'utf8');
        const result = repinText(before, sha);
        if (result.text !== before) {
          writeFileSync(path, result.text, 'utf8');
          changed = true;
        }
        replaced += result.replaced;
      }
      return { replaced, changed };
    },
    git: gitReal,
    log: (msg) => console.log(msg),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('-'));
  runRelease({ version, push: args.includes('--push') }, realDeps()).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
}
