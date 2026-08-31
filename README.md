# PR Review Swarm

供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行审核 PR，统一验证后一次性反馈。

## 当前阶段

**产品形态已落地，当前发布 v1.1.1**（2026-08-18）。Phase 1–3（shadow mode → comment-only → 真实 `REQUEST_CHANGES`）代码完成，沙盒仓库验证的是**流程**（Check 能终结、Review 能发出、权限隔离成立），**不含审核质量**。Phase 4（把 `PR Review Swarm / verdict` 设为 required check）已按需求跳过，不在计划范围内。

回归评测（`benchmarks/`，27 用例 × 3 轮，`deepseek-chat`）已定基线：召回率 **88.9%–91.4%**、incomplete 0%、p95 端到端约 30 秒、成本约 $0.003/PR。过程中修掉的生产缺陷：[#9](https://github.com/dustPyrotechnic/pr-review-swarm/issues/9) 行号锚点、[#10](https://github.com/dustPyrotechnic/pr-review-swarm/issues/10) 畸形 tool-call 重试、arbiter 去重键含自由文本、评测层拿 `category` 做精确匹配。其中 #9 曾让有效召回接近 0。

质量侧（以 2026-08-15 的 skill/夹具复测为准）：

- [#12](https://github.com/dustPyrotechnic/pr-review-swarm/issues/12) **已关闭**：prompt 把「上下文行属于既有代码」写成硬规则，夹具钉回 2019 TODO 行后，3 用例 × 3 轮陷阱命中 0/1。全量 27×3 尚未在此次修复后重跑，因此 `benchmarks/thresholds.json` 仍保留 `max_must_not_find_hits: 1`；下次全量若陷阱仍为 0，应删掉该键（缺键回落到 0）。
- [#11](https://github.com/dustPyrotechnic/pr-review-swarm/issues/11) **仍开**：补了 ObjC 清单和 Swift retain cycle 判据，并把夹具改成真引用环之后，`swift-retain-cycle` / `objc-retain-cycle-block` 召回从 0% / 33.3% 升到 **66.7%**，尚未稳定。
- 误报仍偏高：找到真问题时会顺手多报几条低价值条目（真阴性 14 个里 13 个零误报，所以不是无差别乱报）。

`publish` 按裁决发布 GitHub Review：有问题提交 `REQUEST_CHANGES`，没问题只提交 `COMMENT`（**机器人永不提交 APPROVE，合并与否始终由人工最终确认**）。

完整设计见 [`docs/plans/2026-07-13-pr-review-swarm-design.md`](docs/plans/2026-07-13-pr-review-swarm-design.md)，实施计划见 [`docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md`](docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md)，安全与集成测试对账见 [`action/test/integration/CHECKLIST.md`](action/test/integration/CHECKLIST.md)。给后续 agent 的仓库约定与下一步见根目录 [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md)。

## 目录结构

```
.
├── docs/plans/          # 设计文档与各阶段实施计划
├── docs/AGENTS.md       # 硬禁令清单（改 workflow/action 前必读）
├── action/              # 中央 custom action 源码（prepare/analyze/publish/finalize 入口）+ 预构建 dist/
├── cli/                 # 一键部署 CLI（pr-agent deploy）
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

默认每 30 分钟扫描一次超时未终结的 Check（默认超时阈值 10 分钟，见 `action/config/central-limits.json`），并支持手动触发排障。孤儿 Check 最坏情况下的清理延迟 =「阈值 + 最长扫描间隙」，默认即 40 分钟。

扫描间隔可在部署时按仓库活跃度调整，`30m` 到 `24h` 之间：

```bash
pr-agent deploy --watchdog-interval=10h --force   # 冷清的仓库，接受最坏 10 小时 10 分钟的清理延迟
```

间隔越大，空跑轮次越少（省 `GITHUB_TOKEN` 速率配额、少撞 GitHub 抖动）；代价是卡住的 Check 显示「审核中」的时间越长，若它是必需检查，对应 PR 在这段时间内无法合并。生成的 workflow 文件里会写明该间隔对应的实际最坏延迟。

```yaml
# .github/workflows/pr-review-watchdog.yml（目标仓库）
name: PR Review Swarm Watchdog
# 扫描间隔决定的是「发现得多快」，与超时阈值相加才是最坏清理延迟。
# 扫得更密只是成倍放大空跑轮次和撞上 GitHub 抖动的机会。
on:
  schedule:
    - cron: '*/30 * * * *'
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
