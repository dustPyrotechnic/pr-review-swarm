# PR Review Swarm

供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行审核 PR，统一验证后一次性反馈。

## 当前阶段

**Phase 1-3 代码均已完成**（shadow mode → comment-only → 真实 REQUEST_CHANGES），并在沙盒仓库端到端验证通过——但请注意这里的"端到端"指的是**流程**跑通（Check 能终结、Review 能发出、权限隔离成立），**不含审核质量**。回归评测（`benchmarks/`）首轮真实运行已查出两个会显著压低有效召回率的生产缺陷，见 [#9](https://github.com/dustPyrotechnic/pr-review-swarm/issues/9) / [#10](https://github.com/dustPyrotechnic/pr-review-swarm/issues/10)，修掉之前不建议把它当成可靠的审核结果来依赖。`publish` 现在会按裁决结果发布真正的 GitHub Review：有问题时提交 `REQUEST_CHANGES`，没问题时只提交 `COMMENT`（**机器人永不提交 APPROVE，合并与否始终由人工最终确认**）。Phase 4（把 `PR Review Swarm / verdict` 设为 required check）已按需求跳过，不在计划范围内。完整设计见 [`docs/plans/2026-07-13-pr-review-swarm-design.md`](docs/plans/2026-07-13-pr-review-swarm-design.md)，实施计划见 [`docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md`](docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md)，安全与集成测试对账见 [`action/test/integration/CHECKLIST.md`](action/test/integration/CHECKLIST.md)。

## 目录结构（计划）

```
.
├── docs/plans/          # 设计文档
├── action/              # 中央 custom action 源码（prepare/analyze/publish/finalize 入口）+ 预构建 dist/
├── skills/              # Agent 可装备的 Markdown 审核 checklist
├── schemas/             # candidate finding / finding 的 JSON Schema
├── benchmarks/          # 回归评测：用例集 + 指标门槛（nightly 跑，需 DEEPSEEK_API_KEY）
├── scripts/             # 维护脚本（repin / release / 一致性校验）
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

默认写入的 workflow 钉在中央仓库的移动大版本 tag `v1` 上：中央仓库每次发布都会把 `v1` 移到新 commit，**使用方仓库无需任何改动就能拿到更新**。如果你的仓库需要不可变的供应链 pin，加 `--pin-sha`：部署时会把 `v1` 解析成当时的 40 位 commit SHA 写进 workflow，之后升级要重新跑一次 `pr-agent deploy --force --pin-sha`。两种模式生成的文件顶部都会写明当前 pin 与升级方式。

不传 `--deepseek-key` 时会走交互式遮罩输入，也可用 `DEEPSEEK_API_KEY` 环境变量传入；key 不会出现在任何日志或命令行参数里。默认会新建分支、开一个 PR 供你审阅后合并；加 `--direct-push` 可跳过 PR 直接推送到当前分支。命令会自动：写入两份监听器 workflow、写入默认 `.github/pr-review-swarm.yml`、设置 `DEEPSEEK_API_KEY` secret、检查 Actions 权限是否允许创建 PR。详见 `cli/` 目录，`--help` 可查看完整参数。

### 方式二：手动接入

目标仓库需要安装两个小型监听器 workflow：一个响应 PR 事件触发常规审核，一个按 schedule 触发 watchdog 清理超时的 Check。两者都引用中央仓库的同一个 ref —— 用 `v1`（移动大版本 tag，自动跟随中央仓库发布）或一个 40 位 commit SHA（不可变，升级需手动改）。

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
    uses: <org>/pr-review-swarm/.github/workflows/reusable-pr-review.yml@v1
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
    uses: <org>/pr-review-swarm/.github/workflows/reusable-pr-review-watchdog.yml@v1
```

具体权限拆分、Job 结构和安全模型见设计文档。

## 中央仓库如何发布（维护者）

使用方仓库钉在 `v1` 上，所以"发布"= 把 `v1` 移到新 commit。这一步只走脚本，不手改：

```bash
node scripts/release.mjs 1.2.3          # 本地：同步内部 pin、提交、打 v1.2.3、移动 v1
node scripts/release.mjs 1.2.3 --push   # 确认无误后再推送
```

脚本会先要求工作区干净，再把信任链 workflow 内部全部 `dustPyrotechnic/pr-review-swarm/action@<sha>`
统一改写到本次发布的 commit —— 跨仓库调用时 `uses: ./...` 会解析到**调用方**仓库，所以这些引用
必须写完整 SHA，且必须一次性全部同步。CI 有两道对应的护栏：

- `action/test/workflows/repin.test.ts`：6 处内部 pin 必须完全一致（挡住只改一半的部分 repin）
- CI `pin-reachable` job：pin 的 commit 必须真实存在于本仓库历史（挡住 pin 到未推送/被 rebase 掉的 commit）

只想单独重新 pin 而不发布时：`node scripts/repin.mjs HEAD`。

## 安全模型摘要

- 绝不 checkout PR head、不执行 PR 中的任何代码。
- `analyze`（LLM 分析）与 `publish`（发布结果）权限严格隔离：`analyze` 不持有可写 GitHub 凭据，`publish` 不持有 DeepSeek 凭据。
- 机器人只审核，不合并，也永不提交 APPROVE——最终合并确认始终是人工判断；`REQUEST_CHANGES`/`COMMENT` 由确定性规则计算，不由模型自行决定。
- 独立的 `status-finalize` Job 保证 Check Run 始终能到达终态，不会因上游 Job 失败或被取消而卡在 `in_progress`。

完整安全边界见设计文档「权限与安全边界」一节。
