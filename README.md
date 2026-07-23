# PR Review Swarm

供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行审核 PR，统一验证后一次性反馈。

## 当前阶段

**Phase 1-3 代码均已完成**（shadow mode → comment-only → 真实 REQUEST_CHANGES），并在沙盒仓库端到端验证通过。`publish` 现在会按裁决结果发布真正的 GitHub Review：有问题时提交 `REQUEST_CHANGES`，没问题时只提交 `COMMENT`（**机器人永不提交 APPROVE，合并与否始终由人工最终确认**）。Phase 4（把 `PR Review Swarm / verdict` 设为 required check）已按需求跳过，不在计划范围内。完整设计见 [`docs/plans/2026-07-13-pr-review-swarm-design.md`](docs/plans/2026-07-13-pr-review-swarm-design.md)，实施计划见 [`docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md`](docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md)，安全与集成测试对账见 [`action/test/integration/CHECKLIST.md`](action/test/integration/CHECKLIST.md)。

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

## 目标仓库如何接入

### 方式一：一键部署 CLI（推荐）

在目标仓库根目录跑一条命令即可（需要已安装并登录 `gh` CLI）：

```bash
npx github:dustPyrotechnic/pr-review-swarm#master deploy --deepseek-key=sk-xxxx
```

**本机想要更短的命令**（比如反复部署到多个仓库），可以把 CLI 链接到本机 PATH 里，之后就能直接用 `pr-agent deploy`：

```bash
git clone https://github.com/dustPyrotechnic/pr-review-swarm.git
cd pr-review-swarm/cli && npm install && npm link
# 之后在任意目标仓库根目录：
pr-agent deploy --deepseek-key=sk-xxxx
```

`npm link` 只在本机生效，指向的是你本地这份 clone 的代码；中央仓库更新后需要 `git pull` 才能跟上（不像 `npx github:...#tag` 每次都拉取远端最新代码）。

不传 `--deepseek-key` 时会走交互式遮罩输入，也可用 `DEEPSEEK_API_KEY` 环境变量传入；key 不会出现在任何日志或命令行参数里。默认会新建分支、开一个 PR 供你审阅后合并；加 `--direct-push` 可跳过 PR 直接推送到当前分支。命令会自动：写入两份监听器 workflow、写入默认 `.github/pr-review-swarm.yml`、设置 `DEEPSEEK_API_KEY` secret、检查 Actions 权限是否允许创建 PR。详见 `cli/` 目录，`--help` 可查看完整参数。

### 方式二：手动接入

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
- 机器人只审核，不合并，也永不提交 APPROVE——最终合并确认始终是人工判断；`REQUEST_CHANGES`/`COMMENT` 由确定性规则计算，不由模型自行决定。
- 独立的 `status-finalize` Job 保证 Check Run 始终能到达终态，不会因上游 Job 失败或被取消而卡在 `in_progress`。

完整安全边界见设计文档「权限与安全边界」一节。
