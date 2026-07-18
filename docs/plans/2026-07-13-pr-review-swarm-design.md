# PR Review Swarm 设计文档

日期：2026-07-13（修订：2026-07-17）
状态：已确认，待实现验证

## 目录

- [目标与定位](#目标与定位)
- [中央组件与运行形态](#中央组件与运行形态)
- [权限与安全边界](#权限与安全边界)
- [准备、范围与覆盖策略](#准备范围与覆盖策略)
- [Swarm 与候选问题验证](#swarm-与候选问题验证)
- [裁决规则](#裁决规则)
- [Skill 装备机制](#skill-装备机制)
- [批量发布与 GitHub 对象](#批量发布与-github-对象)
- [Check Run 状态机](#check-run-状态机)
- [并发、重试与成本](#并发重试与成本)
- [测试与验收](#测试与验收)
- [实现前置任务](#实现前置任务)

## 目标与定位

构建一个供仓库所有者使用的 GitHub PR 审核机器人：多个专家 Agent 并行完成整次 PR 审核，统一验证和汇总全部有效问题后，一次性向 PR 提出者反馈。只要存在任一经验证的问题，就提交 `REQUEST_CHANGES`；仅在审核完整且问题数为零时提交 `APPROVE`，并在固定摘要评论中 @ 配置指定的负责人（默认 `dustPyrotechnic`，仓库可覆盖）。

机器人只负责审核，不执行合并，也不申请 `contents: write` 等合并所需权限。最终是否采纳反馈、是否使用 ruleset bypass、以及是否合并，始终由人决定。目标仓库的 ruleset 应允许仓库所有者或指定维护者在必要时人工 bypass。

LLM 使用 DeepSeek Anthropic 兼容 API。模型名称是必填配置项，不提供硬编码默认值；启动时校验模型名是否在中央维护的允许列表中，不在列表内则判定为配置错误，在 status-start 阶段快速失败并说明原因（不消耗预算、不进入 `incomplete`）。

架构采用"中央可复用引擎 + 目标仓库监听器"模式，并把 PR 数据准备、LLM 分析和 GitHub 发布权限隔离到不同 Job。本文档中 "DeepSeek Secret" 统一指调用 DeepSeek API 所需的凭据，不再使用"DeepSeek Key"这一说法。

## 中央组件与运行形态

- 中央仓库提供 reusable workflow 和预构建 JavaScript custom action；目标仓库只安装小型监听器并固定调用的 commit SHA。
- custom action 中一并提交源码、JSON Schemas、确定性校验器、`skills/` 和预构建 `dist/`，运行时通过 `GITHUB_ACTION_PATH` 读取同版本资源。这部分资源随 action checkout 到 runner 本地文件系统，读取时不经过 GitHub API，因此不受 `permissions: {}` 对 `GITHUB_TOKEN` 的限制影响（见"权限与安全边界"）。
- 开发阶段将依赖打包进 `dist/`；GitHub Actions 运行时不执行 `npm install`、不解析动态依赖，也不从 PR 加载代码。
- CI 必须从源码重新构建 `dist/` 并验证没有未提交差异，防止源码与发布产物不一致。
- 同一 custom action 提供 `prepare`、`analyze`、`publish`、`finalize`、`watchdog` 等受限入口，由拥有不同权限和 Secret 的 Job 分别调用。
- reusable workflow 及其内部 custom action、第三方 Action 均固定到完整 commit SHA；发布流程校验 workflow、action 和 skills 的版本绑定。
- 监听器使用 `pull_request_target` 的 `opened`、`synchronize`、`reopened`、`ready_for_review`、`edited` 事件启动审核；`converted_to_draft` 和 `closed` 只触发轻量状态清理，以支持外部 fork PR 且保留 Secret 与发布权限。轻量状态清理复用 status-start 的入口和权限，只读取 PR 当前状态并把本 PR 现有的 `in_progress` Check 终结为 `cancelled`，不进入 prepare/analyze/publish，不需要额外 Job 或权限声明。
  - `edited` 事件仅当 `github.event.changes.base` 存在（即 PR 更换了 base branch）时触发完整重审；标题/正文编辑不触发重审，只在下次审核时读取最新描述。
  - 更换 base branch 不会改变 `head_sha`，但会改变审核范围（diff、上下文）和门禁语义，必须视同新一轮完整审核，绝不能沿用旧 base 上产出的 Check 结论。
- 工作流始终运行默认分支中的可信 workflow；仅把 PR 内容作为数据读取，不 checkout PR head，不安装 PR 依赖，不执行 PR 中的任何代码、脚本或配置。**这是硬禁令**：任何后续实现或 AI 辅助修改都不得为 workflow/action 增加 `actions/checkout` 之类使用 `ref: ${{ github.event.pull_request.head.sha }}` 或等价 PR head 引用的步骤。CI 增加静态扫描，检测 workflow YAML 中出现的危险 `ref:` 模式并拒绝合并。
- 草稿 PR 不执行完整审核；转为 ready 后重新触发。
- 维护者可通过 `workflow_dispatch` 手动重审。监听器要求输入 PR 编号，重新从 GitHub API 获取 PR 与当前 SHA；触发者权限校验在 status-start 中执行，使用其已持有的仓库读权限调用 `GET /repos/{owner}/{repo}/collaborators/{username}/permission`（`username` 取 `github.event.sender.login`，不需要为此额外声明权限），确认返回的 `permission` 满足 `none < read < triage < write < maintain < admin` 顺位中"至少为 `write`"（即 `write`、`maintain`、`admin` 均视为满足，不能按字符串相等判断）；组织启用自定义仓库角色导致返回值超出上述内置枚举时，一律按不满足处理。校验失败则本次运行直接终止并记录拒绝原因；此校验独立于 GitHub 触发 `workflow_dispatch` 本身要求的 write 权限，作为纵深防御。校验通过后，本次运行同时视为满足"信任门控"（见"权限与安全边界"），不再重复走 author association 判定——这是信任门控拦下外部贡献者 PR 后，维护者批准放行的唯一渠道。

## 权限与安全边界

工作流分为五个权限隔离的 Job，另有一个运行在独立 `schedule` 触发下的 watchdog Job（详见"Check Run 状态机"），每个 Job 显式声明 `permissions` 和可见 Secret：

1. **status-start**：使用 `contents: read`、`pull-requests: read` 和 `checks: write`；重新读取 PR，锁定事件对应的身份元组 `(head_repo, head_sha, base_repo, base_ref, base_sha, merge_base_sha)`，创建 `in_progress` Check Run，并对当前 `head_sha` 上被新运行取代的旧 `in_progress` Check 做清理（`GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` 按单一 ref 查询即可覆盖；跨历史 `head_sha`/base branch 变更遗留的孤儿 Check 由下文 watchdog 负责，status-start 不做跨 SHA 枚举）；不获得 DeepSeek Secret。`contents: read` 专门用于读取信任白名单和仓库启用开关配置文件（均为目标仓库 `base_sha` 下的配置，不经由 PR 内容）。同时执行：
   - **信任门控**：若本次运行由 `workflow_dispatch` 触发（已在监听器层完成触发者 write 权限校验，见"中央组件与运行形态"），视为信任门控已满足，直接放行——`workflow_dispatch` 是信任门控唯一的人工 override 渠道，不另设"显式 override"。若本次运行由自动事件（`opened`/`synchronize`/`reopened`/`ready_for_review`/`edited`）触发：PR 作者的 author association 为 `OWNER`/`MEMBER`/`COLLABORATOR` 时直接放行；否则查询仓库配置的信任白名单，命中则放行，未命中则本次运行标记为 `action_required` 并结束（不进入 prepare/analyze），需维护者通过 `workflow_dispatch` 手动重跑才能放行。**该放行只对触发时锁定的当前 `head_sha` 生效，是一次性的**：同一 PR 之后任何新的自动事件（产生新 head_sha）都必须重新走上述判定，不继承之前 `workflow_dispatch` 的放行；仓库信任白名单是唯一能产生跨 commit 持续豁免的机制，由仓库管理员显式维护。
   - **仓库启用状态检查**：读取目标仓库可见性与仓库级配置开关；私有仓库且未显式启用时，运行标记 `action_required` 并结束，说明需仓库管理员确认数据政策后启用。

   status-start 内部执行顺序固定为：**先创建 `in_progress` Check Run，再执行信任门控与仓库启用检查**——即使门控判定失败，PR 上也已经有一个可被更新的 Check Run，不会出现"完全没有 Check、连 pending 状态都没有"的情况。门控判定失败时，status-start 使用自己持有的 `checks: write` 直接把刚创建的 Check Run 写为 `conclusion=action_required` 并结束本次运行，不触发 prepare/analyze/publish/status-finalize，避免终态写入职责出现歧义。
2. **prepare**：仅使用 `contents: read` 和 `pull-requests: read`；获取并清洗 PR 数据，复验并锁定 status-start 产出的身份元组，生成上下文包和覆盖清单；不获得 DeepSeek Secret。
3. **analyze**：设置 `permissions: {}`，只显式注入 DeepSeek Secret；运行专家、确定性证据校验器和独立 verifier，不获得可写 GitHub 凭据，也不获得 `contents: read`（因此不能调用 GitHub API 读取仓库内容，只能使用 prepare 传入的 artifact 和 action 自带的本地资源）。
4. **publish**：仅使用 `contents: read`、`pull-requests: write` 和 `issues: write`；重新获取可信 diff/内容，校验所有发布输入并执行 Review、摘要评论更新；不获得 DeepSeek Secret，不调用 LLM，也不持有 `checks: write`。`issues: write` 专门用于通过 Issue Comments API（`POST`/`PATCH /repos/{owner}/{repo}/issues/{pr_number}/comments`）创建和更新"固定摘要评论"——Review body 和 inline comment 用 `pull-requests: write` 即可发布，但可按 marker 稳定查找并原地更新的评论走的是 Issue Comments API（PR 在 GitHub 内部按 issue 编号寻址），因此两个权限都是发布该功能所必需的，不是过度授权。publish 只产出裁决结果摘要供 status-finalize 读取，自身不直接写 Check Run——Check Run 的创建和终态写入分别由 status-start 和 status-finalize 独占，避免多个 Job 都能写同一 Check 导致状态来源不唯一。
5. **status-finalize**：仅使用 `checks: write`；用 `if: always()` 运行，是本运行 Check Run 终态的主要写入者。当 prepare/analyze/publish 失败、超时或被跳过、但本运行仍被 GitHub Actions 正常调度执行时，status-finalize 保证把本运行拥有的 Check Run 写入终态之一（`success`/`failure`/`action_required`/`timed_out`/`cancelled`）；裁决结果由 publish（或更早失败阶段）产出，finalize 只读取该结果摘要决定写哪个终态，不重新计算裁决逻辑。**已知限制**：当整个工作流运行被 `cancel-in-progress` 或人工取消、且取消发生在 status-finalize 被调度之前，GitHub 不保证该 Job 一定会执行，此时 Check 可能停留在 `in_progress`；这个限制无法仅靠 Job 内部机制消除，由"Check Run 状态机"一节描述的独立 watchdog 兜底。

`permissions: {}` 只限制 `GITHUB_TOKEN` 对 GitHub API 的访问，不等同于 runner 的网络、shell 或文件系统隔离，也不影响 action 从本地文件系统（`GITHUB_ACTION_PATH`）读取自带的源码、schemas 和 skills。安全保证来自以下约束：

- 模型只有文本输入和结构化输出接口，不向模型开放 tool calling、shell、文件写入或网络工具。
- analyze 使用预构建、受审计的 action 代码，不在运行时安装依赖。
- 如未来要求只能访问 DeepSeek 域名，必须另行使用临时 self-hosted runner、出站代理或网络策略；普通 GitHub-hosted runner 不提供该保证。
- DeepSeek Secret 只作为受控客户端的输入，不传给子进程、提示词、日志或 artifact。

Job 之间只传递有大小上限的版本化 JSON artifact。artifact SHA-256 只用于验证传输完整性，不作为信任证明；publish 必须把 analyze artifact 整体视为不可信输入，重新执行 Schema、路径、SHA、diff、证据与裁决校验。下游在解析前验证文件名、大小和摘要，不解压任意路径。

publish 默认使用调用仓库的 `GITHUB_TOKEN` 作为稳定审核身份。目标仓库必须允许 GitHub Actions 创建和批准 PR，并由调用 workflow 显式授予所需权限；可复用工作流不能提升调用方权限。如组织禁止 Actions 批准，则改用具有同等最小权限的固定 GitHub App 安装身份。

PR 描述、diff、文件内容、文件名和 Agent 输出均属于不可信数据：

- 使用明确的数据边界包装，不把 PR 内容解释为系统指令。
- Agent 不得从 PR 内容加载 skill、执行命令或扩展工具权限。
- 所有结构化输出使用严格 JSON Schema；未知字段、未知枚举、越界路径和无效行号均视为失败。
- 疑似 Secret 先由本地确定性扫描器检测并脱敏，不向 LLM 发送完整凭据。
- 私有仓库默认不启用；启用前由仓库管理员确认把代码发送给 DeepSeek 的数据政策（检查点见 status-start 的仓库启用状态检查）。
- 阈值、ignore/generated 规则、skill 路由和风格配置只从锁定的 `base_sha` 读取。PR 对这些配置的修改只作为被审内容，不影响本次审核。

## 准备、范围与覆盖策略

prepare 复验并锁定身份元组 `(head_repo, head_sha, base_repo, base_ref, base_sha, merge_base_sha)`，获取 PR 描述、原始 diff、变更文件的 head/base 内容及必要的跨文件上下文。

- 只报告由本次 PR 新增、暴露、扩大或使其可达的问题；与本次变更没有因果关系的历史问题不反馈、不阻塞。判定 `introduced_by_pr` 时应用以下确定性规则，供确定性证据校验器执行：
  - 问题定位的行号必须落在本次 diff 的新增或修改 hunk 内（`side: RIGHT` 且属于新增/修改行），或虽落在未变更行、但其直接绑定的符号/配置在本次 PR 中被修改。
  - 同文件内的行号归属和符号绑定关系（问题所在符号是否在本次 PR 中被新增/修改）由确定性证据校验器机械判定，属于"确定性证据校验"范畴。
  - 跨文件调用链/依赖链的因果判定（问题涉及的符号是否通过调用链联系到本次 PR 变更的节点）**不作为确定性校验的一部分**：现阶段没有引入代码级静态分析/调用图工具，无法机械验证任意语言仓库中的调用链是否成立。这类跨文件因果声明必须显式标记为待独立 verifier 复核的判断，verifier 需要在给定上下文文件中找到具体证据（真实的调用点/引用）支持该声明，找不到则该 candidate finding 判定不通过，不允许仅凭专家自述的调用链直接过关。后续若引入语言级静态分析工具，可以把符合条件的语言/路径升级为确定性校验。
  - 仅因"被本次 PR 触碰到的文件里恰好存在旧代码"而报告、但该旧代码本身未被修改也未被新增调用路径触达的问题，不满足因果关系，判定不通过。
- 按文件和 diff hunk 分片，优先覆盖可执行源码、权限、网络、存储、加密、依赖和构建配置变更。
- `GET /repos/{owner}/{repo}/pulls/{pr}/files` 存在 GitHub 文档记载的限制：单次最多返回约 3000 个变更文件，超出部分不会出现在响应中；单个文件 diff 过大时该文件的 `patch` 字段会被省略。prepare 和 publish 每次调用后都必须显式核对返回的文件数是否达到该上限、以及是否存在预期变更文件缺少 `patch` 字段的情况；命中任一情况都视为覆盖不完整，判定为 `incomplete`，不能默默按拿到的子集继续审核。
- 上下文解析器按显式规则补充相关声明、直接调用方、被调用 API、测试和可信配置；每个补充文件都记录选择原因和版本 SHA。
- 二进制、生成文件、vendor 和 lockfile 按显式规则处理，并在覆盖清单中记录跳过原因。
- 超出单次上下文窗口时进行多分片审核，不静默截断，也不因预算只展示 Top N 问题。
- 任何可审核源码未覆盖、分片失败、文件读取不完整或上下文无法确定时，最终状态必须为 `incomplete`。
- 对单 PR 设置文件数、字节数、分片数、skill 请求数和 token 预算上限；达到上限时明确报告未覆盖范围，判定为 `incomplete`。
- 覆盖清单至少记录所有变更文件、处理方式、所属分片、参与 Agent、验证状态、失败原因和 token 用量。

## Swarm 与候选问题验证

### 并行专家

所有必需专家和分片先完成分析，审核过程中不在 GitHub 发布任何问题：

1. 正确性/逻辑专家。
2. 安全专家：凭据泄露、注入、权限、存储、加密和供应链风险。
3. 可维护性/规范专家：仓库约定、API 设计、测试与文档。

专家只能提出 **candidate finding**，不能直接决定 GitHub Review 状态。纯主观偏好、没有实际影响的可选优化，以及无法给出明确修复动作的意见不构成 candidate finding。

每个专家单次运行的 candidate findings 数量有 Schema 层 `maxItems` 硬上限（中央配置，默认每专家每分片不超过 30 条）；单次运行触发的 verifier 调用总数、最终 finding 总数、以及 publish 端 Review 批次数同样各有硬上限。为了让"命中上限"本身可观测（而不是被结构化输出静默截断成看似正常的结果），专家的结构化输出 Schema 除 findings 列表外必须包含 `coverage_complete: boolean` 字段，由专家在生成完所有 candidate findings 后显式声明本分片范围内是否已穷尽审查、没有被截断。以下任一情况都判定为命中硬上限：`coverage_complete` 缺失、为 `false`，或 findings 数量恰好等于 `maxItems`（即使 `coverage_complete` 为 `true` 也不采信，因为模型可能在被截断前并不知道自己会被截断）。任一上限被触发，本次运行直接判定为 `incomplete`，不得截断后按 `pass`/`changes_requested` 处理；命中上限的分片应尽快停止调度尚未开始的其余分片和补充审核，避免在已确定要判 `incomplete` 的情况下继续消耗预算。

### 强制验证流水线

每个 candidate finding 都必须依次通过：

1. **确定性证据校验**：验证 Schema、锁定 SHA、路径、diff 行号、side、引用文本、相关上下文，以及上一节中可机械判定的同文件因果关系；跨文件调用链声明不在这一步判定，转交步骤 2。
2. **独立 verifier**：获得候选问题和足够上下文，主动寻找反例、遗漏条件和已有保护，判断问题是否真实成立。
3. **主审汇总**：删除重复、证据不足、被上下文反驳或与本次 PR 无关的候选，合并等价问题并编辑最终表述。

只有验证通过的候选才能成为最终 finding。主审不能新增未经同样流程验证的问题。被删除的候选只保留在内部诊断 artifact 中，不向 PR 提出者展示。

任何 candidate finding 的 verifier 超时、API 失败或 Schema 失败，都使整次审核成为 `incomplete`。未经验证的候选不得发布；已经验证的问题可以随 incomplete 报告反馈。

### 定向补充审核

专家可从中央白名单请求最多 N 个 skill（中央配置默认 N=3）。编排器校验请求后最多追加一轮定向专家审核，不形成循环。补充审核产生的候选问题必须经过同样的确定性校验和独立 verifier，并计入本节前述的 candidate/verifier/finding 硬上限。

### Finding 数据

最终 finding 至少包含：

- `id`、`path`、`line`、`side`；多行问题另含 `start_line` 和 `start_side`。
- `severity`、`confidence`、`category`，仅用于排序、呈现和统计，不决定是否阻塞。
- `title`、精确 `evidence`、实际 `impact` 和可执行 `suggestion`。
- `introduced_by_pr` 及因果说明。
- `source_agent`、证据校验结果和 verifier 结论。

## 裁决规则

对外结论由确定性规则根据最终 findings 和覆盖清单计算：

- `changes_requested`：审核完整，且至少存在一个最终 finding。
- `pass`：所有必需文件、分片、专家和 verifier 均成功，且最终 findings 数量为零。
- `incomplete`：任一必需阶段超时、API 失败、Schema 失败、验证未完成、预算耗尽、硬上限触发或覆盖不完整。

所有严重度的最终 findings 都必须反馈，不隐藏、不截断。任何最终 finding 都触发 `REQUEST_CHANGES`；severity 只影响排序和展示。纯主观偏好和与本次 PR 无关的历史问题不属于 finding。

`incomplete` 时：

- 可以发布已经验证的全部 findings，并明确列出未完成阶段和未覆盖范围。
- 不发布任何未经验证的候选问题。
- 若存在已验证 finding，可提交 `REQUEST_CHANGES`；若不存在，则只更新固定摘要评论。
- 绝不提交 `APPROVE`。
- **`incomplete` 状态下提交的 `REQUEST_CHANGES` 必须与完整审核的 `REQUEST_CHANGES` 在展示上明确区分**：Review body 和固定摘要评论顶部必须使用固定模板插入醒目横幅（例如"⚠️ 本次审核未完整覆盖，以下仅为已验证的部分问题，可能存在未发现的问题"），并列出具体未完成的阶段/范围，避免被误读为"完整审核后只有这些问题"。

另有 `stale/cancelled` 终态：当身份元组（`head_sha`、`base_ref`、`base_sha` 等）变化、PR 已关闭、转为草稿或运行被新任务取代时使用。该状态不发布 Review 或摘要内容，只允许把本运行的 Check Run 终结为 `cancelled`（由 status-finalize 写入）。

## Skill 装备机制

- 中央 custom action 内的 `skills/` 是唯一来源，`index.md` 列出名称、版本、触发条件和描述。`index.md` 每行格式约定为：`- name: 版本 | 触发条件（文件后缀/路径 glob） | 一行描述`，例如：
  ```
  - swift-review: v3 | *.swift | Swift 正确性、内存管理与并发审查清单
  - secret-scanning: v2 | * | 通用凭据/密钥泄露检测清单
  ```
- 每个 skill 文件是一份 Markdown 检查清单，头部用 YAML front matter 声明结构化元数据，正文是触发条件说明和 checklist，例如 `skills/swift-review.md`：
  ```markdown
  ---
  name: swift-review
  version: 3
  triggers:
    - "*.swift"
  category: correctness
  ---

  ## 触发条件
  变更文件包含 `.swift` 后缀。

  ## Checklist
  - [ ] 是否存在强引用循环（闭包捕获 self 未加 `[weak self]`）？
  - [ ] 是否正确处理 Swift Concurrency 的 actor 隔离与 Sendable？
  - [ ] 是否遵循 4 空格缩进与 DocC 注释风格？
  ```
- 三个专家只预装职能通用 skill；Swift、Objective-C、Go 等语言 skill 按文件后缀和路径确定性加载。
- 格式、注释和框架约定优先来自目标仓库 `base_sha` 中的可信配置；中央 skill 只提供默认值。
- 动态 `skill_requests` 必须是 `index.md` 中的枚举值，并受数量、token 和单轮限制（见"Swarm 与候选问题验证"的硬上限）。
- PR 不能覆盖中央 skill、白名单或裁决规则。

## 批量发布与 GitHub 对象

publish 只在所有预定专家、分片和 verifier 已经成功或进入明确失败终态后运行。它先重新读取 PR，确认 PR 仍然 open、非 draft，且身份元组（含 `base_ref`/`base_sha`）与 prepare 锁定值一致；不满足时进入 `stale/cancelled`。

publish 重新获取的"可信 diff/内容"直接来自 GitHub REST API 的 `GET /repos/{owner}/{repo}/pulls/{pr}/files` 与 `GET /repos/{owner}/{repo}/contents/{path}?ref={head_sha}`，不复用 analyze artifact 中携带的文件内容（那部分只作为 prepare→analyze 的分析输入，不作为发布时的信任来源）。若重新读取到的 diff hunk 范围与 prepare 锁定时不一致（例如作者在 analyze 运行期间又 push 了新 commit，但并发控制未能及时取消本次运行），publish 判定为 `stale`，交由 status-finalize 将 Check 标为 `cancelled`，等待新一轮 `synchronize` 触发的运行覆盖。

审核过程中不流式发布评论。publish 统一完成去重、证据复验和排序后，按发布 manifest 批量提交所有结果。发布 manifest 定义：

- `review_set_id`：本次审核结论的唯一 ID，由身份元组 + engine/policy/model/schema 版本 **+ 最终 findings 集合内容摘要**共同派生。只要最终 findings 集合不同，`review_set_id` 就一定不同；同一身份元组的重跑若因 LLM 非确定性产出了不同的 findings 集合，会得到新的 `review_set_id`，不会与旧一轮已发布的批次混淆或被误判为"已发布过"。
- `batch_index` / `batch_count`：当前批次序号与总批次数。
- `findings_digest`：本批次包含的 finding ID 列表的摘要，用于对账哪些 finding 已成功发布。

批量策略：

- 若单次 Review 或正文容量足以容纳全部问题，直接提交一次最终 Review（`REQUEST_CHANGES` 或 `APPROVE`）。
- 若容量不足，前 `batch_count - 1` 批使用 `event: COMMENT` 提交（承载 inline comments 和部分 findings，不改变 PR 审核状态），只有最后一批成功后才提交唯一一次 `REQUEST_CHANGES`（或在零 finding 完整审核下提交 `APPROVE`）。
- 重试时按 `review_set_id` + `batch_index` 逐批对账：查询已存在的、`review_set_id` 匹配的 Review 对象，并核对该批次的 `findings_digest` 与本次待发布内容是否一致——一致才算"已成功发布"予以跳过，不一致（理论上不应发生，因为 `review_set_id` 已经绑定 findings 内容）则判定为 `incomplete` 并停止发布，不静默覆盖或跳过。由于 `review_set_id` 已经把 findings 内容纳入派生输入，"同一身份元组重跑产出不同 findings 集合"会天然得到不同的 `review_set_id`、走全新批次序列重新完整发布，不会因命中旧 Review 对象而漏发新增问题。
- 只有最后一批成功并完成对账后，才允许 status-finalize 写入最终 Check Run 结论。

Review 对象没有自定义字段，`review_set_id`/`batch_index`/`batch_count`/`findings_digest` 通过在 Review body 末尾追加一段隐藏 HTML 注释编码：`<!-- pr-review-swarm:review_set_id=<id>;batch=<batch_index>/<batch_count>;digest=<findings_digest> -->`。对账时用 `GET /repos/{owner}/{repo}/pulls/{pr}/reviews` 拉取该 PR 全部 Review，筛选出发布身份自己提交的记录，解析隐藏注释还原每个已发布批次的身份，据此判断哪些批次可跳过、哪些需要重试。

**同一 `head_sha` 上出现多个 `review_set_id`（跨轮次重跑）时的处理**：publish 开始发布前，先用上述隐藏 marker 解析出当前 `head_sha` 上是否存在其它 `review_set_id` 遗留的 Review。若存在且不是本次要发布的 `review_set_id`：

- 若旧 `review_set_id` 已经提交过最终批次（`REQUEST_CHANGES`/`APPROVE`），视为被新一轮取代，publish 优先调用 `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals` 附带说明"已被新一轮审核（`review_set_id=...`）取代"予以撤销。**该 API 在仓库启用了"限制谁可以 dismiss review"这类分支保护规则时可能拒绝普通 `GITHUB_TOKEN` 身份（403）**：命中该情况不判定为失败，改为降级路径——跳过 dismiss，直接对旧 Review 本身调用 `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}`（Update a review，只要求调用者是该 Review 的作者，不需要 dismiss 权限）在正文最前面插入"⚠️ 已被新一轮审核（`review_set_id=...`）取代，请以下方最新 Review 为准"的说明。旧 Review 下的 inline comment 无论走哪条路径，都通过 `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}` 在正文前追加同样的取代说明，不删除评论本身，保留审计痕迹。
- 若旧 `review_set_id` 只有若干成功的中间 `COMMENT` 批次、从未提交最终批次（上一轮中途失败或被取消），同样对这些中间批次的 Review body 追加取代说明，视为已处理，不再等待其继续完成。
- 处理完旧 `review_set_id` 的收尾后，本次运行才开始按新 `review_set_id` 从 `batch_index=0` 发布，确保同一 `head_sha` 上不会同时存在多份互相矛盾、且未加说明的 `REQUEST_CHANGES`。

inline comment 发布前必须确认 `path`、`line`、`side` 和可选起始位置属于锁定 `head_sha` 的原始 diff hunk，Review 显式使用 `commit_id=head_sha`。重命名、删除或上下文行无法稳定定位时，finding 降级到 Review body，不因单条 inline 定位失败而丢弃整个 finding。

GitHub 对象分工：

- **Review**：承载 `REQUEST_CHANGES`、`APPROVE`、`COMMENT`（分批中间态）和 inline comments。
- **固定摘要评论**：通过 Issue Comments API 创建和更新，展示 verdict、覆盖率、完整问题索引、失败原因和重试方式。
- **Check Run**：作为权威门禁和机器可读状态，不使用旧 Commit Status context。

固定摘要评论的 marker 拆成两层，避免"可变结果字段变化导致新建评论、无法原地更新"的问题：

- **稳定身份 marker**（用于定位同一条评论）：`repo/pr/bot/summary`，跨审核轮次保持不变，任何一次运行都先用它查找是否已存在摘要评论，存在则更新、不存在才创建。
- **可变结果 marker**（写入评论正文内的隐藏区块，不参与查找）：`head_sha/base_sha/engine_revision/policy_revision/model/schema_version/verdict/review_set_id`，用于记录"当前这条摘要对应哪一次结论"，供人工核对和调试。

Review 本身的幂等键使用 `review_set_id`（见上文批量发布 manifest），规则、模型或引擎变更后 `review_set_id` 随之变化，从而允许对同一 head SHA 重新审核而不与旧 Review 冲突。提交 Review 后若摘要或 Check 更新失败，重试必须从 GitHub 重新读取现状并按 `review_set_id`/`batch_index` 继续对账，不能重复提交相同批次的 Review。

`APPROVE` 只更新固定发布身份自己的审核状态；Code Owner、批准数量和其他 branch protection 条件仍独立生效。机器人永远不调用 merge API。

## Check Run 状态机

权威 Check Run 名称固定为 `PR Review Swarm / verdict`，绑定 PR 当前身份元组。GitHub Checks API 把状态拆成两个字段：`status`（`queued`/`in_progress`/`completed`）和只有 `status=completed` 时才有意义的 `conclusion`。本设计中的六种"状态"实际映射为：

- `status=in_progress`：审核正在进行。
- `status=completed, conclusion=success`：审核完整且最终 findings 为零；必须在所有 Review 和摘要操作成功后由 status-finalize 最后写入。
- `status=completed, conclusion=failure`：审核完整且存在至少一个最终 finding。
- `status=completed, conclusion=action_required`：审核不完整，需要修复配置、恢复预算、人工批准信任门控或手动重跑。
- `status=completed, conclusion=timed_out`：必需阶段达到超时上限。
- `status=completed, conclusion=cancelled`：运行过期、PR 状态变化（含 base branch 变化）或被新运行取代。

Check Run 的 `external_id` 包含 repo、PR、身份元组、run ID 和 attempt。GitHub 的 List Check Runs API（`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`）按单一 `ref` 查询，不支持按 `external_id` 直接过滤，也不能一次性跨多个历史 SHA 查询。status-start 只对**当前 head_sha 这一个 ref** 调用该接口，在客户端按 `external_id` 前缀（repo/PR）匹配，取消同一 head_sha 上被本次运行取代的旧 `in_progress` Check（例如同一 head_sha 短时间内被多次触发）。**跨历史 head_sha（含 base branch 变化留下的历史运行）的孤儿 Check 对账不由 status-start 或 status-finalize 承担，完全由下文的 watchdog 负责**——只有 watchdog 具备逐 commit 遍历、核实 workflow run 真实状态后再终结的完整能力，status-start/status-finalize 不重复实现这部分逻辑。

`status-finalize` 是本运行 Check Run 终态的主要写入者，用 `if: always()` 保证只要本运行被正常调度执行，即使 prepare/analyze/publish 失败或被跳过，本运行拥有的 Check 依然会被写入 `failure`/`action_required`/`timed_out`/`cancelled` 之一，不会永久停留在 `in_progress`。`cancel-in-progress: true` 导致旧工作流被取消时，若旧运行的 status-finalize 仍被调度执行则由它自行收尾；若整个运行在 status-finalize 被调度前就被取消（GitHub 不保证下游 Job 在这种情况下一定会执行），且该 PR 后续确实有新事件触发新运行，新运行的 status-start 会在处理**当前 head_sha**时顺带清理同一 head_sha 上残留的旧 `in_progress` Check；若该 head_sha 之后再无新事件触发，或孤儿 Check 停留在一个已经不是当前 head_sha 的历史 SHA 上，则完全依赖 watchdog 兜底，status-start 不做跨 SHA 枚举。

但"下一次运行负责清理"这个机制本身依赖"确实会有下一次运行"，对被取消后再无人 push 新 commit 的 PR 无法生效。为兜底这个场景，**watchdog 不做成中央仓库的跨仓库任务**——`GITHUB_TOKEN` 天然只作用于运行所在的单个仓库，中央仓库的 token 写不到目标仓库的 Check Run/评论，而"消费方自装监听器"模式下中央仓库也没有任何"谁安装了本机器人"的注册表可查，跨仓库扫描在凭据模型上不成立。watchdog 改为**由目标仓库自己的监听器额外安装的一个 `schedule` 触发 Job**（复用中央 reusable workflow 里的 `watchdog` 入口，与 `prepare`/`analyze`/`publish`/`finalize` 同源但独立触发），运行在目标仓库自身的 Actions 上下文里，凭据天然限定在该仓库范围内，只需要 `pull-requests: read`、`issues: write`、`checks: write` 和 `actions: read`（用于读取所属 workflow run 的真实状态，见下文强一致性核验），不需要任何跨仓库或组织级凭据：

- 每次运行枚举该仓库当前所有 open PR（`GET /repos/{owner}/{repo}/pulls?state=open`，按需分页）；对每个 PR 用 `GET /repos/{owner}/{repo}/pulls/{pr}/commits` 取出其历史 commit 列表，逐个调用 `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` 找出仍属于本机器人（按 Check Run name 和 `external_id` 前缀识别）、处于 `in_progress`、创建时间超过预设超时阈值（默认 30 分钟）的候选 Check Run。该接口对单个 PR 最多返回约 250 条 commit；命中该上限时 watchdog 仅能保证覆盖最近 250 次 commit 对应的历史，此时在固定摘要评论中追加"commit 历史过长，早期运行的孤儿 Check（如有）可能无法被自动清理，请人工检查"，把这个已知限制变成可观测的降级说明，而不是静默漏检。该接口只反映 PR **当前**的线性提交历史；作者 force-push/rebase 后被替换掉的旧 commit 不再出现在列表里，若其上恰好留有孤儿 Check，watchdog 无法枚举到、也就不会被清理——由于该 SHA 已不是 PR 当前 head，不影响 merge 门禁，这是一个已知但影响有限的限制，不再额外处理。
- **写入前必须再做一次强一致性核验，消除与 status-finalize 之间的竞态**：`external_id` 中带有该 Check Run 所属的 workflow run ID，watchdog 在 PATCH 之前先调用 `GET /repos/{owner}/{repo}/actions/runs/{run_id}` 读取该次运行自身的 `status`。若运行本身仍是 `queued`/`in_progress`（即该运行确实还在正常执行，只是耗时较长——大 PR、多分片加上退避重试可能自然超过 30 分钟），watchdog **不得**终结这个 Check，跳过本次候选；只有当该运行自身的 `status` 已经是 `completed`（含任何 conclusion，即该次运行已彻底结束、不可能再有任何 Job 对这个 Check 写入结果）而对应 Check Run 依然是 `in_progress` 时，才继续下一步判定。这样"运行仍在正常进行"和"运行已死但 Check 没收尾"两种情况不会被混淆，不会出现 watchdog 把一次仍在正常执行的大 PR 审核提前打断。
- **运行已死不代表结果没发布，watchdog 终结前还需核实是否已有合法最终 Review**：用已持有的 `pull-requests: read` 调用 `GET /repos/{owner}/{repo}/pulls/{pr}/reviews`，解析该 head_sha 上是否存在带有效隐藏 marker（见"批量发布与 GitHub 对象"）的最终批次 Review（`REQUEST_CHANGES`/`APPROVE`）。若存在，说明 publish 早已成功完成、只是 status-finalize 未能收尾写 Check，watchdog 把 Check **回填**为与该 Review 一致的结论（存在 `REQUEST_CHANGES` 则 `conclusion=failure`，存在 `APPROVE` 则 `conclusion=success`），不覆盖为 `timed_out`；只有确认不存在任何有效最终 Review 时，才判定为真正的孤儿。
- 确认为真正孤儿（运行已死 + 没有已发布的最终 Review）后，watchdog 无法访问 Job 日志或 artifact，不尝试进一步区分具体失败原因，统一终结为 `timed_out`，并用 `issues: write` 更新对应 PR 的固定摘要评论，说明"自动检测到上一次审核运行未正常结束，已终止其 Check，可通过 `workflow_dispatch` 重跑"。
- watchdog 运行在稳定的 `schedule` 触发下，是 Check Run 终态保证的最后一道防线，不依赖任何特定 PR 事件是否发生；`schedule` 触发不与 PR 的 concurrency group 共享，因此不受 `cancel-in-progress` 影响。对没有后继运行、也还没到 watchdog 超时阈值的场景，维护者仍可通过手动重审或清理入口提前恢复。watchdog 单次运行的 API 调用量与 open PR 数、每个 PR 的 commit 数成正比；open PR 数或历史 commit 数很大的仓库应设置每次运行的扫描上限（例如只处理最近活跃的 N 个 PR，多次运行间轮转覆盖其余部分），避免 watchdog 自身的轮询挤占同一仓库 `GITHUB_TOKEN` 的速率限制配额、反过来拖慢正在进行的审核。

目标仓库在 ruleset 或 branch protection 中将该 Check Run 设为 required。仓库所有者保留人工 bypass 能力；是否 bypass 由人决定，不由机器人自动执行。

## 并发、重试与成本

- 以仓库和 PR 编号建立 concurrency group，设置 `cancel-in-progress: true`。
- prepare 和 publish 在各自开始前都重新用 GitHub API 校验运行是否仍拥有当前身份元组（含 `base_ref`/`base_sha`）；过期则尽快停止，不进入下一阶段。analyze 阶段没有 `contents: read`/`pull-requests: read`，无法自行查询 GitHub 判断身份元组是否过期，其新鲜度保证完全来自 concurrency group 的 `cancel-in-progress`：一旦有新事件触发新运行，GitHub Actions 会直接取消旧运行（含正在执行的 analyze），analyze 本身不需要、也没有能力做身份元组自检。
- DeepSeek API 使用带抖动的指数退避，只重试限流和暂时错误，不重试 Schema 或逻辑错误。
- GitHub REST API 调用（prepare 读取内容、publish 发布 Review/评论）同样使用带抖动的指数退避重试网络错误和 5xx；命中 GitHub secondary rate limit（写操作短时间过于密集触发的限制，与主速率限制 5000/hr 是两套机制）时遵循响应中的 `Retry-After`；重试仍失败按阶段分别处理——prepare 阶段失败判 `incomplete`，publish 阶段失败按批次记录失败原因并停止后续批次发布，不产生部分成功又静默结束的中间态。
- 记录各 Agent 和 verifier 延迟、token 用量、候选数、候选淘汰原因、覆盖率、重试和最终状态；日志不输出 Secret 或未脱敏代码。
- 信任门控、单 PR 预算和仓库日预算在 LLM 调用前执行（见"权限与安全边界"中 status-start 的信任门控与仓库启用检查）；超额结果为 `incomplete`，不能通过静默截断换取 `pass`。
- 超预算或信任门控拒绝时，摘要提供可操作原因。维护者可增加预算、临时批准该 PR 或通过 `workflow_dispatch` 重跑；override 记录触发者、理由、身份元组和时间。
- verifier 调用总数、Review 批次数、发布重试次数和重试时间窗口均有中央配置的硬上限；超限直接判定 `incomplete`，由 status-finalize 写入 `timed_out` 或 `action_required`。

## 测试与验收

### 回归评测

- 建立包含真阳性、真阴性、边界情况、历史问题、主观建议和容易误报样例的 `benchmarks/`，目录结构约定为：
  ```
  benchmarks/
    cases/
      swift-retain-cycle/
        diff.patch
        pr-description.md
        expected-findings.json
      go-missing-error-check/
        diff.patch
        expected-findings.json
    run-evaluation.js
  ```
  其中 `expected-findings.json` 用 `{ path, line, category, must_find: true|false }` 描述每个用例期望的 finding（`must_find: false` 用于标注"不应产生 finding"的历史问题/主观建议样例），`run-evaluation.js` 汇总召回率、误报数、`incomplete` 比例、延迟与成本。
- 覆盖正确性、安全、权限、并发、资源泄漏、错误处理、测试、文档和语言规范。
- 度量问题召回率、误报数、candidate 到 finding 的淘汰率、`incomplete` 比例、延迟与成本。
- 验证所有有效问题都出现在最终反馈中，且纯主观偏好和无因果关系的历史问题不会成为 finding。
- 验证 verifier 能剔除证据不足、被上下文反驳和伪造的候选问题。

### 安全与集成测试

- fork PR 无法修改 workflow、custom action、skills 或裁决规则，也无法获取 GitHub 写凭据和 DeepSeek Secret。
- prompt injection、恶意文件名、非法 JSON、越界路径、伪造行号和伪造证据不能进入 publish。
- 验证 custom action 源码、`dist/`、schemas 和 skills 的版本绑定，运行阶段不安装依赖。
- 覆盖重命名、删除、二进制、生成文件、超大 diff、跨文件影响和部分 API 失败。
- 验证审核期间没有任何 PR 评论；全部审核结束后才统一发布。
- 验证任一最终 finding 都产生 `REQUEST_CHANGES`，只有零 finding 的完整审核才产生 `APPROVE`。
- 验证 verifier 失败会产生 `incomplete`，已验证问题会被反馈，未验证候选不会被发布。
- 验证 `REQUEST_CHANGES → 新 commit → APPROVE` 完整生命周期。
- 验证旧身份元组（含旧 `head_sha`、旧 `base_ref`）的延迟结果不会覆盖新结果。
- 验证 PR 关闭、转为草稿或身份元组变化（含仅更换 base branch、head_sha 不变的情况）时不发布 Review/摘要，并把 Check 终结为 `cancelled`。
- 验证 `success`、`failure`、`action_required`、`timed_out` 和 `cancelled` Check Run 状态及后继运行对账，包括 prepare/analyze 阶段硬失败时 status-finalize 依然能将 Check 写入终态；验证工作流在 status-finalize 被调度前即被取消的场景下，运行在目标仓库自身、仅持有该仓库权限的 watchdog Job 能在超时阈值后将遗留的 `in_progress` Check 强制终结，不依赖后续 PR 事件、也不需要任何跨仓库凭据。
- 验证同一身份元组重跑因 LLM 非确定性产出不同 findings 集合时，`review_set_id` 随之变化，不会因命中旧 Review 对象而漏发新增的 finding；验证 `findings_digest` 不匹配时判定为 `incomplete` 而不是静默覆盖。
- 验证同一 `head_sha` 因多次 `workflow_dispatch` 重跑产生不同 `review_set_id` 时，旧一轮的 Review 与 inline comment 被正确 dismiss/追加取代说明，PR 上不会同时存在多份互相矛盾且未加说明的 `REQUEST_CHANGES`。
- 验证 `workflow_dispatch` 触发的重跑能正确绕过信任门控的 author association/白名单判断（视为已放行），且该放行不会被后续自动事件继承。
- 验证信任门控/仓库启用检查失败时，PR 上已存在一个被写为 `action_required` 的 Check Run，而不是完全没有 Check。
- 验证 watchdog 在对应 workflow run 仍处于 `queued`/`in_progress` 时不会误将一个耗时较长、仍在正常执行的大 PR 审核终结为 `timed_out`；只有当 run 自身已 `completed` 而 Check 仍 `in_progress` 时才终结。
- 验证 dismiss 旧 Review 因分支保护限制被拒绝（403）时能正确降级为编辑 Review body 追加取代说明，而不是判定失败或跳过标注。
- 验证 status-start（只清理当前 head_sha 上的 Check）与 watchdog（清理跨历史 head_sha 的孤儿 Check，且在无后续事件触发时也兜底当前 head_sha）之间没有清理空隙；两者在当前 head_sha 上的动作即使短暂重叠也不产生错误结果（watchdog 的 run-status 与合法 Review 核验保证不会误杀仍在执行或已正确完成的运行）。
- 验证 watchdog 在对应 workflow run 已 `completed`、但 publish 其实已经成功发布最终 Review 的场景下，会把 Check 回填为与该 Review 一致的结论，而不是覆盖成 `timed_out`。
- 验证 `pulls/{pr}/files` 命中约 3000 文件上限或个别文件缺少 `patch` 字段时判定为 `incomplete`，而不是按拿到的子集继续审核。
- 验证专家输出的 `coverage_complete` 字段缺失、为 `false`，或 findings 数量恰好等于 `maxItems` 时都被判定为命中硬上限。
- 验证同一 `review_set_id` 手动重跑不会重复发布已成功的批次，部分发布失败后可以按 `batch_index` 恢复。
- 验证 GitHub 单次 Review 容量不足时所有问题仍能分批反馈（中间批次为 `COMMENT`，末批次为最终结论），且最终索引完整。
- 验证机器人没有 merge 权限，也不调用 merge API。
- 验证 `incomplete` 状态下的 `REQUEST_CHANGES` 在 Review body 和摘要评论中带有明确的"未完整覆盖"横幅。
- 验证 candidate findings、verifier 调用数、最终 finding 数、Review 批次数触发硬上限时判定为 `incomplete`，不会静默截断为 `pass`。

### 上线门槛

1. 先以只读 shadow mode 运行，不发布 Review，与人工审核结果对比。
2. 达到预设的问题召回率和误报上限后，启用 comment-only 模式，验证批量反馈质量。
3. 评论模式稳定后启用 `REQUEST_CHANGES`/`APPROVE`，但暂不把 Check Run 设为 required。
4. 最后将 `PR Review Swarm / verdict` 配置为 required check，同时确认仓库所有者保留人工 bypass 能力。

## 实现前置任务

进入编码阶段前需要额外交付、但不属于运行时设计本身的事项：

- 仓库根目录补充 `README.md`：说明项目目标与当前阶段（设计 / 开发中）、目录结构、目标仓库如何引用 reusable workflow（含监听器示例 YAML）、安全模型摘要。
- 补充 `.gitignore`，至少排除 `.DS_Store`、`*.log`、`node_modules/`、`.env`；`dist/` 按本文档要求需随源码一起提交，不加入 `.gitignore`，改由 CI 校验其与源码重新构建结果一致。
- 在中央仓库或监听器模板中提供 workflow 注释/AGENTS.md 级别的硬禁令清单（首条即"禁止 checkout PR head"），供后续人工或 AI 修改 workflow 时对照检查，并配合 CI 静态扫描共同生效。
