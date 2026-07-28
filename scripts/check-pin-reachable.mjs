#!/usr/bin/env node
// check-pin-reachable.mjs —— 信任链内部 action 的 pin 必须指向本仓库一个真实存在的 commit。
//
// repin.test.ts 已经保证这些 pin 彼此一致，但"一致"不等于"存在"：pin 到一个只存在于本地、
// 被 rebase 掉、或者手误敲错的 SHA，CI 全绿，使用方却会在 `uses:` 解析时 404。
// 这个检查需要完整历史，所以单独成 job（checkout fetch-depth: 0），不放进 vitest。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSelfActionRefs, TRUST_CHAIN_FILES } from './repin.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const refs = TRUST_CHAIN_FILES.flatMap((rel) =>
  findSelfActionRefs(readFileSync(join(repoRoot, rel), 'utf8')).map((r) => ({ ...r, file: rel })),
);

if (refs.length === 0) {
  console.error('❌ 没有扫到任何自身 action pin —— workflow 结构已漂移，检查 scripts/repin.mjs');
  process.exit(1);
}

const shas = [...new Set(refs.map((r) => r.sha))];
if (shas.length > 1) {
  console.error(`❌ 自身 action pin 不一致：\n${refs.map((r) => `  ${r.file}:${r.line} ${r.sha}`).join('\n')}`);
  process.exit(1);
}

const sha = shas[0];
try {
  execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, stdio: 'pipe' });
} catch {
  console.error(`❌ pin 的 commit 在本仓库历史中不存在：${sha}\n   （忘记推送？rebase 掉了？跑 node scripts/repin.mjs HEAD 重新 pin）`);
  process.exit(1);
}

console.log(`✅ ${refs.length} 处自身 action pin 一致且可达：${sha}`);
