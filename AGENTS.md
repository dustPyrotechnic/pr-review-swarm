# PR Review Swarm — Agent 入口

给后续 agent 的仓库约定与当前落地。根目录 `AGENTS.md` 与 `CLAUDE.md` 必须保持一致，改一处时同步另一处。面向人类的现状摘要在 [`README.md`](README.md)「当前阶段」。

硬禁令只在 [`docs/AGENTS.md`](docs/AGENTS.md)，改 workflow / action / 权限 / Secret 边界之前必须完整读完。本文件不重复那 9 条正文。

## 当前落地（截至 2026-08-20）

| 项 | 状态 |
|---|---|
| 发布 | **v1.1.1**（2026-08-18），`master` 与 `origin/master` 同步 |
| Phase 0–3 | 已完成：shadow → comment-only → 真实 `REQUEST_CHANGES` |
| Phase 4 | **已跳过**。不要把 Check 设成 required，除非用户明确要求 |
| 流程验证 | 沙盒仓库验证过 Check / Review / 权限隔离；那次不含审核质量 |
| 质量基线 | 27 用例 × 3 轮：召回 88.9%–91.4%，incomplete 0%，p95 ~30s，~$0.003/PR |
| #9 / #10 | 已关（行号锚点、畸形 tool-call 重试） |
| #12 | **已关**（2026-08-15）。3×3 复测陷阱 0/1。全量 27×3 未在修复后重跑 |
| #11 | **仍开**。skill + 真引用环夹具后召回 0%/33.3% → **66.7%/66.7%**，未稳 |
| 误报 | 仍偏高；真阴性 14 个里 13 个零误报，不是无差别乱报 |
| 外部实测 | 2026-08-30 首次真实外部 PR（ios-source-learning#9，18 轮 / 62 finding）。12 类缺陷已按计划修完代码，**评测未跑** |
| Lody tasks | 本工作区未登记任务 |

`publish` 有问题发 `REQUEST_CHANGES`，没问题只发 `COMMENT`。**机器人永不提交 APPROVE，也不 merge。** 一个例外（2026-08-30 规格修订）：`incomplete` + 全 `low` + 非 `hard_limit_hit` 时降级为 `COMMENT`，见设计文档「反馈内容」一节。

`benchmarks/thresholds.json` 仍保留 `max_must_not_find_hits: 1`。下次全量 27×3 若陷阱仍为 0，删掉该键（缺键回落到 0）。不要在没有全量数据时把这项改成 0。

## 下一步（按优先级）

1. **验证 2026-08-30 的加固**（`docs/plans/2026-08-30-review-quality-hardening-plan.md` 的 Task 12）。代码已全部落地，但两件事还没量化：`temperature=0` 的方差降幅（拿 `benchmarks/run-evaluation.mjs` 的 `findingSetInstability` 做前后对照，基线要在 `d83c59b` 的父提交上取），以及横幅/分页修复在真实多轮审核里的表现。
2. 全量 27×3 之后：若陷阱为 0，删除 `max_must_not_find_hits`；若方差确实下降，重新评估 `maxExpertSchemaRetries`（temperature=0 削弱了「重试一次就好」这个前提，所以本轮刻意没动它）。
3. [#11](https://github.com/dustPyrotechnic/pr-review-swarm/issues/11) retain cycle 识别：prompt/skill/verifier 取证，用 `--case=swift-retain-cycle --repeat=3` 和 `objc-retain-cycle-block` 做 A/B，不要一上来全量评测。
4. 误报治理（真阳性用例上的低价值顺手报）。实测报告的 P12 给了它的真实代价：59.7% 是 low，作者为此提了 19 个 commit、跑了 17 次 CI，PR 始终收敛不了。
5. CHECKLIST 附录 A 的 5 项沙盒人工验证。未授权不要做仓库设置或 fork 凭据实验。

## 动手之前

1. 改 `.github/workflows/`、`action/action.yml`、Job `permissions`、Secret 可见性 → 先读 [`docs/AGENTS.md`](docs/AGENTS.md)。不要为了让测试绿而放宽被测的安全属性。
2. 改 `action/src/` → commit 前 `cd action && npm run build`，把 `dist/` 一并提交。CI 的 `build-dist-no-drift` 会挡漂移。
3. 信任链内部的 `uses:` 必须是完整 commit SHA。内部 pin 只用 `node scripts/repin.mjs <sha>`，禁止手工改一半。使用方 caller 钉 `v1` 是刻意例外。
4. 规格文档里若再写「机器人会提交 APPROVE」，`action/test/docs-consistency.test.ts` 会红。否定式和 watchdog 回填历史/人工 APPROVED Review 除外。

## 仓库约定

- 语言与测试：TypeScript + vitest（`action/`），`.mjs` + vitest（`benchmarks/`、`cli/`）。
- 单测与被测模块同目录同名（`arbiter.ts` → `arbiter.test.ts`）。跨入口集成测试放 `action/test/integration/`。
- 命令：`cd action && npm test`；单文件 `npx vitest run src/lib/arbiter.test.ts`。`cli/`、`benchmarks/` 同理。
- 每个逻辑任务一次 commit，前缀 `fix:` / `feat:` / `test:` / `ci:` / `docs:` / `chore:`。
- 评测会花钱。`--gate --repeat=3` 全量约 $0.07、约 17 分钟。单用例调试用 `--case=<name> --repeat=2`。不要用 `workflow_dispatch` 触发 nightly（当前 token 缺该权限）；全量评测走临时 `pull_request` workflow，用完即删。
- `category` 是自由文本，只用于呈现。去重键和评测匹配都是 `(path, line)`，不要把 `category` 加回去。
- 同一行两个真正不同的问题会被 arbiter 并成一条，这是有意取舍。

## 文档地图

| 要找什么 | 去哪 |
|---|---|
| 人类可读现状 | `README.md` |
| 硬禁令 | `docs/AGENTS.md` |
| 设计 | `docs/plans/2026-07-13-pr-review-swarm-design.md` |
| 阶段任务拆分（历史） | `docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md` |
| 测试对账 | `action/test/integration/CHECKLIST.md` |
| 门槛依据 | `benchmarks/thresholds.json`、`docs/plans/2026-08-13-threshold-baseline-and-dedup-fix.md` |
| 外部实测报告 | `docs/field-reports/` |

计划文档是当时的任务拆分。顶部有「状态：已完成 / 已跳过」的，不要把正文里的 Task 重新当成未做。

## 明确不要做的

- 不要 checkout PR head，不要执行 PR 里的代码、脚本或依赖。
- 不要给 `analyze` 可写 GitHub 凭据或 `contents: read`。
- 不要给 `publish` DeepSeek Secret，也不要在 publish 里调用 LLM。
- 不要静默截断硬上限后按 pass / changes_requested 处理。
- 不要开始 Phase 4，除非用户明确要求。
- 不要把本文件写成活动日志；阶段变化时只更新「当前落地」和「下一步」。
