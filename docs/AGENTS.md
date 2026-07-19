# 硬禁令清单（修改 workflow/action 前必读）

以下每条均引用 `docs/plans/2026-07-13-pr-review-swarm-design.md`（设计文档）的具体行号，行号以撰写本文档时的版本为准；设计文档改版后如行号偏移，请以文中引用的原文语句重新定位。

1. 禁止在任何 workflow 中对 PR head 执行 checkout（即 `ref:` 指向
   `github.event.pull_request.head.*` 或等价表达式），不安装 PR 依赖，不执行 PR 中的
   任何代码、脚本或配置。参见设计文档 L42："这是硬禁令：任何后续实现或 AI 辅助修改都
   不得为 workflow/action 增加 `actions/checkout` 之类使用
   `ref: ${{ github.event.pull_request.head.sha }}` 或等价 PR head 引用的步骤。"
2. 禁止执行 PR 中的任何代码、脚本、配置或依赖安装。参见设计文档 L42："仅把 PR 内容作为
   数据读取，不 checkout PR head，不安装 PR 依赖，不执行 PR 中的任何代码、脚本或配置。"
3. 禁止让 analyze Job 获得任何可写 GitHub 凭据或 `contents: read`。参见设计文档 L56：
   "**analyze**：设置 `permissions: {}`……不获得可写 GitHub 凭据，也不获得
   `contents: read`（因此不能调用 GitHub API 读取仓库内容，只能使用 prepare 传入的
   artifact 和 action 自带的本地资源）。"
4. 禁止让 publish Job 获得 DeepSeek Secret 或调用 LLM。参见设计文档 L57："**publish**：
   仅使用 `contents: read`、`pull-requests: write` 和 `issues: write`……不获得 DeepSeek
   Secret，不调用 LLM，也不持有 `checks: write`。"
5. 禁止把 GITHUB_TOKEN 之外的凭据、日志或未脱敏代码写入 artifact/日志。参见设计文档
   L65（"DeepSeek Secret 只作为受控客户端的输入，不传给子进程、提示词、日志或
   artifact。"）、L76（"疑似 Secret 先由本地确定性扫描器检测并脱敏，不向 LLM 发送完整
   凭据。"）、L263（"日志不输出 Secret 或未脱敏代码。"）。
6. 禁止绕开 `permissions: {}`/最小权限声明去"临时"扩大某个 Job 的权限。参见设计文档
   L48-57（"权限与安全边界"一节：五个 Job 各自显式声明 `permissions` 和可见 Secret，
   互不越权）。
7. 禁止跳过确定性证据校验或独立 verifier 直接发布候选问题。参见设计文档 L114-120：
   "每个 candidate finding 都必须依次通过：1. 确定性证据校验……2. 独立
   verifier……3. 主审汇总……只有验证通过的候选才能成为最终 finding。主审不能新增未经
   同样流程验证的问题。"
8. 禁止在命中 maxItems/verifier/finding/batch 等硬上限后静默截断继续按
   pass/changes_requested 处理——必须判 incomplete。参见设计文档 L93（"超出单次上下文
   窗口时进行多分片审核，不静默截断，也不因预算只展示 Top N 问题。"）、L110（"任一上限
   被触发，本次运行直接判定为 `incomplete`，不得截断后按 `pass`/`changes_requested`
   处理。"）、L264、L318（同一原则在信任门控预算和最终验收标准中重申）。
