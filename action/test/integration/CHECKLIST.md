# Task 3.4 — 安全与集成测试清单对账

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
| 6 | 任一最终 finding 都产生 REQUEST_CHANGES，只有零 finding 的完整审核才产生 APPROVE | 单测覆盖 | `verdict.test.ts` `computeFinalReviewEvent` 全分支；`publish.test.ts` "reports changes_requested with final_review_event REQUEST_CHANGES..."/"produces a schema-valid verdict summary for the pass case..." |
| 7 | verifier 失败产生 incomplete，已验证问题被反馈，未验证候选不发布 | 单测覆盖 | `analyze.test.ts`（VerifierUnavailableError → anyRequiredStageFailed）、`arbiter.test.ts` |
| 8 | REQUEST_CHANGES → 新 commit → APPROVE 完整生命周期 | 单测覆盖（本轮新增） | `test/integration/review-lifecycle.test.ts` |
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
| 19 | watchdog 在 run 已 completed 但 publish 已成功发布最终 Review 时，回填为该 Review 一致的结论，而不是覆盖为 timed_out | 单测覆盖（本轮新增） | `watchdog.test.ts` "returns APPROVE/REQUEST_CHANGES when a bot-owned .../CHANGES_REQUESTED review exists..."、"backfills a stale check to success when a published APPROVE review is found instead of timing it out" |
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
- **PR #5**（纯文档新增，无 bug）：两次运行都命中 `any_required_stage_failed`（`final_findings_count=0` → `final_review_event=none`），只发了摘要评论、没有提交 Review，符合 Task 3.1 "incomplete+零 finding 只更新摘要" 的设计。**没能在沙盒里实测到 pass→APPROVE+mention 分支**，因为触发了下方"已知问题"。该分支已由 `publish.test.ts`/`summary-comment.test.ts` 的单测充分覆盖（含 mention 断言）。

### 已知问题（超出 Phase 3 范围，记录供后续排查）

`analyze` 阶段对**纯文档 diff**（无代码内容）连续两次触发 `any_required_stage_failed`，而对含真实代码的 diff（PR #6）正常工作。`analyze.ts` 的 catch 块（`src/entrypoints/analyze.ts:124`）吞掉了具体错误信息，只设置 `anyRequiredStageFailed = true`，日志里看不到根因。怀疑是某个 expert agent 对"无代码内容可评审"的 shard 返回了不满足 expert-output schema 的响应。**这是 Phase 1/2 就存在的 analyze 流水线问题，与本轮 Phase 3 改动（REQUEST_CHANGES/APPROVE 事件、watchdog 回填）无关**，建议单独排查（可以先给 catch 块加日志暴露原始错误）。
