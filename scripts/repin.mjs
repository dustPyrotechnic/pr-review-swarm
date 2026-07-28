#!/usr/bin/env node
// repin.mjs —— 把信任链 workflow 里"中央仓库自身 action"的 pin 统一改写到一个 commit SHA。
//
// 背景：跨仓库调用时 `uses: ./...` 会解析到调用方仓库，所以 reusable workflow 内部必须写
// 完整的 owner/repo/action@sha。这些引用散落在多个文件的多行里，手工同步漏掉一处就会出现
// "半新半旧"的 pin。发布流程只走这个脚本，不手改。
//
//   node scripts/repin.mjs <40位SHA|HEAD>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_ACTION = 'dustPyrotechnic/pr-review-swarm/action';

/** 信任链 workflow —— 与 action/test/workflows/load-workflows.ts 的 TRUST_CHAIN 保持一致。 */
export const TRUST_CHAIN_FILES = [
  '.github/workflows/reusable-pr-review.yml',
  '.github/workflows/reusable-pr-review-watchdog.yml',
];

const SELF_REF = new RegExp(`${SELF_ACTION.replace(/\//g, '\\/')}@([0-9a-f]{40})`, 'g');

export function findSelfActionRefs(text) {
  const refs = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(SELF_REF)) refs.push({ line: i + 1, sha: m[1] });
  });
  return refs;
}

export function repinText(text, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`repin 目标必须是 40 位 commit SHA（可变 tag 不得进入信任链），收到：${sha}`);
  }
  let replaced = 0;
  const out = text.replace(SELF_REF, () => {
    replaced += 1;
    return `${SELF_ACTION}@${sha}`;
  });
  return { text: out, replaced };
}

function main(argv) {
  const target = argv[0];
  if (!target) throw new Error('用法：node scripts/repin.mjs <40位SHA|HEAD>');

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sha =
    /^[0-9a-f]{40}$/.test(target) ? target : execFileSync('git', ['rev-parse', target], { cwd: repoRoot, encoding: 'utf8' }).trim();

  let total = 0;
  for (const rel of TRUST_CHAIN_FILES) {
    const path = join(repoRoot, rel);
    const before = readFileSync(path, 'utf8');
    const { text, replaced } = repinText(before, sha);
    if (text !== before) writeFileSync(path, text, 'utf8');
    total += replaced;
    console.log(`  ${rel}: ${replaced} 处引用 -> ${sha.slice(0, 12)}`);
  }

  if (total === 0) throw new Error(`没有匹配到任何 ${SELF_ACTION}@<sha> 引用 —— 脚本或 workflow 结构已漂移`);
  console.log(`✅ repin 完成，共 ${total} 处。`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
}
