# PR Review Swarm

供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行审核 PR，统一验证后一次性反馈。

## 当前阶段

**Phase 1（shadow mode，只读）实现中** —— 六个入口（status-start/prepare/analyze/publish/status-finalize/watchdog）及 lightweight-cleanup 已全部实现并有单测覆盖；`publish` 目前只写 job summary，不调用任何 GitHub 写 API。完整设计见 [`docs/plans/2026-07-13-pr-review-swarm-design.md`](docs/plans/2026-07-13-pr-review-swarm-design.md)，实施计划见 [`docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md`](docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md)。

## 目录结构（计划）

```
.
├── docs/plans/          # 设计文档
├── action/              # 中央 custom action 源码（prepare/analyze/publish/finalize 入口）+ 预构建 dist/
├── skills/              # Agent 可装备的 Markdown 审核 checklist
├── schemas/             # candidate finding / finding 的 JSON Schema
├── benchmarks/          # 回归评测用例
└── .github/workflows/   # reusable workflow
```

## 目标仓库如何接入（计划中的用法）

目标仓库需要安装两个小型监听器 workflow，都固定引用中央仓库某个 commit SHA：一个响应 PR 事件触发常规审核，一个按 schedule 触发 watchdog 清理超时的 Check。

### 常规审核监听器

```yaml
# .github/workflows/pr-review.yml（目标仓库）
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
    uses: <org>/pr-review-swarm/.github/workflows/reusable-pr-review.yml@<pinned-commit-sha>
    with:
      pr_number: ${{ github.event.pull_request.number || inputs.pr_number }}
      model: 'deepseek-chat' # 需与 action/config/allowed-models.json 中的白名单一致
    secrets:
      DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

### Watchdog 监听器

每 10 分钟扫描一次超时未终结的 Check（默认超时阈值 30 分钟，见 `action/config/central-limits.json`），并支持手动触发排障：

```yaml
# .github/workflows/pr-review-watchdog.yml（目标仓库）
name: PR Review Swarm Watchdog
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch: {}

jobs:
  watchdog:
    uses: <org>/pr-review-swarm/.github/workflows/reusable-pr-review-watchdog.yml@<pinned-commit-sha>
```

具体权限拆分、Job 结构和安全模型见设计文档。

## 安全模型摘要

- 绝不 checkout PR head、不执行 PR 中的任何代码。
- `analyze`（LLM 分析）与 `publish`（发布结果）权限严格隔离：`analyze` 不持有可写 GitHub 凭据，`publish` 不持有 DeepSeek 凭据。
- 机器人只审核，不合并；`REQUEST_CHANGES`/`APPROVE` 由确定性规则计算，不由模型自行决定。
- 独立的 `status-finalize` Job 保证 Check Run 始终能到达终态，不会因上游 Job 失败或被取消而卡在 `in_progress`。

完整安全边界见设计文档「权限与安全边界」一节。
