# PR Review Swarm — Phase 2（Comment-only）实施方案

> **状态：草案，待您确认。本文档只做方案设计，不写实现代码。**
> 依据：`docs/plans/2026-07-13-pr-review-swarm-design.md`（"批量发布与 GitHub 对象"节，design 文档行号下称 D-L*）+ `docs/plans/2026-07-18-pr-review-swarm-implementation-plan.md`（Task 2.1-2.3，下称 plan 文档）。

## 0. 前提与范围

**Phase 1 现状（已完成并验证，见 2026-07-21 验证记录）：** shadow mode 全部代码通过 CI 等价检查；`publish.ts` 只计算 verdict、写 job summary，不持有 `pull-requests:write`/`issues:write`，也不引用任何 GitHub 写方法。

**Phase 2 目标（对应 plan 文档 L830-864）：** 让 `publish.ts` 真正把结果写回 GitHub —— 固定摘要评论 + 批量 Review（含 inline comment）—— 但**无论裁决结果是什么，最终一批永远是 `event: 'COMMENT'`**，绝不产出 `REQUEST_CHANGES`/`APPROVE`。PR 上会看到评论和 inline comment，但 PR 的审核状态（绿勾/红叉）不受影响，只有 Check Run 会显示真实 verdict。

**不在本阶段范围内（留给 Phase 3，Task 3.1-3.3）：**
- `REQUEST_CHANGES`/`APPROVE` 分支、incomplete 横幅、`default_mention`。
- watchdog 里 `checkForPublishedFinalReview` 从"永远返回 null"换成真实实现（Phase 2 阶段 watchdog 对孤儿 Check 仍然一律判 `timed_out`，因为还没有真正的最终 Review 可供回填）。

**当前代码里需要注意的既有实现（会被 Phase 2 直接修改）：**
- `action/src/entrypoints/publish.ts` 里 `reviewSetId` 目前用 `` `${context.runId}-${attempt}` `` 占位（Phase 1 阶段随便传的），**不符合设计文档 D-L196 的派生规则**（必须是身份元组 + engine/policy/model/schema 版本 + findings 集合摘要），这是 Phase 2 要替换掉的第一个技术债，不是新增需求。
- `check-run.ts`、`github-client.ts` 已有的 octokit 封装可以直接复用，不需要重新造 REST 调用的基础设施。

---

## 1. 待确认项（Phase 2 专属，风格延续原实施计划的 A-H 表）

| # | 待确认项 | 设计文档依据 | 本方案默认提案 |
|---|---------|-------------|----------------|
| P2-A | 单批 Review 容量上限的具体数值（超过则需要分批） | D-L204"若容量不足…" 未给出具体数字，只说明"单次 Review 或正文容量" | GitHub 官方限制：单个 Review body ≤ 65536 字符，单次 `createReview` 请求的 `comments` 数组本身没有官方硬性文档数字，但实践上单请求 payload 过大（>~50 条 inline comment 或正文接近 65536 字符）容易超时/被拒。提案：**按 `central-limits.json` 新增 `maxFindingsPerReviewBatch`（默认 20，与既有 `maxReviewBatchesPerRun: 20` 配合，理论最多单轮 400 条 finding，远高于 `maxFinalFindingsPerRun: 200`，实际不会撞到 batch 数上限）+ 正文字符预算 `maxReviewBodyChars`（默认 60000，留安全余量）**，任一维度先触达就切下一批。 |
| P2-B | inline comment 与 Review body 摘要的分工（哪些字段进 inline，哪些字段只进摘要评论） | D-L215"inline comment 发布前必须确认 path/line/side…属于锁定 head_sha 的原始 diff hunk…定位失败则降级到 Review body" | 每条 finding 优先尝试 inline comment（`path/line/side` 能在 prepare 阶段记录的 hunk 范围内定位）；定位失败（重命名/删除/上下文行漂移）的 finding 整条正文降级追加到该批 Review body 末尾的"未能定位到具体行的问题"小节，不丢弃。 |
| P2-C | `findings_digest` 的具体摘要算法 | D-L196 只说"finding ID 列表的摘要"，未给算法 | 提案：对该批次内所有 finding 的 `id` 排序后用 `sha256` 摘要，取前 16 位十六进制作为 `findings_digest`（人类可读、足够防碰撞，且是纯函数，不依赖顺序）。 |
| P2-D | `review_set_id` 的具体派生算法 | D-L196："身份元组 + engine/policy/model/schema 版本 + 最终 findings 集合内容摘要" | 提案：`sha256(JSON.stringify({identity_tuple, engine_revision, policy_revision, model, schema_version, findings_digest_of_full_set}))` 取前 20 位十六进制。`engine_revision` 取当前 action 的 git short SHA（构建时通过 esbuild `define` 注入，Phase 2 新增一个小的构建期步骤）；`policy_revision` 暂时固定为 `central-limits.json` 的内容摘要（限额变化即视为 policy 变化）；`schema_version` 取 `finding.schema.json` 的 `$id` + 一个手动维护的版本号。 |
| P2-E | 隐藏 marker 的具体正则/编解码容错策略 | D-L206 给出了格式范例 `<!-- pr-review-swarm:review_set_id=<id>;batch=<batch_index>/<batch_count>;digest=<findings_digest> -->` | 严格按此格式；解析失败（字段缺失、非本机器人产生的类似格式）一律当作"不是本机器人的 marker"跳过，不抛异常中断整个对账流程（外部评论/其它 bot 也可能长得像，容错优先）。 |
| P2-F | 固定摘要评论的稳定身份 marker 具体格式 | D-L227 只给出字段组成 `repo/pr/bot/summary`，未给出具体编码 | 提案：`<!-- pr-review-swarm:marker=summary;repo=<owner>/<repo>;pr=<number> -->`，与批次 marker 用不同的 `marker=` 前缀区分，避免解析时混淆。 |
| P2-G | Phase 2 阶段 `publish` Job 的重试语义（`maxPublishRetries: 5` 如何与"分批对账"结合） | D-L204"重试时按 review_set_id+batch_index 逐批对账" + plan 文档 Task 2.3 | Phase 2 阶段先只做**单次运行内的对账**（同一次 `publish` entrypoint 调用中，若中途某一批失败，捕获后按 `findings_digest` 重新查询已发布批次再续发，不是"重跑整个 workflow"意义上的重试）。跨 workflow 重跑（例如 `publish` Job 本身失败后 Actions 层面的 job 重试）复用同一套对账代码路径，不需要额外分支——因为对账本来就是幂等设计。`maxPublishRetries` 用作"单次运行内对某一批 API 调用失败时的指数退避重试次数"，与批次对账是两回事，命名容易混淆，会在代码注释里明确区分。 |

以上任何一项如有不同意见，请在开工前告诉我；否则按默认提案执行。

---

## 2. 任务分解

### Task 2.0：central-limits 与 schema 补充（前置，Phase 2 专属新增字段）

**Files：**
- Modify: `action/config/central-limits.json` — 新增 `maxFindingsPerReviewBatch`（默认 20）、`maxReviewBodyChars`（默认 60000）。
- Modify: `schemas/verdict.schema.json` — 目前 `final_review_event` 枚举已包含 `COMMENT`，无需改动；确认 `review_set_id` 字段仍是自由字符串，无需改动。
- 无需新增 schema 文件（隐藏 marker、summary marker 都是纯文本格式，不需要 JSON Schema）。

**验收标准：** `central-limits.json` 新字段有对应单测（读取存在、缺失时的默认值处理逻辑，复用 Task 1.1 已有的 schema-validator 机制或简单读取）。

### Task 2.1：固定摘要评论模块

**Files：**
- Create: `action/src/lib/summary-comment.ts`
- Test: `action/src/lib/summary-comment.test.ts`

**接口设计：**
```typescript
export interface SummaryCommentContext {
  owner: string; repo: string; prNumber: number;
  headSha: string; baseSha: string;
  engineRevision: string; policyRevision: string;
  model: string; schemaVersion: string;
  verdict: string; reviewSetId: string;
}

export function buildSummaryCommentBody(
  ctx: SummaryCommentContext,
  verdictSummary: VerdictSummary,
  findings: Finding[],
): string;

export function findStableMarkerId(): string; // repo/pr/bot/summary 编码（P2-F）

export async function upsertSummaryComment(
  octokit: Octokit,
  ctx: SummaryCommentContext,
  body: string,
): Promise<{ commentId: number; action: 'created' | 'updated' }>;
```

**算法要点：**
1. `upsertSummaryComment` 先 `GET /repos/{owner}/{repo}/issues/{pr}/comments`（分页），客户端过滤出正文包含稳定身份 marker（P2-F）且 `user.type === 'Bot'`（或按 `github_token` 对应的 actor login 过滤，具体判据在实现期确认哪个更可靠）的评论。
2. 找到 → `PATCH`；未找到 → `POST`。
3. 评论正文结构：人类可读部分（verdict、覆盖率、findings 索引表、失败原因、"如何重试"说明）+ 末尾隐藏的可变结果 marker 区块（P2-F 之外再加一段可变字段的 HTML 注释，字段列表见 D-L227）。

**验收标准：**
- 单测覆盖"已存在摘要评论→更新"与"不存在→创建"两条路径（mock octokit）。
- 单测覆盖"存在多条相似评论（例如历史遗留），只精确匹配稳定 marker 的第一条"。
- 单测覆盖 body 长度超过 GitHub 评论上限（65536 字符）时的截断策略（提案：超限时保留 findings 索引表头部 + "共 N 条问题，完整列表见 Review 批次"的引导语，不整体失败）。

### Task 2.2：review_set_id / 批量发布 manifest / 隐藏 marker

**Files：**
- Create: `action/src/lib/review-set-id.ts`
- Create: `action/src/lib/publish-manifest.ts`
- Create: `action/src/lib/hidden-marker.ts`
- Test: 各自 `.test.ts`

**`review-set-id.ts` 接口：**
```typescript
export interface ReviewSetIdInput {
  identityTuple: SchemaIdentityTuple;
  engineRevision: string;
  policyRevision: string;
  model: string;
  schemaVersion: string;
  findings: Finding[]; // 最终集合，顺序无关
}
export function computeFindingsDigest(findings: Finding[]): string; // P2-C
export function computeReviewSetId(input: ReviewSetIdInput): string; // P2-D
```

**`publish-manifest.ts` 接口：**
```typescript
export interface ReviewBatch {
  batchIndex: number;
  batchCount: number;
  findings: Finding[];
  findingsDigest: string;
  event: 'COMMENT'; // Phase 2 硬约束，见 Task 2.3
}
export function planReviewBatches(
  findings: Finding[],
  limits: { maxFindingsPerReviewBatch: number; maxReviewBodyChars: number },
): ReviewBatch[];
```
算法：按 finding 顺序贪心装批，任一维度（条数达到 `maxFindingsPerReviewBatch` 或估算正文长度超过 `maxReviewBodyChars`）先触达就切换到下一批；`batchCount` 在全部分批完成后回填每个 `ReviewBatch.batchCount`。

**`hidden-marker.ts` 接口：**
```typescript
export interface BatchMarker { reviewSetId: string; batchIndex: number; batchCount: number; digest: string; }
export function encodeBatchMarker(m: BatchMarker): string; // 追加到 Review body 末尾
export function decodeBatchMarker(body: string): BatchMarker | undefined; // 容错见 P2-E
export function isOwnedByThisBot(review: { body: string | null }): boolean; // decodeBatchMarker 非 undefined 即为真
```

**验收标准：**
- `computeReviewSetId`：同一输入两次调用结果相同（纯函数）；findings 集合任一条内容变化 → ID 变化；顺序打乱 → ID 不变（因为 digest 先排序）。
- `planReviewBatches`：0 条 finding → 返回恰好 1 个空批次（用于"完整审核、零问题"场景下仍需发一条收尾说明，具体是否发布由 Task 2.3 决定，这里只负责分批规划本身对 0 条也要有确定行为）；超过单批上限 → 正确分裂为多批，`batchCount` 一致。
- `decodeBatchMarker`：格式错误、字段缺失、非本机器人格式 → 返回 `undefined` 而不是抛异常。

### Task 2.3：publish.ts 真实写入路径（COMMENT-only）

**Files：**
- Modify: `action/src/entrypoints/publish.ts`
- Test: `action/src/entrypoints/publish.test.ts`（追加用例，保留 Phase 1 已有用例）

**新流程（在现有 `buildPublishResult` 纯函数基础上，新增一层真正调用 GitHub API 的编排函数，例如 `executePublish`，`run()` 改为调用它）：**

1. identity-tuple 复核（沿用 Phase 1 逻辑，不一致 → `stale_cancelled`，Phase 2 阶段 `stale_cancelled` 仍然**不发布任何内容**，与 Phase 3 行为一致，D-L153 附近的语境）。
2. 计算 `reviewSetId`（Task 2.2）。
3. **旧 `review_set_id` 收尾**（D-L211-213）：`GET /repos/{owner}/{repo}/pulls/{pr}/reviews`，用 `decodeBatchMarker` 找出当前 `head_sha` 上其它 `review_set_id` 的已发布批次；Phase 2 阶段这些旧批次**只可能是 `COMMENT` 事件**（因为 Phase 2 从未发布过 `REQUEST_CHANGES`/`APPROVE`），所以不会触发 D-L211 的 dismiss 分支，只需要对旧批次执行"追加取代说明"（`PATCH` Review body 前插入提示 + `PATCH` 对应 inline comment 前插入提示）。**dismiss + 403 降级路径的完整实现推迟到 Phase 3**（那时才会真正产生需要 dismiss 的 `REQUEST_CHANGES`/`APPROVE`），但 Task 2.2 的 `hidden-marker.ts` 已经把接口设计成 Phase 3 可以直接复用，不需要返工。
4. `planReviewBatches` 规划本轮批次，全部批次 `event` 固定为 `'COMMENT'`（Phase 2 硬约束，**代码里不出现 `REQUEST_CHANGES`/`APPROVE` 字面量**，用一个 lint 规则或简单 grep 断言锁住，延续 Phase 1 对 publish.ts 的写方法锁思路）。
5. 逐批调用 `octokit.rest.pulls.createReview`（`commit_id: currentIdentityTuple.headSha`，`event: 'COMMENT'`，`comments: [...]` 为能定位的 inline finding，定位失败的 finding 追加进 `body`），body 末尾附加 `encodeBatchMarker`。
6. 每批发布前先按 `findings_digest` 查询是否已存在等价的已发布批次（本次运行内的对账，P2-G），一致则跳过、不重复发布。
7. 全部批次成功后调用 `upsertSummaryComment`（Task 2.1）。
8. 输出 `VerdictSummary`，`final_review_event` 现在如实反映"该批次用的是 COMMENT"（而不是 Phase 1 里硬编码的 `'none'`）——这是 Phase 2 对 `VerdictSummary` 语义的一处调整，需要同步检查 `status-finalize.ts` 消费该字段的地方是否有隐含假设（目前 `status-finalize.ts` 只读 `verdict.verdict` 字段，不读 `final_review_event`，预期无需改动，但实现期要复核一遍）。

**Files（权限声明更新）：**
- Modify: `.github/workflows/reusable-pr-review.yml` — `publish` Job 的 `permissions` 追加 `pull-requests: write`、`issues: write`。

**验收标准（对应 plan 文档 Task 2.3 验收标准，逐条落到本仓库现有测试风格）：**
- 单测：单批容量足够 → 只发一次 `createReview`，`event: 'COMMENT'`。
- 单测：容量不足需要分批 → 多次 `createReview` 调用，每次 body 都带正确的 `batch_index/batch_count`，全部 `event: 'COMMENT'`。
- 单测：本次运行内重复调用（模拟重试）→ 按 `findings_digest` 对账，已发布批次不重复调用 `createReview`。
- 单测：`findings_digest` 不一致（理论不应发生，见待确认 P2-G 的讨论）→ 整体判 `incomplete`，不静默覆盖。
- 单测：存在其它 `review_set_id` 的旧批次 → 被追加取代说明（`pulls.updateReview` / `pulls.updateReviewComment` 各一次断言）。
- 单测：`stale_cancelled` 路径不调用任何写 API（沿用 Phase 1 已有断言风格）。
- 静态锁：grep 断言 `publish.ts` 源码不出现 `'REQUEST_CHANGES'`/`'APPROVE'` 字面量（Phase 2 专属，Phase 3 会移除这条锁并替换成真实分支）。
- 集成测试（人工，在沙盒仓库执行，非自动化用例）：PR 收到摘要评论和 inline comment，Check Run 显示真实 verdict，但 PR 顶部的"审核"状态区域不出现红叉/绿勾变化。

---

## 3. 实现阶段记录

> 本节为进度追踪表，Phase 2 实际开工后逐项勾选/回填 commit。**当前状态：尚未开始编码，等待您对上述方案与待确认项 P2-A~G 的确认。**

| 阶段 | Task | 状态 | 备注 / commit |
|------|------|------|----------------|
| 2.0 | central-limits 新增字段 + 单测 | ⬜ 未开始 | |
| 2.1 | `summary-comment.ts` + 测试 | ⬜ 未开始 | |
| 2.2 | `review-set-id.ts` / `publish-manifest.ts` / `hidden-marker.ts` + 测试 | ⬜ 未开始 | |
| 2.3 | `publish.ts` 真实写入路径 + 测试 | ⬜ 未开始 | |
| 2.3b | `reusable-pr-review.yml` 权限更新 | ⬜ 未开始 | |
| 2.4 | 集成测试（沙盒仓库人工验证，plan 文档 Task 2.3 验收标准最后一条） | ⬜ 未开始 | 需要您在沙盒仓库执行，非代码可完成 |
| 2.5 | Phase 2 退出检查（对照 plan 文档"上线门槛②"，确认评论/inline comment 正常出现且审核状态不受影响） | ⬜ 未开始 | |

状态取值：⬜ 未开始 / 🔶 进行中 / ✅ 完成 / ⚠️ 阻塞（附阻塞原因）。

---

## 4. 与 Phase 3 的边界（避免 Phase 2 实现时"顺手"越界）

- `hidden-marker.ts`/`publish-manifest.ts` 的接口设计已考虑 Phase 3 复用（dismiss 403 降级、`REQUEST_CHANGES`/`APPROVE` 分支），但 Phase 2 阶段**不实现**这些分支，只留出干净的扩展点（新增 `event` 类型、新增 verdict 分支）。
- `default_mention`（`repo-config.schema.json` 已有字段占位）在 Phase 2 阶段不被读取、不出现在摘要评论里，Phase 3 Task 3.1 才启用。
- incomplete 横幅（Task 3.2）不在 Phase 2 摘要评论里出现固定模板，只是把 `incomplete_reasons` 数组原样列出（Phase 1 已有的朴素展示方式延续）。
