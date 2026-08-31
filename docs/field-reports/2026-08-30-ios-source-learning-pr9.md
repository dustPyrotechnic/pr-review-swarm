# 外部真实 PR 实测报告：ios-source-learning#9

> 面向 agent 的实测记录。数据全部取自 GitHub API（reviews / review comments / actions logs），不含推测。
> 采集时间 2026-08-30。若要复核，见文末「复现命令」。

## 1. 一句话结论

在一个 680/-17 行的真实 shell PR 上，本项目连续跑了 **18 轮审核**、产出 **62 条 inline finding**，其中 **12 条（19.4%）在正文里自己论证了「不构成缺陷」却仍然发布**，**5/17 轮 verdict=incomplete**（根因全部是模型输出不合 schema），并且**在同一个 head_sha 上跑两次得到交集为 0 的结论**。这不是召回问题，是**发布门禁、严重度校准和稳定性**的问题。

## 2. 被审对象

| 项 | 值 |
|---|---|
| PR | [XiyouMobile3G-iOS/ios-source-learning#9](https://github.com/XiyouMobile3G-iOS/ios-source-learning/pull/9) |
| 标题 | feat: bootstrap / update-sources 下载时显示进度条 |
| 状态 | MERGED（2026-08-30T00:45:10Z），reviewDecision = CHANGES_REQUESTED |
| 规模 | 7 文件，+680 / −17，19 个 commit |
| 文件 | `progress.sh`(+262 新增)、`tests/progress.test.sh`(+305)、`bootstrap.sh`、`update-sources.sh`、`sources.sh`、`README.md`、`AGENTS.md` |
| base / final head | `a7f14e35` / `9d434a41` |
| 引擎 | `engine_revision=a6431acf`（v1.1.1）、`policy_revision=7c76bdf30017`、`model=deepseek-chat`、`schema_version=finding-v1` |

作者是本项目作者本人（dustPyrotechnic），即这是一次**自有仓库的真实使用**，不是评测夹具。

## 3. 审核时间线（18 轮）

`verdict` 一列为空表示 complete。全部 17 个 `pull_request_target` run 的 Job 结论都是 **success**——incomplete 只以 `##[warning]` 形式出现在 analyze 日志里。

| # | 提交时间 (UTC) | review_set_id | findings | verdict / 根因 |
|---|---|---|---|---|
| 1 | 08-28 06:51:06 | `5a0632f6…` | 3 | |
| 2 | 08-28 07:10:40 | `4a6dd8ab…` | 1 | |
| 3 | 08-28 07:40:02 | `601cacd8…` | 2 | |
| 4 | 08-28 08:01:22 | `99cfe74d…` | 3 | |
| 5 | 08-28 08:27:55 | `ede70ce4…` | 4 | |
| 6 | 08-28 09:07:01 | `aba6aa48…` | 1 | **incomplete** — expert-runner: `/candidate_findings/0 must have required property 'source_agent'` |
| 7 | 08-28 09:29:58 | `5ef6234a…` | 3 | |
| 8 | 08-28 11:53:21 | `fb3a565b…` | 1 | **incomplete** — deepseek-client: `tool call arguments are not valid JSON` |
| 9 | 08-28 12:34:09 | `da930601…` | 5 | |
| 10 | 08-28 12:55:04 | `c72f1d8f…` | 1 | |
| 11 | 08-28 13:00:00 | `0931f155…` | 6 | |
| 12 | 08-28 13:06:13 | `79c5da27…` | 2 | **incomplete** — expert-runner: 多条 `candidate_findings` 缺 `source_agent` |
| 13 | 08-29 11:22:41 | `acd7f314…` | 6 | |
| 14 | 08-29 11:28:00 | `c41049ce…` | 4 | |
| 15 | 08-29 11:34:44 | `9fa06acc…` | 6 | **incomplete** — deepseek-client: `tool call arguments are not valid JSON` |
| 16 | 08-29 11:43:09 | `96e14440…` | 7 | |
| 17 | 08-29 11:49:31 | `74917563…` | 4 | **incomplete** — verifier-client: `verifier response failed schema validation: (root) must have required property 'status'` |
| 18 | 08-30 00:47:13 | `d0f5b4c6…` | 3 | **合并后触发**，见 P9 |

- 第 1–17 轮的第 17 轮是合并前最后一轮，state=`CHANGES_REQUESTED`；前 16 轮全部被 dismiss。
- 第 18 轮在 PR 已 merged 后提交，state 同样是 `CHANGES_REQUESTED`。
- 只有 1 条 issue comment（摘要贴），从第 1 轮起**原地编辑**，最终内容是第 17 轮的 4 条 finding。摘要贴的更新策略是对的。

## 4. Findings 统计

```
总数 62
严重度   low 37 (59.7%) / medium 20 (32.3%) / high 5 (8.1%)
按文件   progress.sh 32 / bootstrap.sh 14 / update-sources.sh 10 / sources.sh 5 / README.md 1
锚点     50 个不重复 (path,line)，12 条落在重复锚点上
自我否定 12 条 (19.4%)
```

跨轮反复出现的同一主题（说明修完又被换个说法再报）：

| 主题 | 出现轮次 |
|---|---|
| clone/fetch 计数对齐（`CLONE_TOTAL`/`CLONE_DONE`/`FETCH_DONE`） | 1, 4, 5, 7, 11, 13, 15, 17 |
| `source_redact_url` 凭据脱敏不彻底 | 5, 9, 11(×2), 13, 14, 16 |
| `RETURN` trap 清理临时日志 | 2, 9, 10, 12 → 作者最终在 `54ba3e71` 直接删掉整套 trap |
| 子 shell / `PIPESTATUS` / `set -e` 退出码 | 12, 13, 15, 16 |
| 阶段表与并行数组重复 | 4, 11, 13, 14, 16, 17 |

## 5. 审核中暴露的问题

按「该不该先修」排序。P1–P4 是审核质量，P6–P9 是流程/工程，P10–P12 是收敛性。

### P1（最严重）自我否定的 finding 仍然发布

12 条 finding 在正文里完成推理后明确写出「不构成缺陷」「无实际缺陷」「无需修改」「无问题」，建议字段直接写「**无。**」，但依然作为 finding 发出去，并参与 `REQUEST_CHANGES` 判定。

典型（第 13 轮，标 **[high]**，锚 `bootstrap.sh:210`）：

> **[high] git_run_progress 的 git_rc 捕获子 shell 在调用方 set -e 下可能不返回退出码**
> …两个调用点都在控制结构中，退出码被正确处理。**不构成缺陷。**
> **无。**

第 5 轮那条 [high] 更极端：整段正文推翻自己三次，结尾「总体计数与执行集一致。」，建议「无。」。

- **根因假设**：severity 字段在推理之前就被填好，专家 agent 写完否定结论后没有回写 severity，arbiter/verifier 也没有「结论为无缺陷 → 丢弃」这一道门。
- **建议**：在 arbiter 前加一个硬门——finding 的建议字段为空/「无」/「无需修改」，或正文命中否定式结论模式时，直接丢弃，不进 publish。这是本次最高性价比的修复。

### P2 finding 标题被当成草稿纸

标题字段里出现推理过程和自问自答：

- 第 6 轮：`[low] Non-progress lines from git stderr written verbatim into a predictable? no, mktemp temp log then catted`
- 第 11 轮：`[medium] update-sources dry-run counts FETCH_DONE only in success path; but line 93-96 dry-run branch sets fetched=1 and breaks — fetched counter consistent. However FAILURE path…`

标题应是结论的一句话陈述。建议在 schema 层加长度上限 + 禁止 `?`/`however`/`but` 这类未定型措辞，或让 verifier 重写标题。

### P3 严重度校准失效

5 条 `[high]` 里：3 条自我否定（P1），1 条（第 15 轮 `bootstrap.sh:203`「git clone 从 --quiet 改为 --progress，非终端也强制输出进度」）描述的是**这个 PR 的既定意图**，正文里还自己反复横跳（「所以非终端实际仍静默？不：…」），建议是「若需非终端原生进度，可保留」——这是设计取舍不是缺陷。

真正站得住的 `[high]` 只有 1 条：第 13 轮 `update-sources.sh:104`，dry-run 分支 `fetched=1; break` 却不递增 `FETCH_DONE`，进度条恒定偏低。命中率 1/5。

### P4 结论跨轮自相矛盾

同一处代码，不同轮给相反结论：

| 位置 | 一轮 | 另一轮 |
|---|---|---|
| `update-sources.sh:254` dry-run 计数 | 第 13 轮 **[high]** 要求「dry-run 分支中也 FETCH_DONE+1」 | 第 17 轮 **[low]**「无需改动，仅确认文档与行为一致」 |
| `progress.sh:217` `read -d $'\r'` 循环 | 第 5 轮 **[medium]**「可能整段吞掉换行分隔的进度行」 | 第 16 轮 **[medium]**「已核对逻辑，无缺陷。无需修改。」 |

### P5 输出语言不稳定

同一 PR 内中英文混用，且**同一轮内部**混用：第 11 轮 6 条里 3 中 3 英；第 14 轮 4 条里 2 中 2 英。第 1、2 轮几乎全英，第 13 轮后基本转中文。prompt 未固定输出语言。

### P6 incomplete 率 29.4%（5/17），根因全是「模型输出不合 schema」

三种，无一是网络或超时：

1. `expert-runner: model response failed expert-output schema validation: /candidate_findings/N must have required property 'source_agent'`（第 6、12 轮）
2. `deepseek-client: tool call arguments are not valid JSON`（第 8、15 轮）
3. `verifier-client: verifier response failed schema validation: (root) must have required property 'status'`（第 17 轮）

第 2 类正是 issue #10（畸形 tool-call 重试）关掉后的**残留**——重试机制存在，但仍有约 12% 的轮次穿透。第 1、3 类是**必填字段缺失**，属于可以本地补齐的情形（`source_agent` 由 runner 自己知道，不该依赖模型回填；verifier 缺 `status` 可按保守默认处理），不必整轮判 incomplete。

### P7 incomplete 仍然发 REQUEST_CHANGES

最后一轮（第 17 轮）的状态是：verdict=incomplete + 4 条全部 `[low]` + 其中 2 条自我否定 → 仍然提交 `CHANGES_REQUESTED`。语义上等于「我没看全，也没发现真问题，但请你改」。

建议：`verdict=incomplete` 且最高严重度 ≤ low 时降级为 `COMMENT`。这不违反「有问题发 REQUEST_CHANGES」的既定策略，因为此处并没有确认的问题。

### P8 supersede 横幅无限追加

每开一轮新审核，就往**每一条历史 inline comment** 头部再追加一行「⚠️ 已被新一轮审核（review_set_id=…）取代」。

```
62 条 inline comment 累计 341 行横幅
单条最多 17 行横幅（第 1 轮的评论）
```

第 1 轮的评论要滚过 17 行横幅才能看到正文一行字。应改为**单行覆盖式**（只保留最新的 supersede 指针），或直接用 GraphQL `minimizeComment` 折叠旧评论。

### P9 PR 合并后仍触发并发布 Review

```
00:45:10  PR merged
00:45:14  pull_request_target 触发 run 33284059934（head 仍是 9d434a41）
00:47:13  在已合并的 PR 上提交第 18 轮 CHANGES_REQUESTED
00:47:20  check "PR Review Swarm / verdict" = failure
```

应在 `prepare` 阶段短路：PR 已 `closed`/`merged` 时直接不进 analyze。当前行为既浪费一次调用，又在已合并 PR 上留下红叉和一个永远不会被处理的 REQUEST_CHANGES。

### P10 同一 head_sha 两次审核，findings 交集为 0

第 17 轮和第 18 轮跑的是**同一个 commit `9d434a41`、同一份 diff**：

| | 第 17 轮 | 第 18 轮 |
|---|---|---|
| verdict | incomplete | complete |
| findings | `progress.sh:112`、`sources.sh:107`、`update-sources.sh:254`、`progress.sh:45` | `progress.sh:177`、`bootstrap.sh:216`、`progress.sh:146` |
| 交集 | — | **0 条** |

这是本次最直接的稳定性证据：相同输入两次运行，结论没有任何重合，且完整性判定也不同。评测集上的召回数字（88.9%–91.4%）没有覆盖这种 run-to-run 方差。

### P11 锚点与正文引用的位置对不上，甚至跨文件

- 第 5 轮 `[high]` 锚在 `bootstrap.sh:124`（`source_needs_clone` 定义处），正文讨论的是第 343/353 行的主流程。
- 第 13 轮 `[high]` 锚在 `bootstrap.sh:210`，正文整段在分析 `progress.sh` 231–235 行。**评论挂错了文件。**

issue #9（行号锚点）已关，但**跨文件推理时把锚点落在「触发点」而不是「缺陷点」**这一类没有被覆盖。

### P12 噪声占比高、无停机信号

- 37/62（59.7%）是 `[low]`，内容包括「变量名 `url_index` 有误导性」「注释与枚举顺序相反」「四个并行数组需要同步改四处」「README 口径不一致」等风格建议。
- 作者为此产出 **19 个 commit**、触发 **17 次 CI**，横跨两天，最后仍带着 `CHANGES_REQUESTED` 手动合并。
- 每一轮都能「发现新的低价值问题」，没有任何收敛信号；P10 说明再跑一轮还会换一批。

对应 CLAUDE.md 里「误报治理（真阳性用例上的低价值顺手报）」这一条——本次实测说明它的实际代价不是「多几条评论」，而是**让 PR 无法收敛**。

## 6. 与仓库现有 issue 的对应关系

| 本报告 | 现有 issue / 已知项 | 关系 |
|---|---|---|
| P6 第 2 类 | #10 畸形 tool-call 重试（已关） | **残留未清**，17 轮里 2 轮仍因此 incomplete |
| P11 | #9 行号锚点（已关） | 跨文件场景未覆盖，需新开 |
| P12 | CLAUDE.md「下一步 3. 误报治理」 | 提供了真实场景的量化代价 |
| P1、P3 | 无对应 issue | **建议新开，优先级高于 #11** |
| P7、P8、P9、P10 | 无对应 issue | 建议新开 |

本 PR 是纯 shell，不涉及 Swift/ObjC retain cycle，因此**对 #11 没有增量信息**。

## 7. 建议的动手顺序

1. **P1 发布门禁**：arbiter 前丢弃自我否定 finding。改动小，直接消掉 19.4% 的噪声和 3/5 的假 high。
2. **P7 + P9 publish 侧短路**：incomplete 且最高 low → COMMENT；PR 已 closed/merged → 不进 analyze。纯 workflow/publish 逻辑，不碰模型。
3. **P6 schema 兜底**：`source_agent` 由 runner 本地补齐；verifier 缺 `status` 走保守默认，而不是整轮 incomplete。
4. **P8 横幅覆盖式**。
5. **P10 稳定性**：先用 `--case=<name> --repeat=3` 量化同输入方差，再决定要不要动 arbiter。
6. P2、P3、P5 一并在 prompt/schema 层收：标题格式约束、severity 回写、固定输出语言。

改 `.github/workflows/`、`action/action.yml`、Job `permissions` 或 Secret 边界之前，先完整读 `docs/AGENTS.md` 的 9 条硬禁令。

## 8. 复现命令

```bash
R=XiyouMobile3G-iOS/ios-source-learning

# 18 轮 review 正文
gh pr view 9 --repo $R --json reviews

# 62 条 inline finding（含 severity 与锚点）
gh api --paginate "/repos/$R/pulls/9/comments?per_page=100"

# incomplete 的真实根因（Job 是 success，只能从 analyze 日志的 warning 看）
gh run view <run_id> --repo $R --json jobs \
  --jq '.jobs[] | select(.name|test("analyze")) | .databaseId'
gh api "/repos/$R/actions/jobs/<job_id>/logs" | grep '##\[warning\]analyze'

# 对应的 5 个 incomplete run
# 第6轮 33157913182 / 第8轮 33168693356 / 第12轮 33173702436
# 第15轮 33250341474 / 第17轮 33250896642
```

注意：部分早期 run 的 `gh run view --log` 已失效，必须按 job id 走 `/actions/jobs/<id>/logs`。
