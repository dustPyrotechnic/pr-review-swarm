import { CENTRAL_REPO, DEFAULT_REF } from './resolve-ref.mjs';
import { parseWatchdogInterval, STALE_THRESHOLD_MINUTES } from './watchdog-schedule.mjs';

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

function watchdogYml(ref, interval) {
  return `# .github/workflows/pr-review-watchdog.yml (installed by pr-review-swarm deploy)
${refNote(ref)}
name: PR Review Swarm Watchdog
# 兜底巡检，清理「运行已经死了、Check 还卡在 in_progress」的孤儿。它不替代 pr-review.yml
# 的事件触发，只负责那些「不会再有下一次 PR 事件来收尾」的死角。
#
# 扫描间隔：${interval.label}（改用 \`pr-agent deploy --watchdog-interval=<N>m|<N>h --force\` 重装）
# 最坏清理延迟 = 超时阈值 ${STALE_THRESHOLD_MINUTES} 分钟 + 最长扫描间隙 ${interval.maxGapLabel} = ${interval.worstCaseLabel}
#
# 在这段延迟内，卡住的 Check 会一直显示"审核中"；若它是必需检查，对应 PR 也一直无法合并。
# 间隔越大空跑轮次越少（省速率配额、少撞 GitHub 抖动），代价就是这个延迟越长。
on:
  schedule:
    - cron: '${interval.cron}'
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

export function writeWorkflows({ fs, ref, force, watchdogInterval }) {
  // 先解析再写：间隔非法时应该在碰任何文件之前就报错，不能写了一半留下半套配置。
  const interval = parseWatchdogInterval(watchdogInterval);

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
    fs.writeFile(file.path, file.render(ref, interval));
    written.push(file.path);
  }

  return { written, overwritten, watchdogInterval: interval };
}
