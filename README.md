# PR Review Swarm

供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行审核 PR，统一验证后一次性反馈。

## 当前阶段

**设计阶段** —— 本仓库目前只包含设计文档，尚未开始实现。完整设计见 [`docs/plans/2026-07-13-pr-review-swarm-design.md`](docs/plans/2026-07-13-pr-review-swarm-design.md)。

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

目标仓库只需要安装一个小型监听器 workflow，固定引用中央仓库某个 commit SHA：

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
    secrets:
      DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

具体权限拆分、Job 结构和安全模型见设计文档。

## 安全模型摘要

- 绝不 checkout PR head、不执行 PR 中的任何代码。
- `analyze`（LLM 分析）与 `publish`（发布结果）权限严格隔离：`analyze` 不持有可写 GitHub 凭据，`publish` 不持有 DeepSeek 凭据。
- 机器人只审核，不合并；`REQUEST_CHANGES`/`APPROVE` 由确定性规则计算，不由模型自行决定。
- 独立的 `status-finalize` Job 保证 Check Run 始终能到达终态，不会因上游 Job 失败或被取消而卡在 `in_progress`。

完整安全边界见设计文档「权限与安全边界」一节。
