const CENTRAL_REPO = 'dustPyrotechnic/pr-review-swarm';

function prReviewYml(pinnedSha) {
  return `# .github/workflows/pr-review.yml (installed by pr-review-swarm deploy)
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
    uses: ${CENTRAL_REPO}/.github/workflows/reusable-pr-review.yml@${pinnedSha}
    with:
      pr_number: \${{ github.event.pull_request.number || inputs.pr_number }}
      model: 'deepseek-chat'
    secrets:
      DEEPSEEK_API_KEY: \${{ secrets.DEEPSEEK_API_KEY }}
`;
}

function watchdogYml(pinnedSha) {
  return `# .github/workflows/pr-review-watchdog.yml (installed by pr-review-swarm deploy)
name: PR Review Swarm Watchdog
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch: {}

jobs:
  watchdog:
    uses: ${CENTRAL_REPO}/.github/workflows/reusable-pr-review-watchdog.yml@${pinnedSha}
`;
}

const FILES = [
  { path: '.github/workflows/pr-review.yml', render: prReviewYml },
  { path: '.github/workflows/pr-review-watchdog.yml', render: watchdogYml },
];

export function writeWorkflows({ fs, pinnedSha, force }) {
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
    fs.writeFile(file.path, file.render(pinnedSha));
    written.push(file.path);
  }

  return { written, overwritten };
}
