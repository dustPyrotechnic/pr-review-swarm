# PR Review Swarm 设计文档

日期：2026-07-13
状态：已确认

## 目标

一个 GitHub PR 审核机器人：多 Agent swarm 并行审核 PR，发现问题时直接在 PR 上向作者提出修改要求；只有全部 Agent 审核通过时才 @dustPyrotechnic 并给出简洁报告。LLM 使用 DeepSeek Anthropic 兼容 API。架构复用 agent-cycle-test 已验证的「中央可复用引擎 + 目标仓库监听器」模式与安全模型。

## 运行形态

- 中央仓库提供可复用工作流 `reusable-pr-review.yml`；目标仓库安装小型监听器，由 `pull_request`（`opened` / `synchronize` / `reopened`）触发。
- 审核对任何作者的 PR 生效（守门员定位）。信任门控仅用于防止恶意消耗 API 额度；对外部 PR **只读 diff、不 checkout 执行 PR 代码**。
- DeepSeek API Key 与 GITHUB_TOKEN 只由包装脚本持有；Agent 进程不接触 GITHUB_TOKEN（沿用 agent-cycle 安全模型）。

## Swarm 架构：并行专家 + 主审汇总

1. **准备阶段**（脚本）：拉取 PR diff、变更文件全文、PR 描述，生成统一审核上下文包；按变更文件的语言/路径决定各 Agent 的 skill 装备。
2. **并行阶段**：三个专家 Agent 并行，各输出结构化 JSON findings（文件、行号、严重度、说明、建议、`skill_requests`）：
   - 正确性/逻辑 Agent
   - 安全 Agent（凭据泄露、注入、权限）
   - 可维护性/规范 Agent（含用户代码风格约定）
3. **主审 Agent**：合并 findings，去重、剔除低置信度噪音，给出结论 `pass` 或 `changes_requested`。
4. **定向补充审核（可选，最多一轮）**：若专家提出 `skill_requests`，主审装载被请求的 skill，起补充 Agent 只审对应文件/问题，结果并入最终 findings。有界，不循环。

## Skill 装备机制

- 中央仓库 `skills/` 目录，每个 skill 为 Markdown 检查清单（触发条件 + checklist），附 `index.md` 目录页（名称 + 一行描述）。
- 静态预装（按职能）：
  - 正确性：`systematic-review`、`swift-review`、`objc-review`、`go-review`（内含风格约定：OC 2 空格 / Swift 4 空格 / Go tab；DocC 与 godoc 注释风格；Masonry、AFNetworking、SDWebImage 约定）。
  - 安全：`secret-scanning`、`injection-checklist`、`ios-keychain-conventions`。
  - 可维护性：`style-conventions`、`docc-comment-style`。
- 动态装载：Agent 只能从 `index.md` 白名单中选择 skill；**PR 内容属不可信输入，绝不能作为 skill 源装载**（防 prompt 注入）。

## 交付逻辑

- 有问题 → GitHub Review API 发 `REQUEST_CHANGES`：按严重度排序的简洁问题列表，可附 inline 行级评论，@PR 作者，不打扰用户。
- 作者 push 新 commit → `synchronize` 触发全量重审。
- 全部通过 → 评论 `@dustPyrotechnic ✅ 审核通过` + 三句话以内摘要（改了什么、风险点、是否建议合并）。
- 同一 PR 重复运行时更新既有评论，不刷屏。

## 错误处理

- 超大 diff：截断并在报告中声明未覆盖范围。
- API 失败：重试后仍失败则发评论声明「审核未完成」，绝不静默通过。

## 测试

仿照 agent-cycle-test 的 `benchmarks/`：准备含已知缺陷的样例 PR diff 作为回归用例，验证专家 Agent 能命中已知问题、主审不产生误报刷屏。
