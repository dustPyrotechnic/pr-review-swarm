# Task 3.4 — 安全与集成测试清单对账

> **修订（2026-07-23）：机器人不再提交 APPROVE。** 原设计（本文件下方引用的设计文档）里"零 finding 时提交 APPROVE"的行为已按明确要求移除——机器人永远不给出最终合并确认，pass verdict 现在也只发 `COMMENT`（附带 `default_mention`），合并与否完全由人工判断。相应地，CLI 也不再检查/警告仓库的"Allow GitHub Actions to create and approve pull requests"权限（那条限制只影响 APPROVE，REQUEST_CHANGES/COMMENT 不受影响，机器人不再需要这项权限）。下表第 6、8、19 条已按新行为更新。

对照 `docs/plans/2026-07-13-pr-review-swarm-design.md` "测试与验收 → 安全与集成测试" 一节（L291-318）逐条列出证据来源。每条标注：

- **单测覆盖**：已有自动化测试断言该行为，给出文件:行号。
- **CI 配置锁定**：由 workflow/action.yml 的结构性约束保证，不是可以用 vitest 断言的运行时行为（例如"运行阶段不装依赖"是 action.yml 里没有 `pre`/`post` install 步骤这一事实本身）。
- **人工/沙盒验证**：需要真实 GitHub 环境才能观察，本轮已在沙盒仓库 `dustPyrotechnic/pr-review-swarm` PR #5/#6 验证，记录见下方"沙盒验证记录"。
- **缺口**：本轮新增的测试（本次提交一并落地）。

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | fork PR 无法修改 workflow/action/skills/裁决规则，无法获取写凭据/DeepSeek Secret | CI 配置锁定 | `.github/workflows/reusable-pr-review.yml` 用 `pull_request_target` + 从不 checkout PR head（`forbidden-pr-head-ref-scan` CI job 静态扫描锁定）；`analyze` job 权限声明里没有 `pull-requests: write`/`issues: write`，`publish` job 没有 `DEEPSEEK_API_KEY` |
| 2 | prompt injection、恶意文件名、非法 JSON、越界路径、伪造行号/证据不能进入 publish | 单测覆盖 | `deterministic-evidence-validator.test.ts`、`schema-validator.test.ts`、`diff-parser.test.ts`（路径/行号越界）、`inline-comment-locator.test.ts`（伪造行号定位失败降级） |
| 3 | 版本绑定 dist/schemas/skills，运行阶段不装依赖 | CI 配置锁定 | CI `build-dist-no-drift` job 对比 `dist/` 与源码重建结果；`action.yml` 无 npm install 步骤 |
| 4 | 覆盖重命名、删除、二进制、生成文件、超大 diff、跨文件影响、部分 API 失败 | 单测覆盖 | `diff-parser.test.ts`、`file-classifier.test.ts`（生成文件/二进制）、`pr-files-pagination-guard.test.ts`（超大 diff/分页截断）、`publish.test.ts`"retries a transient createReview failure"（部分 API 失败） |
| 5 | 审核期间没有任何 PR 评论；全部结束后才统一发布 | 单测覆盖（本轮新增） | `analyze.test.ts`"analyze.ts never holds GitHub write credentials" — 静态断言 `analyze.ts` 不 import `@actions/github`，物理上不可能在分析阶段发评论 |
| 6 | 任一最终 finding 都产生 REQUEST_CHANGES；机器人永不提交 APPROVE，零 finding 的完整审核只发 COMMENT（人工仍需自行确认合并） | 单测覆盖 | `verdict.test.ts` `computeFinalReviewEvent` 全分支 + "never returns APPROVE for verdict=..." 锁；`publish.test.ts` "reports changes_requested with final_review_event REQUEST_CHANGES..."/"produces a schema-valid verdict summary for the pass case, with final_review_event COMMENT..."/"publish.ts never submits an approving Review" 源码锁 |
| 7 | verifier 失败产生 incomplete，已验证问题被反馈，未验证候选不发布 | 单测覆盖 | `analyze.test.ts`（VerifierUnavailableError → anyRequiredStageFailed）、`arbiter.test.ts` |
| 8 | REQUEST_CHANGES → 新 commit → 恢复正常（COMMENT，不是 APPROVE）完整生命周期，旧 Review 正确被取代 | 单测覆盖（本轮新增，2026-07-23 按"机器人不提交 APPROVE"修订） | `test/integration/review-lifecycle.test.ts` |
| 9 | 旧身份元组（含旧 head_sha、旧 base_ref）延迟结果不覆盖新结果 | 单测覆盖 | `publish.test.ts` "reports stale_cancelled when the re-fetched identity tuple no longer matches..." |
| 10 | PR 关闭/转草稿/身份元组变化时不发布 Review/摘要，Check 终结为 cancelled | 单测覆盖 | `status-finalize.test.ts`、`lightweight-cleanup.test.ts` |
| 11 | success/failure/action_required/timed_out/cancelled 状态及后继运行对账，含 status-finalize 兜底、watchdog 兜底取消调度场景 | 单测覆盖 | `status-finalize.test.ts`、`check-run.test.ts`、`watchdog.test.ts` |
| 12 | review_set_id 随 findings 集合变化，不会因命中旧 Review 而漏发；findings_digest 不匹配判定 incomplete 而非静默覆盖 | 单测覆盖 | `review-set-id.test.ts`；`publish.test.ts` "reports incomplete and stops publishing when an already-published batch has a mismatched digest" |
| 13 | 同一 head_sha 多次 workflow_dispatch 重跑产生不同 review_set_id 时，旧一轮 Review/inline comment 被 dismiss/追加取代说明 | 单测覆盖（本轮补齐 dismiss 路径） | `publish.test.ts` "dismisses a stale CHANGES_REQUESTED review..."、"falls back to editing the body when dismissing...is rejected with 403"、"appends a superseded notice to a stale COMMENT-state review..." |
| 14 | workflow_dispatch 正确绕过信任门控的 author association/白名单判断，且不被后续自动事件继承 | 单测覆盖 | `trust-gate.test.ts` "allows workflow_dispatch regardless of author association" |
| 15 | 信任门控/仓库启用检查失败时 Check 写为 action_required，而不是完全没有 Check | 单测覆盖 | `status-start.test.ts` |
| 16 | watchdog 在 workflow run 仍 queued/in_progress 时不误终结耗时较长的正常审核 | 单测覆盖 | `watchdog.test.ts` "does not finalize a check whose workflow run is still in_progress" |
| 17 | dismiss 旧 Review 因分支保护被拒绝（403）时降级为编辑 body，而非判定失败/跳过 | 单测覆盖（本轮新增，即 Task 3.4 发现的 Phase 2 遗留缺口） | `publish.test.ts` "falls back to editing the body when dismissing a stale CHANGES_REQUESTED review is rejected with 403" |
| 18 | status-start 与 watchdog 之间没有清理空隙，短暂重叠不产生错误结果 | 单测覆盖 | `status-start.test.ts`、`watchdog.test.ts` 分别覆盖各自清理范围；两者的 run-status 核验逻辑互不依赖对方状态 |
| 19 | watchdog 在 run 已 completed 但 publish 已成功发布最终 Review 时，回填为该 Review 一致的结论，而不是覆盖为 timed_out | 单测覆盖（本轮新增；`checkForPublishedFinalReview` 仍识别历史/人工产生的 APPROVED 状态用于回填，即使机器人自己不再产出它） | `watchdog.test.ts` "returns APPROVE/REQUEST_CHANGES when a bot-owned .../CHANGES_REQUESTED review exists..."、"backfills a stale check to success when a published APPROVE review is found instead of timing it out" |
| 20 | pulls/{pr}/files 命中约 3000 文件上限或个别文件缺 patch 字段时判定 incomplete，而非按子集继续 | 单测覆盖 | `pr-files-pagination-guard.test.ts`、`prepare.test.ts` |
| 21 | 专家输出 coverage_complete 缺失/false，或 findings 数恰好等于 maxItems 时都判定命中硬上限 | 单测覆盖 | `expert-runner.test.ts`、`schema-validator.test.ts` |
| 22 | 同一 review_set_id 手动重跑不重复发布已成功批次，部分发布失败后可按 batch_index 恢复 | 单测覆盖 | `publish.test.ts` "skips a batch that was already published with a matching findings_digest" |
| 23 | GitHub 单次 Review 容量不足时分批反馈，中间批次 COMMENT，末批次为最终结论，索引完整 | 单测覆盖（本轮补齐末批次真实 event） | `publish-manifest.test.ts`（分批）；`publish.test.ts` "splits into multiple createReview calls..."（本轮 `executePublish` 已改为只在最后一批带真实 event，其余保持 COMMENT，见 `publish.ts` `isFinalBatch` 分支） |
| 24 | 机器人没有 merge 权限，不调用 merge API | CI 配置锁定 | 所有 workflow 权限声明里都没有 `contents: write`；代码库内 grep 不到任何 `merge` API 调用（`octokit.rest.pulls.merge`） |
| 25 | incomplete 状态下的 REQUEST_CHANGES 在 Review body 和摘要评论中带明确"未完整覆盖"横幅 | 单测覆盖（本轮新增） + 沙盒验证 | `incomplete-banner.test.ts`；`publish.test.ts` "includes the incomplete banner in the Review body..."；`summary-comment.test.ts` "shows the incomplete banner at the top..."；**沙盒 PR #6 实测**：真实 CHANGES_REQUESTED Review 顶部与摘要评论均出现横幅（见下） |
| 26 | candidate findings/verifier 调用数/最终 finding 数/Review 批次数触发硬上限时判定 incomplete，不静默截断为 pass | 单测覆盖 | `analyze.test.ts`（各硬上限分支）、`expert-runner.test.ts` |

## 沙盒验证记录（`dustPyrotechnic/pr-review-swarm`，2026-07-22，Phase 3 Task 3.1-3.3）

用 gh CLI 在沙盒仓库（本仓库自身，reusable workflow 按 dogfood 模式指向自身 pinned commit）开两个真实测试 PR：

- **PR #6**（`scripts/sandbox-test-lookup-user.mjs`，故意写入 SQL 注入 bug）：真实跑出 `verdict=incomplete`（因 `any_required_stage_failed`，见下方已知问题）但 `final_findings_count=2`（含一条 critical SQL injection），`final_review_event=REQUEST_CHANGES`，Review 状态确认为 `CHANGES_REQUESTED`，Review body 与摘要评论顶部均正确出现"⚠️ 本次审核未完整覆盖"横幅。**验证了 REQUEST_CHANGES 分支、incomplete 横幅、批次 marker、inline comment 全链路在真实 GitHub 环境下工作正常。**
- **PR #5**（纯文档新增，无 bug）：两次运行都命中 `any_required_stage_failed`（`final_findings_count=0` → `final_review_event=none`），只发了摘要评论、没有提交 Review，符合 Task 3.1 "incomplete+零 finding 只更新摘要" 的设计。**没能在沙盒里实测到 pass 分支（COMMENT + mention）**，因为触发了下方"已知问题"。该分支已由 `publish.test.ts`/`summary-comment.test.ts` 的单测充分覆盖（含 mention 断言）。（本行原先描述的 pass 分支终态是 2026-07-23 已移除的那个行为，2026-07-27 随 `docs-consistency.test.ts` 落地一并修正为 COMMENT。）

### 已知问题：已排查并修复（2026-07-23）

`analyze` 阶段对**纯文档 diff**（无代码内容）曾偶发触发 `any_required_stage_failed`。按 systematic-debugging 流程排查：

1. **加诊断**：`analyze.ts` 的 catch 块此前吞掉了具体错误信息（只设置 `anyRequiredStageFailed = true`），先给 `AnalyzeCoreResult` 加了 `stageFailureReason` 字段并通过 `core.warning` 输出（commit `84dbc01`），不改变行为，只为拿到真实错误文本。
2. **在沙盒里复现**（`dustPyrotechnic/pr-review-swarm` #7，同一份纯文档 diff 反复重跑）：第一次跑通过（`verdict=pass`），第二次真实抓到了错误：`expert-output schema validation: /coverage_complete must be boolean`。
3. **第一次修复尝试（加 1 次 schema-invalid 重试，commit `efa3653`）不成立**：加了重试后再次复现，仍然失败——说明不是单次随机噪声，重试不足以稳定修复。
4. **加更强诊断**（commit `5907ab8`）后再次复现，拿到确凿证据：模型返回的顶层字段是 `{"shard_id":"diff","agent":"generic-security","coverage_complete":"true"}`——`coverage_complete` 被返回成字符串 `"true"` 而不是 JSON 布尔值。
5. **真正的修复**（commit `0777a30`）：在 `expert-runner.ts` 校验前，把 `coverage_complete` 严格等于字符串 `"true"`/`"false"` 的情况归一化成真正的布尔值（只处理这两个精确字符串，其它非法值仍然按校验失败处理，不放宽真正的伪造/损坏数据）。用同一份纯文档 diff 连续验证 2 次，均 `verdict=pass`、无警告。

**额外发现、记录但本次未处理**：证据里 `shard_id` 是 `"diff"`——这不是真实 shard id，说明 prompt 从未把真正的 `shard_id` 告诉过模型（`buildExpertSystemPrompt`/`wrapUntrustedContent` 都没有提及），模型只能瞎编一个看起来合理的值。因为 schema 只要求 `shard_id` 是字符串（不校验取值），这不会导致校验失败，所以不在这次"`/coverage_complete must be boolean`"故障的根因范围内，但值得后续单独处理：调用方（`analyze.ts`）本来就知道真实的 `shardId`/`agentName`，没有必要依赖模型回填这两个字段。

---

# 对抗性测试对账（2026-07-27/28）

按 `docs/plans/2026-07-27-adversarial-test-hardening-plan.md` 附录 B 的要求登记。该计划**不重复**上表 26 条，而是补齐三类空白：把"CI 配置锁定 / 人工阅读"升级为自动化断言、补上对抗性输入的零覆盖、补上不变式与资源压力。

落地后规模：`action` 745 tests / 54 files（起点 305 / 38）+ 7 条 nightly 压力用例；`cli` 69 tests / 12 files（起点 35 / 9）；`benchmarks` 239 tests / 9 files（起点 0）+ 27 个评测用例。

## 逐 Task 产出

| Phase / Task | 产出 | 状态 |
|---|---|---|
| 0.1 统一「机器人永不提交 APPROVE」的规格表述 | `test/docs-consistency.test.ts`（2） | 完成 |
| 1.1 Job 权限隔离 | `test/workflows/{load-workflows.ts,permissions.test.ts}`（10） | 完成 |
| 1.2 禁止 checkout PR head | `src/lib/workflow-ref-scanner.{ts,test.ts}`（22）+ `test/workflows/no-pr-head-checkout.test.ts`（5）；`ci.yml` 的 `forbidden-pr-head-ref-scan` 改为调用扫描器 | 完成 |
| 1.3 第三方 action pin | `test/workflows/action-pinning.test.ts`（3） | 完成 |
| 1.4 Secret 哨兵泄漏 | `test/integration/secret-leak.test.ts`（10） | 完成 |
| 2.1 畸形 LLM 输出语料 | `test/fixtures/malformed-llm-output/`（27 条）+ `src/lib/expert-runner.malformed.test.ts`（35） | 完成 |
| 2.2 prompt injection 矩阵 | `test/fixtures/prompt-injection/corpus.json`（18 载荷）+ `src/prompts/data-boundary.injection.test.ts`（41）+ `test/integration/injection-e2e.test.ts`（38） | 完成（1 点未做，见下） |
| 2.3 verifier 串通 | `test/integration/verifier-collusion.test.ts`（11） | 完成 |
| 3.1 verdict 组合穷举 | `src/lib/verdict.test.ts` 追加块（10 条，160 组合） | 完成 |
| 4.1 覆盖清单守恒 | `src/entrypoints/prepare.test.ts` 追加块（8） | 完成 |
| 4.2 恶意文件名矩阵 | `test/fixtures/{gen-,}malicious-paths.*`（26 条）+ validator/locator 两侧追加 | 完成 |
| 4.3 `introduced_by_pr` 边界 | validator 追加 8 条 + `arbiter.test.ts` 追加 4 条 | 完成 |
| 5.1 伪造 marker 对抗 | `test/integration/forged-marker.test.ts`（7） | 完成 |
| 5.2 finding 守恒 | `test/integration/finding-conservation.test.ts`（7） | 完成 |
| 6.1 Check Run 竞态 | `test/integration/check-run-race.test.ts`（10） | 完成 |
| 6.2 watchdog 边界 | `src/entrypoints/watchdog.test.ts` 追加块（8） | 完成 |
| 7.1 nightly 通道 | `vitest.config.ts` / `vitest.stress.config.ts` / `npm run test:stress` / `.github/workflows/nightly.yml` | 完成 |
| 7.2 超大输入压力 | `src/lib/diff-parser.stress.test.ts`（7，nightly） | 完成 |
| 7.3 artifact 传输攻击 | `src/entrypoints/analyze.artifact-attack.test.ts`（22）+ `src/lib/artifact-reader.ts` + `schemas/analyze-artifact.schema.json` | 完成 |
| 7.4 网络故障与退避 | `src/lib/deepseek-client.network.test.ts`（23） | 完成 |
| 8.1 CLI key 泄漏 | `cli/src/lib/key-leak.test.mjs`（8） | 完成 |
| 8.2 CLI 部署幂等 | `cli/src/lib/deploy-safety.test.mjs`（16） | 完成 |
| 9.0 评测接上真实 analyze 管线 | `benchmarks/lib/{pipeline-entry.ts,pipeline.mjs,case-loader.mjs,split-patch.mjs}` + `{pipeline,case-loader,split-patch,end-to-end}.test.mjs`（32） | 完成（9.1/9.3 的前置阻塞项） |
| 9.1 扩充 benchmark 用例 | `benchmarks/cases/` 27 个用例（13 真阳 / 14 真阴）+ `lib/cases.test.mjs`（139） | 完成 |
| 9.2 评测 CI 门槛 | `benchmarks/thresholds.json` + `pricing.json` + `lib/{metrics,usage-meter}.mjs`（29）+ `nightly.yml` 的 `evaluation` job | 完成 |
| 9.3 稳定性度量 | `findingSetInstability`（Jaccard 配对均值）+ `--repeat=N`，nightly 跑 `--repeat=3` | 完成 |

## 测出并修复的真实缺陷（13 个）

顺序即发现顺序。每一条都是先写测试变红、确认是实现问题、再改实现，没有一条是通过放宽断言变绿的。

| # | 缺陷 | 位置 | 影响 | commit |
|---|---|---|---|---|
| 1 | 4 处第三方 action 未 pin 到完整 SHA | `reusable-pr-review.yml` 的 prepare/analyze/publish | 两处在持有 `DEEPSEEK_API_KEY` 的 Job、一处在持有 `pull-requests: write` 的 Job；可变 tag 被劫持即凭据外泄 | `ef8e315` |
| 2 | DeepSeek key 经错误消息泄漏 | `deepseek-client` 网络错误分支 | HTTP 栈常把含 `Authorization` 头的整个请求放进 message，随后经 `stageFailureReason → core.warning` 进 job 日志（硬禁令 5） | `217ccfd` |
| 3 | 从未调用 `core.setSecret` | `analyze.ts` | Actions 的日志遮罩根本没启用 | `217ccfd` |
| 4 | secret-scanner 漏掉无引号赋值 | `secret-scanner.ts` | `AWS_SECRET_ACCESS_KEY=...` 这类 env 式写法完整送进 prompt（设计文档 L76） | `217ccfd` |
| 5 | `Infinity` 绕过 schema 校验 | `deepseek-client` 的 `JSON.parse` | ajv 的 `type:"integer"` 判定放行 `Infinity`；写 artifact 时 `JSON.stringify` 静默变成 `{"line":null}` | `2475352` |
| 6 | `side: LEFT` 被错误接受 | `deterministic-evidence-validator.ts` | 违反设计文档 L91（要求 `side: RIGHT`）；指向 pre-image 的 candidate 能成为最终 finding。该分支此前零断言 | `985767a` |
| 7-10 | 隐藏 marker 缺发布身份校验（4 个攻击面） | `publish.ts` ×2、`summary-comment.ts` | ① 抄走 marker 让机器人闭嘴（`createReview` 0 次）② 错 digest 拖成 incomplete（拒绝服务）③ 机器人 dismiss 掉**他人**的 Review（正常协作即触发）④ 机器人改写他人评论 | `55408dc` |
| 11 | `patchCheckConclusion` 无重试 | `check-run.ts` | 并发 PATCH 的 409 会打红整个 job，Check 卡在 `in_progress` 直到 30 分钟阈值 | `613ae7b` |
| 12 | `commitHistoryTruncated` 被丢弃 | `watchdog.ts` 的 `run()` | 算出来后从不使用，扫描截断无任何记录（硬禁令 8 的静默截断） | `fb40c60` |
| 13 | `setSecret` 透传含 key 的异常 | `cli/set-secret.mjs` | 只处理了非零退出，`exec` 自身抛出时原样透传 | `869f554` |

另有两个"读取层零校验"缺陷（`artifact-reader` 落地前的 18 条红）与两个网络层缺陷（忽略 `Retry-After`、空响应体抛裸 `SyntaxError`），见 `fbabc48` / `a1cbd7a`；以及 CLI 部署不幂等（`git checkout -b` 在重跑时直接抛裸 git 错误），见 `869f554`。

## 评测层自审发现并修复的缺陷（2026-08-05，6 个）

Task 9.x 落地后又走了一轮自审。这一层的缺陷有个共同特征：**不报错、不影响解析，只让指标悄悄失真**——正是回归评测最容易变成摆设的方式。

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| 1 | `trim()` 把 hunk 末尾的空 context 行当尾部空白删掉 | `benchmarks/lib/split-patch.mjs` | unified diff 里空上下文行写作「单个空格」。删掉它，hunk 就比声明的 `newLines` 少一行；而确定性校验器按 `newStart + newLines - 1` 卡上界，最后一行会被判成「不属于本次 diff 修改的范围」，模型报对了也进不了 findings。表现为召回率莫名偏低 |
| 2 | 4 个用例的 `@@` 头行数与实际不符 | `historical-issue-not-introduced`、`swift-retain-cycle`（**原有用例**）、`lockfile-only-change`、`vendor-dependency-update`（本轮新增） | 同上：声明的 `newLines` 少写一行就会让边界上的 expected 永远无法命中 |
| 3 | `historical-issue-not-introduced` 的 expected 行号指向新文件里不存在的行 | 该用例的 `expected-findings.json`（**原有用例**） | `eval(input)` 实际在新文件第 8 行，expected 写的是 10。它此前能"通过"，只是因为错误的 `@@ +1,10` 恰好把上界撑到了 10。两个错误互相掩盖 |
| 4 | 夹具检查漏掉被分类器跳过的文件 | `benchmarks/lib/cases.test.mjs` | 缺陷 2 里有两个正是 lockfile / vendor 用例：它们不走行号校验，所以计数错误藏在了没人看的地方。新增的「`@@` 声明行数必须等于实际行数」断言覆盖全部用例，刻意不复用 `parsePatch`（它根本不读声明的行数，用它验证等于让被测对象给自己打分） |
| 5 | p95 延迟度量的是单次 HTTP 请求，不是一次审核 | `benchmarks/run-evaluation.mjs` | `max_p95_latency_ms` 是 300000ms（5 分钟），显然针对一次完整 PR 审核。拿单请求延迟（秒级）去比，这条门槛等于从未生效。改为在 `runAnalysis` 外层端到端计时，单请求 p95 降级为诊断输出 |
| 6 | 多个 vitest worker 并发写同一个 esbuild bundle | `benchmarks/lib/pipeline.mjs` | 一个 worker 会 require 到另一个正写到一半的产物，报 `Unexpected end of input`——随机红、换台机器复现不了。第一次用 `process.pid` 隔离**没有修好**：vitest 默认的 worker 池是 `worker_threads`，多个 worker 是同一进程里的线程，pid 完全相同。改用随机后缀后 8 次连跑稳定 |

另外补了两处健壮性：`toPrepareArtifact` 的 `classifyFile` 从「可选、缺失则全部按 reviewed 处理」改为必传（缺失即抛错）——那个兜底一旦被忘掉，lockfile / vendor / 生成文件会统统送进模型，那几条误报陷阱用例静默失效而指标看着正常；以及 `run-evaluation.mjs` 主流程此前一行都没被执行过（缺 key 时首步即退出），新增 `--base-url` 与 `lib/run-evaluation.test.mjs`，对着本地 mock 跑完整流程（参数解析、指标汇总、六道门槛、退出码、上游 500 → incomplete），不花钱也不依赖网络。

## 与计划的偏差（均以源码/真实约束为准）

1. **Task 1.1** 「每个 job 都显式声明 permissions」按原样会红：`ci.yml` 走 workflow 级声明。拆成两条——信任链 workflow 要求 job 级，其余只要求不吃仓库默认权限。`ci.yml` 同样排除在 Task 1.3 的 pin 范围外（计划自身已授权）。
2. **Task 1.1** 计划的 `checks: write` 白名单会误伤 `caller.yml` 的 `uses:` 壳 job（GitHub 要求壳 job 声明被调用方权限的并集）。改为只约束真正执行步骤的 job，另加一条更强的"壳 job 权限恰好等于被调用方并集"断言。
3. **Task 2.1** 计划假设的 `validateExpertOutput(raw: string)` 不存在；真实导出是 `validate(schemaId, data)`，解析层在 `deepseek-client` 里。改为驱动真实客户端 + 注入 `fetchImpl`。
4. **Task 2.1** 计划要求语料"一律拒绝"，但按真实 schema 有 3 条本就合法（`coverage-complete-string` 的归一化例外、`exp-line` 的 `1e2` 即整数 100、`maxitems-exact` 应触发 `hardLimitHit`）。强行要求它们失败等于伪造断言，故分桶处理。
5. **Task 3.1** 计划把 `stale_cancelled` 列为 `computeVerdict` 的第四个输出值。实际 `Verdict` 只有三个值，`stale_cancelled` 是 publish 层终态（`publish.ts:50`），在身份元组不匹配时短路，不经过 `computeVerdict`。改为断言它产不出该值。
6. **Task 4.2** 计划建议用 spy 包住 `readFileSync` 检查路径。两个被测模块根本不碰文件系统，改为源码级断言"搜不到 `node:fs`/`node:path`"——锁的是"没有读取能力"而非"这次没读到外面"。
7. **Task 6.1** 计划把 409 与 422 并列为"按重试策略处理"。按真实语义拆开：409 是并发冲突可重试；422 表示请求不可处理，重试无意义且静默吞掉会藏起真正的载荷错误。
8. **Task 6.2** 计划要求"摘要评论出现 commit 历史过长的降级说明"。watchdog job 没有 `issues: write`，为此扩权会违反硬禁令 6。改为 `core.warning` 写进 job 日志。
9. **Task 7.3 / 7.4** 计划归在 nightly，归类理由是"跑得慢"。这两组是毫秒级用例，放进 PR 阻塞通道价值更高，故留在默认通道。
10. **Task 9.1** 计划只列了真阳性 12 条、真阴性 9 条，按"至少 1:1"的自订要求会差 3 条。补了 `swift-optional-chaining-safe` / `go-error-checked-via-helper` / `documented-nolint-suppression` / `moved-code-no-semantic-change` 四条真阴性，最终 13 真阳 / 14 真阴。
11. **Task 9.2** 计划的 `thresholds.json` 没有行号容差项。精确到行会把"模型其实找到了、但指在函数签名行"判成漏报 + 误报的双重惩罚，让召回率失真。新增显式的 `line_tolerance: 2`（category 仍要求精确相等），是配置项而非藏在代码里的魔数。
12. **Task 9.2** 的 `max_cost_usd_per_pr` / `max_p95_latency_ms` 在计划里没有数据来源——`sendStructuredRequest` 只返回业务 JSON，API 的 `usage` 字段到不了调用方。改为在 `DeepSeekClientOptions.fetchImpl` 这个既有注入点上包一层计量（`lib/usage-meter.mjs`），**不为评测改动生产代码**。读不到 `usage` 时计入 `missingUsage` 并判定门槛未生效，而不是静默按 0 计算——否则 API 改字段名之后成本门槛会永远绿灯。
13. **误报与陷阱命中取「最差一轮」而非均值**（计划未规定聚合方式）。误报是这个产品的头号杀手，用均值会把"每五轮爆一次"稀释成看着还行的小数。召回率仍取均值，它衡量的是典型能力。

## 阻塞项与明确不做的部分

- **Task 9.1 / 9.3 的阻塞项已解除**（2026-08-05）：`run-evaluation.mjs` 原先是个桩（`const findings = []` + TODO），从不调用 analyze 管线；新增用例无从验证、稳定性无从测量。现已接上真实管线——`benchmarks/lib/pipeline.mjs` 用 action 自己的 esbuild 把 `action/src` 现场打成 bundle，评测跑的是和 `npm run build` 同一份源码，而不是一套为了好测而写的平行实现。`--gate` 在缺 `DEEPSEEK_API_KEY` 时仍然直接失败，不退化成恒绿空跑。
- **Task 2.2 的第 4 点未做**（"注入载荷不会被原样写进 Review body"）：PR 描述本就不进 Review body，而 finding 的 `evidence` 进 Review body 是设计意图。为它造一条"必须转义"的规则等于凭空发明需求，**设计上不适用**。若将来确定要防"二次注入下游工具"，那是一个新需求而非现有规格的补测。
- **回归评测从未用真实模型跑过**：接线由 `end-to-end.test.mjs`（fake LLM 驱动真实 `runAnalysis`）与 `cases.test.mjs`（用生产的 `parsePatch` / `classifyFile` / 确定性校验器验证全部 27 个用例）证实，但**首轮真实指标尚未产生**——本机没有 `DEEPSEEK_API_KEY`。`thresholds.json` 里的六个门槛值目前是计划给的先验值，不是从实测分布里定出来的。中央仓库配好 secret、nightly 首次跑通之后，需要按实测结果复核一遍门槛：`min_recall` 定太高会天天红，定太低就没有护栏作用。
- **计划附录 A 的 5 项仍需沙盒人工验证**，本轮未覆盖，理由不变（fork PR 的真实凭据可见性、分支保护真实拒绝 dismiss、`cancel-in-progress` 真实时序、required check 真实门禁、真实模型在注入语料下的行为）。
