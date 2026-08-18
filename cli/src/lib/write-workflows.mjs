import { CENTRAL_REPO, DEFAULT_REF } from './resolve-ref.mjs';

function refNote(ref) {
  const explanation =
    ref === DEFAULT_REF
      ? `\`${DEFAULT_REF}\` is a moving major tag — central releases roll out here automatically.`
      : 'This is an immutable commit SHA — it never picks up central releases on its own.';
  return `# Pinned to ${CENTRAL_REPO}@${ref}.
# ${explanation}
# To change the pin, re-run \`pr-agent deploy --force\` (add \`--pin-sha\` for an immutable pin).`;
}

function prReviewYml(ref) {
  return `# .github/workflows/pr-review.yml (installed by pr-review-swarm deploy)
${refNote(ref)}
name: PR Review Swarm
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review, edited, converted_to_draft, closed]
  workflow_dispatch:
    inputs:
      pr_number:
        required: true

jobs:
  review:
    uses: ${CENTRAL_REPO}/.github/workflows/reusable-pr-review.yml@${ref}
    with:
      pr_number: \${{ github.event.pull_request.number || inputs.pr_number }}
      model: 'deepseek-chat'
    secrets:
      DEEPSEEK_API_KEY: \${{ secrets.DEEPSEEK_API_KEY }}
`;
}

function watchdogYml(ref) {
  return `# .github/workflows/pr-review-watchdog.yml (installed by pr-review-swarm deploy)
${refNote(ref)}
name: PR Review Swarm Watchdog
# 孤儿 Check 的最坏清理延迟 = central-limits.json 的 watchdogStaleThresholdMinutes（10）
# + 这里的扫描间隔（30）= 40 分钟。对一个「运行已经死了、Check 卡在转圈」的兜底路径，
# 把间隔压得更小换不来有意义的提速，只会成倍放大空跑轮次：既扩大与 GitHub 抖动的碰撞面
# （2026-08-17 的 5 次连红全部出自空跑轮次），又持续挤占该仓库 GITHUB_TOKEN 的速率配额。
on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch: {}

jobs:
  watchdog:
    uses: ${CENTRAL_REPO}/.github/workflows/reusable-pr-review-watchdog.yml@${ref}
`;
}

const FILES = [
  { path: '.github/workflows/pr-review.yml', render: prReviewYml },
  { path: '.github/workflows/pr-review-watchdog.yml', render: watchdogYml },
];

export function writeWorkflows({ fs, ref, force }) {
  const conflicts = FILES.filter((f) => fs.exists(f.path));
  if (conflicts.length > 0 && !force) {
    throw new Error(
      `refusing to overwrite existing file(s): ${conflicts.map((f) => f.path).join(', ')} — pass --force to overwrite.`,
    );
  }

  const written = [];
  const overwritten = [];
  for (const file of FILES) {
    if (fs.exists(file.path)) overwritten.push(file.path);
    fs.writeFile(file.path, file.render(ref));
    written.push(file.path);
  }

  return { written, overwritten };
}
