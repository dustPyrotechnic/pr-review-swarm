# PR Review Swarm 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `docs/plans/2026-07-13-pr-review-swarm-design.md`（下称"设计文档"）落地为可运行的中央 reusable workflow + custom action + schemas + skills + benchmarks，按"上线门槛"分四个阶段逐步启用能力。

**Architecture:** 单一 custom action（`action/`，Node/TypeScript，构建为单个 `dist/index.js`，通过 `entrypoint` 输入分发到 `status-start` / `prepare` / `analyze` / `publish` / `status-finalize` / `watchdog` 六个处理器），配合两个 reusable workflow 文件（常规审核用 + watchdog 用，均 `uses:` 同一 action、按 commit SHA 固定），Job 级权限隔离。

**Tech Stack:** TypeScript + `@actions/core`/`@actions/github`（octokit）+ esbuild（打包 dist）+ ajv（JSON Schema 校验）+ Vitest/Jest（单测）+ actionlint（workflow 静态检查）。

---

## 0. 本计划与设计文档的关系（请先确认）

设计文档已定稿（"状态：已确认，待实现验证"），本计划**不重新讨论整体架构**。以下是本计划为了把文档转成可执行任务而做出的、**文档本身未明确规定**的实现选择，全部标记为「待确认」，请您在动工前过目：

| # | 待确认项 | 设计文档依据 | 本计划的默认提案 |
|---|---------|-------------|----------------|
| A | 四个"上线门槛"阶段如何在同一份代码上推进，而不是重复造轮子 | 文档 L33："目标仓库只安装小型监听器并固定调用的 commit SHA" | **阶段 = 代码演进阶段**：Phase 1 完成后目标仓库的监听器指向的 pinned SHA 只具备只读能力；Phase 2/3 往 `publish.ts` 里新增真实 GitHub 写入代码路径后，目标仓库把 pinned SHA 升级到新 commit 即视为"启用"下一阶段能力。**不引入运行时 mode 开关**，避免文档之外的配置面。 |
| B | 目标仓库级配置文件（信任白名单、仓库启用开关、默认 mention、ignore/generated 规则、风格覆盖）格式 | 文档 L50、L51、L52、L78、L184 反复提到"仓库配置"但未给格式 | 新增 `.github/pr-review-swarm.yml`（目标仓库 base_sha 下读取），字段见 1.3 |
| C | 中央硬上限（`maxItems=30`、`N=3`、verifier/finding/batch 上限、watchdog 超时阈值默认 30 分钟）存放位置 | 文档 L110、L126、L249 称"中央配置" | `action/config/central-limits.json`，随 action 一起提交、随版本走 |
| D | DeepSeek 允许模型名单的具体取值 | 文档 L27 只说"校验模型名是否在允许列表中"，未给出具体模型 ID | `action/config/allowed-models.json`，**需要您提供实际要开放的 DeepSeek 模型 ID**，Phase 1 先用占位值跑通单测，真实值由您确认后再填 |
| E | prepare 阶段"按显式规则补充相关声明、直接调用方、被调用 API、测试和可信配置"的具体规则集 | 文档 L91 只要求"显式"，未给出规则本身 | Phase 1 先实现一版最小规则（同文件全量、同目录直接 import、命名匹配的测试文件），标注为可迭代项，不假装是文档要求的最终方案 |
| F | watchdog 的 `schedule` cron 间隔 | 文档只给了"超时阈值默认 30 分钟"（L249），未给出扫描频率 | 提案每 10 分钟一次（`*/10 * * * *`），在超时阈值内至少有 2-3 次扫描机会 |
| G | 两个 reusable workflow 文件如何提供 "prepare/analyze/publish/finalize" 与 "watchdog" 两套触发 | 文档 L247："与 prepare/analyze/publish/finalize **同源但独立触发**" | 拆成 `reusable-pr-review.yml`（5 个 Job，`pull_request_target`/`workflow_dispatch` 触发）和 `reusable-pr-review-watchdog.yml`（1 个 Job，`workflow_call` 供目标仓库的 `schedule` workflow 调用），两者 `uses:` 同一个 `action/action.yml`，仅 `entrypoint` 输入不同 |
| H | Phase 1→2 门槛所需的"预设召回率和误报上限"数值 | 文档 L323 只说"达到预设的问题召回率和误报上限"，未给数值 | 这是业务判断，不是实现细节，本计划不代填数字，作为 Phase 1 退出的人工检查项列出，需要您在真实/沙盒仓库跑 shadow mode 后自行拍板 |
| I | 轻量状态清理（`converted_to_draft`/`closed`）是否与 status-start 共用同一个 action 入口 | 文档 L39："轻量状态清理复用 status-start 的入口和权限……不需要额外 Job 或权限声明"——字面意思是复用同一个 entrypoint，但 Task 0.1/1.4b 把它实现为独立的 `lightweight-cleanup` entrypoint/文件 | **确认保留独立 entrypoint**：文档 L39 的核心约束是"不需要额外 Job 或权限声明"，独立 entrypoint 只是同一个 Job 内的另一个 `entrypoint` 输入值，不产生额外 Job/权限，满足文档实质要求；独立文件写法比在 status-start.ts 内部按事件类型分支更清晰。此项为 Round 2 独立代码审核发现并经您确认，之前"未发现文档内部矛盾"的表述有误，特此补记。 |

以上任何一项如果您有不同意见，请在开工前告诉我；否则默认按上表执行。**除上表外，本计划严格对应设计文档条款，未发现文档内部矛盾**（如实现中发现具体的、可指出行号的矛盾，会停下来向您报告，不会绕过设计意图自行"修正"）。

---

## 阶段总览

| 阶段 | 对应"上线门槛" | 交付内容 | 目标仓库可见行为 |
|------|--------------|---------|-----------------|
| Phase 0 | （前置，非门槛本身） | 项目脚手架、CI、硬禁令清单 | 无（尚未产出可用 action） |
| Phase 1 | ① shadow mode 只读 | schemas、skills 机制、status-start/prepare/analyze 全部逻辑、裁决规则纯函数、诊断态 publish（只写 job summary + artifact，不调用任何 GitHub 写 API）、status-finalize、watchdog（Check 清理部分）、两个 reusable workflow、benchmarks 骨架 | Check Run 会出现（in_progress → 终态），但**没有任何 Review/评论**发布到 PR 上 |
| Phase 2 | ② comment-only | `publish.ts` 新增真实 GitHub 写入：固定摘要评论、Review 批量发布，但**发布事件类型永远是 `COMMENT`**，不产出 `REQUEST_CHANGES`/`APPROVE`；review_set_id/批次对账/旧 review_set_id 收尾逻辑 | PR 上出现评论和 inline comment，但审核状态永远不变 |
| Phase 3 | ③ 启用 REQUEST_CHANGES/APPROVE（非 required） | `publish.ts` 按裁决规则产出真正的 `REQUEST_CHANGES`/`APPROVE`；incomplete 横幅；watchdog 完整回填逻辑；完整安全与集成测试清单跑通 | PR 审核状态真实变化，但仓库尚未把 Check 设为 required，人工可忽略 |
| Phase 4 | ④ required check | 仓库分支保护配置（人工操作，非代码）、watchdog 长期可靠性验证、最终验收 | Check 成为合并门禁，所有者保留 bypass 能力 |

**关于任务粒度的说明**：本项目大量交付物是 JSON Schema、workflow YAML、skill Markdown 这类可以完整给出内容的"数据"，这部分计划里会给出完整文本。但 `analyze`/`publish` 内部的业务逻辑模块（专家调度、verifier、arbiter 等）体量大、涉及提示词工程留有迭代空间，计划里给出的是**精确的文件路径、接口签名、算法要点（对应设计文档具体行号）和验收标准**，实际编码时仍按 TDD 从失败测试开始逐步实现，不在计划文档里预先塞入全部实现代码（那样体量会超过合理范围，也不符合"先写失败测试"的方法论）。

---

## Phase 0：脚手架与工具链

### Task 0.1：初始化 action/ TypeScript 项目

**Files:**
- Create: `action/package.json`
- Create: `action/tsconfig.json`
- Create: `action/.eslintrc.cjs`
- Create: `action/src/index.ts`（入口，读取 `core.getInput('entrypoint')` 后 dispatch）
- Create: `action/action.yml`

**内容要点：**

`action/action.yml`：
```yaml
name: 'PR Review Swarm'
description: 'Central action providing status-start/prepare/analyze/publish/status-finalize/watchdog entrypoints'
inputs:
  entrypoint:
    description: 'One of: status-start, prepare, analyze, publish, status-finalize, watchdog, lightweight-cleanup'
    required: true
runs:
  using: 'node20'
  main: 'dist/index.js'
```

`action/src/index.ts` 骨架：
```typescript
import * as core from '@actions/core';

async function run(): Promise<void> {
  const entrypoint = core.getInput('entrypoint', { required: true });
  switch (entrypoint) {
    case 'status-start':
      return (await import('./entrypoints/status-start')).run();
    case 'lightweight-cleanup':
      return (await import('./entrypoints/lightweight-cleanup')).run();
    case 'prepare':
      return (await import('./entrypoints/prepare')).run();
    case 'analyze':
      return (await import('./entrypoints/analyze')).run();
    case 'publish':
      return (await import('./entrypoints/publish')).run();
    case 'status-finalize':
      return (await import('./entrypoints/status-finalize')).run();
    case 'watchdog':
      return (await import('./entrypoints/watchdog')).run();
    default:
      core.setFailed(`unknown entrypoint: ${entrypoint}`);
  }
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
```

**验收标准：** `npm run build` 在 `action/` 下产出 `action/dist/index.js`；`npm run typecheck` 通过；对一个尚不存在的 entrypoint 调用会 `core.setFailed` 而不是抛未捕获异常。

### Task 0.2：esbuild 打包配置

**Files:**
- Create: `action/esbuild.config.mjs`
- Modify: `action/package.json`（新增 `build` script）

打包为单一 `action/dist/index.js`（`platform: node, target: node20, bundle: true, external: []`，不排除任何依赖——文档 L35 要求运行时不 `npm install`，所有依赖必须打进 dist）。

**验收标准：** 删除 `node_modules` 后，`node action/dist/index.js` 在设置了 `INPUT_ENTRYPOINT=status-start` 等环境变量时能跑到"缺少必要的 GitHub 上下文"这类预期错误，而不是 `MODULE_NOT_FOUND`。

### Task 0.3：CI 骨架

**Files:**
- Create: `.github/workflows/ci.yml`

Job 拆分：
1. `lint-typecheck-test`：`npm ci && npm run lint && npm run typecheck && npm test`（工作目录 `action/`）。
2. `build-dist-no-drift`：重新执行 `npm run build`，然后 `git diff --exit-code -- action/dist` —— 对应文档 L36"CI 必须从源码重新构建 dist/ 并验证没有未提交差异"。
3. `schema-validate`：用 ajv-cli 对 `schemas/*.schema.json` 本身做 meta-schema 校验，并对 `schemas/fixtures/**` 下的正反例做 validate（正例必须通过，反例必须失败）。
4. `actionlint`：对 `.github/workflows/*.yml` 跑 [actionlint](https://github.com/rhysd/actionlint)。
5. `forbidden-pr-head-ref-scan`：静态扫描所有 workflow YAML，若匹配到 `ref:\s*.*github\.event\.pull_request\.head` 或等价的 PR head 引用模式，直接 fail —— 对应文档 L42"CI 增加静态扫描，检测 workflow YAML 中出现的危险 ref: 模式并拒绝合并"。这是**硬约束**，脚本示例：
   ```bash
   if grep -RnE 'ref:\s*.*github\.event\.pull_request\.head' .github/workflows; then
     echo "::error::检测到疑似 checkout PR head 的 ref，禁止合并"
     exit 1
   fi
   ```

**验收标准：** 故意在一个临时分支的 workflow 里加入 `ref: ${{ github.event.pull_request.head.sha }}`，确认 CI 的第 5 个 Job 会失败；故意手改 `action/dist/index.js` 一个字符但不改源码，确认第 2 个 Job 会失败。

### Task 0.4：硬禁令清单文档

**Files:**
- Create: `docs/AGENTS.md`

内容：对应文档"实现前置任务"第 3 条，列出首条即"禁止 checkout PR head"的清单，每条注明设计文档行号出处，供后续人工/AI 修改 workflow 时对照：

```markdown
# 硬禁令清单（修改 workflow/action 前必读）

1. 禁止在任何 workflow 中对 PR head 执行 checkout（即 `ref:` 指向
   `github.event.pull_request.head.*` 或等价表达式）。参见设计文档
   「中央组件与运行形态」一节，"这是硬禁令"。
2. 禁止执行 PR 中的任何代码、脚本、配置或依赖安装。
3. 禁止让 analyze Job 获得任何可写 GitHub 凭据或 `contents: read`。
4. 禁止让 publish Job 获得 DeepSeek Secret 或调用 LLM。
5. 禁止把 GITHUB_TOKEN 之外的凭据、日志或未脱敏代码写入 artifact/日志。
6. 禁止绕开 `permissions: {}`/最小权限声明去"临时"扩大某个 Job 的权限。
7. 禁止跳过确定性证据校验或独立 verifier 直接发布候选问题。
8. 禁止在命中 maxItems/verifier/finding/batch 等硬上限后静默截断继续按
   pass/changes_requested 处理——必须判 incomplete。
```

**验收标准：** 文件存在，且 CI 的 forbidden-ref 扫描独立于本文档生效（本文档是给人看的清单，不是扫描器本身）。

### Task 0.5：中央配置占位文件

**Files:**
- Create: `action/config/central-limits.json`
- Create: `action/config/allowed-models.json`

`central-limits.json`（默认值取自设计文档明确给出的数字）：
```json
{
  "maxCandidateFindingsPerAgentPerShard": 30,
  "maxSkillRequestsPerRun": 3,
  "maxVerifierCallsPerRun": 200,
  "maxFinalFindingsPerRun": 200,
  "maxReviewBatchesPerRun": 20,
  "maxPublishRetries": 5,
  "watchdogStaleThresholdMinutes": 30,
  "maxCommitsPerPrForWatchdogScan": 250,
  "maxPrFilesPerPage": 3000
}
```
（后三项数字对应文档提到的 GitHub API 已知限制，不是"中央可调策略"，写在这里只是为了让代码里有一处集中引用，注释需说明这几项是 GitHub 平台限制，不能通过调大这个文件来"提高上限"。）

`allowed-models.json`（占位，待您确认真实模型 ID 后替换）：
```json
{
  "allowedModels": ["__PLACEHOLDER_DO_NOT_USE_IN_PRODUCTION__"]
}
```

**验收标准：** 有单测验证"模型名不在 `allowedModels` 里 → 视为配置错误"这条路径（用占位值即可验证逻辑，不依赖真实模型名）。

---

## Phase 1：Shadow Mode（只读）

### Task 1.1：JSON Schemas

**Files:**
- Create: `schemas/candidate-finding.schema.json`
- Create: `schemas/finding.schema.json`
- Create: `schemas/expert-output.schema.json`
- Create: `schemas/coverage-manifest.schema.json`
- Create: `schemas/verdict.schema.json`
- Create: `schemas/repo-config.schema.json`（对应待确认项 B）
- Create: `action/src/lib/schema-validator.ts`
- Test: `action/src/lib/schema-validator.test.ts`

`schemas/candidate-finding.schema.json`（对应设计文档 L128-136"Finding 数据"一节列出的字段，候选阶段尚无验证结果）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/candidate-finding.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id", "path", "line", "side", "severity", "confidence", "category",
    "title", "evidence", "impact", "suggestion",
    "introduced_by_pr", "source_agent"
  ],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "path": { "type": "string", "minLength": 1 },
    "line": { "type": "integer", "minimum": 1 },
    "side": { "type": "string", "enum": ["LEFT", "RIGHT"] },
    "start_line": { "type": "integer", "minimum": 1 },
    "start_side": { "type": "string", "enum": ["LEFT", "RIGHT"] },
    "severity": { "type": "string", "enum": ["critical", "high", "medium", "low"] },
    "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
    "category": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "minLength": 1 },
    "evidence": { "type": "string", "minLength": 1 },
    "impact": { "type": "string", "minLength": 1 },
    "suggestion": { "type": "string", "minLength": 1 },
    "introduced_by_pr": { "type": "boolean" },
    "cross_file_causal_claim": {
      "type": "boolean",
      "description": "true 表示该问题的 introduced_by_pr 判断依赖跨文件调用链，必须交给独立 verifier 复核（设计文档 L87）"
    },
    "causal_evidence_refs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "line"],
        "properties": {
          "path": { "type": "string" },
          "line": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "source_agent": { "type": "string", "minLength": 1 }
  },
  "if": {
    "anyOf": [
      { "required": ["start_line"] },
      { "required": ["start_side"] }
    ]
  },
  "then": {
    "required": ["start_line", "start_side"]
  }
}
```

`schemas/finding.schema.json`（`allOf` 引用 candidate-finding 并追加验证结果字段，对应 L136）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/finding.schema.json",
  "allOf": [
    { "$ref": "https://pr-review-swarm/schemas/candidate-finding.schema.json" }
  ],
  "type": "object",
  "required": ["evidence_validation", "verifier_conclusion"],
  "properties": {
    "evidence_validation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["status"],
      "properties": {
        "status": { "const": "passed" },
        "notes": { "type": "string" }
      }
    },
    "verifier_conclusion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["status"],
      "properties": {
        "status": { "const": "confirmed" },
        "notes": { "type": "string" },
        "evidence_refs": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["path", "line"],
            "properties": { "path": { "type": "string" }, "line": { "type": "integer" } }
          }
        }
      }
    }
  }
}
```

`schemas/expert-output.schema.json`（专家单次运行的结构化输出，`maxItems` 与 `coverage_complete` 是硬上限可观测性的核心，对应 L110）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/expert-output.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["shard_id", "agent", "candidate_findings", "coverage_complete"],
  "properties": {
    "shard_id": { "type": "string" },
    "agent": { "type": "string" },
    "candidate_findings": {
      "type": "array",
      "maxItems": 30,
      "items": { "$ref": "https://pr-review-swarm/schemas/candidate-finding.schema.json" }
    },
    "coverage_complete": { "type": "boolean" }
  }
}
```
> 注：`maxItems: 30` 写死在 schema 里是当前默认值。若未来 `action/config/central-limits.json` 调整该值，需要同步用一个小脚本重新生成本 schema（`scripts/generate-expert-output-schema.mjs`，Phase 1 内一并创建），不能让两处数字各自漂移。

`schemas/coverage-manifest.schema.json`（对应 L96 覆盖清单最低字段要求）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/coverage-manifest.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["files", "shards_complete", "hard_limit_hit", "token_usage"],
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "treatment", "shard_id", "status"],
        "properties": {
          "path": { "type": "string" },
          "treatment": { "type": "string", "enum": ["reviewed", "skipped_binary", "skipped_generated", "skipped_vendor", "skipped_lockfile", "skipped_budget"] },
          "shard_id": { "type": "string" },
          "status": { "type": "string", "enum": ["success", "failed"] },
          "skip_reason": { "type": "string" },
          "agents": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "shards_complete": { "type": "boolean" },
    "hard_limit_hit": { "type": "boolean" },
    "pulls_files_pagination_truncated": { "type": "boolean" },
    "missing_patch_files": { "type": "array", "items": { "type": "string" } },
    "token_usage": {
      "type": "object",
      "additionalProperties": false,
      "required": ["prompt_tokens", "completion_tokens"],
      "properties": {
        "prompt_tokens": { "type": "integer", "minimum": 0 },
        "completion_tokens": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

`schemas/verdict.schema.json`（publish 产出、status-finalize 消费的裁决结果摘要，对应 L57）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/verdict.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["identity_tuple", "verdict", "review_set_id", "final_findings_count"],
  "properties": {
    "identity_tuple": {
      "type": "object",
      "additionalProperties": false,
      "required": ["head_repo", "head_sha", "base_repo", "base_ref", "base_sha", "merge_base_sha"],
      "properties": {
        "head_repo": { "type": "string" },
        "head_sha": { "type": "string" },
        "base_repo": { "type": "string" },
        "base_ref": { "type": "string" },
        "base_sha": { "type": "string" },
        "merge_base_sha": { "type": "string" }
      }
    },
    "verdict": { "type": "string", "enum": ["pass", "changes_requested", "incomplete", "stale_cancelled"] },
    "incomplete_reasons": { "type": "array", "items": { "type": "string" } },
    "review_set_id": { "type": "string" },
    "final_findings_count": { "type": "integer", "minimum": 0 },
    "final_review_event": { "type": "string", "enum": ["APPROVE", "REQUEST_CHANGES", "COMMENT", "none"] }
  }
}
```

`schemas/repo-config.schema.json`（待确认项 B 的具体格式）：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://pr-review-swarm/schemas/repo-config.schema.json",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enabled": { "type": "boolean" },
    "trusted_users": { "type": "array", "items": { "type": "string" } },
    "default_mention": { "type": "string" },
    "ignore_globs": { "type": "array", "items": { "type": "string" } },
    "generated_globs": { "type": "array", "items": { "type": "string" } }
  }
}
```

`action/src/lib/schema-validator.ts`：基于 ajv 封装 `validate<T>(schemaId: string, data: unknown): { valid: true, data: T } | { valid: false, errors: string[] }`，编译期把所有 `schemas/*.schema.json` 注册到同一个 ajv 实例（解决 `$ref` 互相引用）。

**Step: 写测试 fixture 与失败测试**

`schemas/fixtures/candidate-finding/valid-1.json`、`schemas/fixtures/candidate-finding/invalid-unknown-field.json`、`invalid-bad-side-enum.json` 等，配合 `schema-validator.test.ts` 逐一断言。

**验收标准：**
- 未知字段、非法 `side` 枚举、越界 `line`（<1）、`start_line` 存在但缺 `start_side` 均被拒绝。
- `expert-output` 的 `candidate_findings` 长度为 31 时被 ajv 拒绝（`maxItems` 生效）；长度为 30 且合法时通过。
- `coverage_complete` 缺失时被拒绝（`required`）。

### Task 1.2：身份元组模块

**Files:**
- Create: `action/src/lib/identity-tuple.ts`
- Test: `action/src/lib/identity-tuple.test.ts`

接口：
```typescript
export interface IdentityTuple {
  headRepo: string; headSha: string;
  baseRepo: string; baseRef: string; baseSha: string;
  mergeBaseSha: string;
}
export async function fetchIdentityTuple(octokit, owner, repo, prNumber): Promise<IdentityTuple>;
export function identityTuplesEqual(a: IdentityTuple, b: IdentityTuple): boolean;
```
`fetchIdentityTuple` 调用 `GET /repos/{owner}/{repo}/pulls/{pr}`，并用 compare API（`GET /repos/{owner}/{repo}/compare/{base}...{head}`）取 `merge_base_commit.sha` 得到 `merge_base_sha`。

**验收标准：** 单测用 mock octokit 响应验证字段映射正确；`identityTuplesEqual` 对 `baseRef`/`baseSha` 任一变化返回 `false`（对应文档 L41 换 base branch 视同新一轮审核）。

### Task 1.3：目标仓库配置读取

**Files:**
- Create: `action/src/lib/repo-config.ts`
- Test: `action/src/lib/repo-config.test.ts`

`loadRepoConfig(octokit, owner, repo, baseSha): Promise<RepoConfig>`：通过 `GET /repos/{owner}/{repo}/contents/.github/pr-review-swarm.yml?ref={baseSha}` 读取，用 `js-yaml` 解析后经 `repo-config.schema.json` 校验；文件不存在时返回默认值 `{ enabled: false, trusted_users: [], ignore_globs: [], generated_globs: [] }`（未显式启用 = 未启用，对应文档 L52 私有仓库默认不启用的精神，公开仓库也需要显式 opt-in 更安全）。

**验收标准：** 文件不存在 → 默认 `enabled:false`；文件存在但 schema 校验失败 → 抛出明确错误（视为配置错误，不静默忽略）。

### Task 1.4：trust-gate 与 status-start entrypoint

**Files:**
- Create: `action/src/lib/trust-gate.ts`
- Create: `action/src/entrypoints/status-start.ts`
- Test: `action/src/lib/trust-gate.test.ts`
- Test: `action/src/entrypoints/status-start.test.ts`

`trust-gate.ts` 精确实现文档 L44/L51 的判定顺序：
```typescript
export type TrustDecision =
  | { allowed: true; reason: 'workflow_dispatch' | 'author_association' | 'trusted_whitelist' }
  | { allowed: false; reason: 'author_association_and_whitelist_miss' };

export function evaluateTrustGate(input: {
  eventName: string;
  authorAssociation: string; // OWNER/MEMBER/COLLABORATOR/... from GitHub payload
  senderLogin: string;
  repoConfig: RepoConfig;
}): TrustDecision;
```
规则：`eventName === 'workflow_dispatch'` → 直接 `allowed:true`（触发者 write 权限已由监听器层用 `GET /repos/{owner}/{repo}/collaborators/{username}/permission` 校验，见 Task 1.4b）；否则 `authorAssociation` 属于 `OWNER|MEMBER|COLLABORATOR` → 放行；否则查 `repoConfig.trusted_users` 是否包含 PR 作者 → 命中放行；否则拒绝。**每次自动事件都重新判定，不缓存历史放行结果**（对应 L51"该放行只对触发时锁定的当前 head_sha 生效，是一次性的"）。

`status-start.ts` 执行顺序**严格按文档 L54**：
1. 调用 identity-tuple 锁定当前身份元组。
2. **先**用 `POST /repos/{owner}/{repo}/check-runs` 创建 `status=in_progress` 的 `PR Review Swarm / verdict` Check（`external_id` 编码 repo/PR/身份元组/run id/attempt，见 Task 1.11 的 check-run.ts 共用模块）。
3. 清理同一 `head_sha` 上被本次运行取代的旧 `in_progress` Check（`GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs`，按 `external_id` 前缀匹配后 `PATCH` 为 `cancelled`）。
4. 执行仓库启用检查（读 repo-config，`enabled !== true` 且仓库私有 → `action_required` 并结束；注意：文档只强制私有仓库必须显式启用，公开仓库本计划也要求 `enabled: true` 才继续，属于本计划在 B 项下的保守选择，比文档要求更严格但不矛盾）。
5. 执行 trust-gate；`allowed:false` → 把步骤 2 创建的 Check 直接 `PATCH` 为 `conclusion=action_required` 并结束，不再进入 prepare/analyze。
6. 若还需要触发者 write 权限校验（仅 `workflow_dispatch` 事件），调用 `GET /repos/{owner}/{repo}/collaborators/{username}/permission`，按文档 L44 的 `none < read < triage < write < maintain < admin` 顺位判定"至少 write"；返回值超出内置枚举一律按不满足处理；不满足则同样把 Check 写为 `action_required` 并结束。

**Files（补充）：**
- Create: `action/src/lib/check-run.ts`（`createInProgressCheck`、`patchCheckConclusion`、`listCheckRunsForRef`、`external_id` 编解码——供 status-start/status-finalize/watchdog 共用）
- Test: `action/src/lib/check-run.test.ts`

**验收标准：**
- 单测覆盖：门控失败时 Check 已经存在且被写为 `action_required`（不是"完全没有 Check"），对应文档 L307 的验收要求。
- 单测覆盖：`workflow_dispatch` 触发时 author_association 判定被跳过，改走 write 权限判定。
- 单测覆盖：同一 head_sha 上存在旧 `in_progress` Check 时被正确 `cancelled`。

### Task 1.4b：轻量状态清理入口

**Files:**
- Create: `action/src/entrypoints/lightweight-cleanup.ts`
- Test: `action/src/entrypoints/lightweight-cleanup.test.ts`

对应文档 L39：`converted_to_draft`/`closed` 事件只读取 PR 当前状态，把本 PR 现有 `in_progress` Check 终结为 `cancelled`，复用 `check-run.ts`，不进入 prepare/analyze/publish。

**验收标准：** 给定一个存在 `in_progress` Check 的 PR，调用后该 Check 变为 `cancelled`；不产生任何 Review/评论调用（因为这个入口根本不持有 `pull-requests: write`/`issues: write`）。

### Task 1.5：prepare entrypoint

**Files:**
- Create: `action/src/lib/diff-parser.ts` — 解析 `pulls/{pr}/files` 返回的 `patch` 字段为 hunk 模型（`{ path, side, lines: [{oldLine?, newLine?, type}] }`）。
- Create: `action/src/lib/pr-files-pagination-guard.ts` — 检测返回文件数是否达到 3000（`central-limits.json` 的 `maxPrFilesPerPage`）、以及是否存在预期变更文件缺 `patch` 字段，命中任一则标记 `pulls_files_pagination_truncated`/`missing_patch_files`（对应 L90）。
- Create: `action/src/lib/file-classifier.ts` — 二进制/生成文件/vendor/lockfile 判定（结合 repo-config 的 `ignore_globs`/`generated_globs`，见待确认项 E）。
- Create: `action/src/lib/context-resolver.ts` — 按 1.5 的最小规则集补充上下文，每个补充文件记录 `{ path, reason, sha }`。
- Create: `action/src/lib/secret-scanner.ts` — 确定性正则扫描疑似 Secret 并脱敏（对应 L76）。
- Create: `action/src/lib/sharding.ts` — 按文件/hunk 分片，超预算（文件数/字节数/分片数）判定为 `incomplete`。
- Create: `action/src/entrypoints/prepare.ts`
- Test: 以上每个 lib 一份对应 `.test.ts`

`prepare.ts` 流程：复验并锁定身份元组（若与 status-start 记录的不一致，判 `stale`）→ 拉取 `pulls/{pr}/files`（分页，pagination-guard 检查）→ file-classifier 分类 → diff-parser 解析 hunk → context-resolver 补充上下文 → secret-scanner 脱敏 → sharding 按预算切分 → 生成 `coverage-manifest`（schema 校验）→ 把上下文包 + 覆盖清单作为 artifact 输出（用 `schemas/prepare-artifact.schema.json`，本任务一并补充这个 schema，字段为 `{ identity_tuple, shards: [...], coverage_manifest }`）。

**验收标准：**
- 命中 3000 文件上限或缺 `patch` 字段 → `coverage_manifest.pulls_files_pagination_truncated`/`missing_patch_files` 非空，且 prepare 整体标记 `incomplete`（不是"用拿到的子集继续"）。
- 二进制/vendor/lockfile 文件出现在 `files[].treatment` 且带 `skip_reason`。
- 超过预算上限（用小的测试用 fixture 值触发）→ `incomplete`。

### Task 1.6：skills 装备机制

**Files:**
- Create: `skills/index.md`
- Create: `skills/generic-correctness.md`
- Create: `skills/generic-security.md`
- Create: `skills/generic-maintainability.md`
- Create: `skills/swift-review.md`（设计文档 L165-182 给出的原样示例）
- Create: `action/src/lib/skill-loader.ts`
- Test: `action/src/lib/skill-loader.test.ts`

`skills/index.md`（格式按文档 L160-164）：
```markdown
# Skill Index

- generic-correctness: v1 | * | 正确性/逻辑通用审查清单
- generic-security: v1 | * | 安全通用审查清单（凭据、注入、权限、供应链）
- generic-maintainability: v1 | * | 可维护性/规范通用审查清单
- swift-review: v3 | *.swift | Swift 正确性、内存管理与并发审查清单
```

`skills/swift-review.md` 与设计文档 L166-182 完全一致地复制过来（front matter `name/version/triggers/category` + Checklist）。

`generic-correctness.md` / `generic-security.md` / `generic-maintainability.md` 各自包含 front matter（`name/version/triggers: ["*"]/category`）+ 对应"正确性/逻辑""安全""可维护性/规范"三个专家（设计文档 L104-106）的通用 checklist。

`skill-loader.ts`：
```typescript
export interface SkillMeta { name: string; version: number; triggers: string[]; category: string; }
export function parseIndex(indexMd: string): SkillMeta[]; // 也用于校验 index.md 每行格式
export function loadSkill(name: string): { meta: SkillMeta; body: string };
export function matchTriggeredSkills(files: string[], skills: SkillMeta[]): SkillMeta[];
export function validateSkillRequests(requested: string[], indexSkills: SkillMeta[], maxN: number): string[]; // 抛错或返回合法子集
```

**验收标准：**
- `index.md` 与实际 `skills/*.md` 的 front matter 一致性有单测校验（版本号、triggers 对得上）。
- `validateSkillRequests` 对不在枚举内的名字、或请求数超过 `central-limits.json` 的 `maxSkillRequestsPerRun` 均抛错（对应 L185）。
- `matchTriggeredSkills(['a.swift'], ...)` 命中 `swift-review`。

### Task 1.7：DeepSeek 客户端与专家运行器

**Files:**
- Create: `action/src/lib/deepseek-client.ts`
- Create: `action/src/lib/model-allowlist.ts`
- Create: `action/src/lib/expert-runner.ts`
- Create: `action/src/prompts/data-boundary.ts`（PR 内容的显式边界包装，见 L73）
- Test: 各自 `.test.ts`（均用 mock HTTP，不打真实 API）

`model-allowlist.ts`：`assertModelAllowed(modelName: string): void`，读取 `allowed-models.json`，不在名单内直接抛错（供 status-start 阶段快速失败，对应 L27"在 status-start 阶段快速失败"——**注意**：这意味着模型名校验实际发生在 status-start，而不是 analyze，需要在 Task 1.4 的 status-start 里补一步"读取 analyze 阶段将使用的模型名配置并调用 `assertModelAllowed`"，本任务需要回头在 1.4 补一条子任务）。

`deepseek-client.ts`：Anthropic 兼容 API 的最小封装，`sendStructuredRequest({ model, systemPrompt, userPrompt, jsonSchema }): Promise<unknown>`，内部做限流/暂时错误的带抖动指数退避（对应 L261），Schema/逻辑错误不重试。**不记录 Secret**：客户端从环境变量读取凭据，不出现在日志/artifact 里。

`expert-runner.ts`：对一个分片 + 一个专家（含动态装备的 skill 正文拼进 prompt）调用 `deepseek-client`，用 `schema-validator` 校验返回是否符合 `expert-output.schema.json`；返回长度超预期/`coverage_complete !== true`/等于 `maxItems` 均标记 `hardLimitHit: true` 并**建议调用方停止调度剩余分片**（对应 L110 最后一句）。

**验收标准：** mock 出一个"返回 30 条 findings 且 `coverage_complete:true`"的响应，单测断言 `hardLimitHit === true`（即使 `coverage_complete` 为 true 也不采信，对应 L110）。

### Task 1.8：确定性证据校验器

**Files:**
- Create: `action/src/lib/deterministic-evidence-validator.ts`
- Test: `action/src/lib/deterministic-evidence-validator.test.ts`

实现文档 L84-88、L116 中"可机械判定"的部分：
- 行号落在本次 diff 新增/修改 hunk 内（`side:RIGHT`）→ 通过。
- 落在未变更行，但**同文件内**符号在本次 PR 中被修改 → 通过（需要 context-resolver 提供的"符号是否被修改"信息，本任务定义最小可行的符号匹配——按行范围重叠简化处理，标注为可迭代点）。
- 仅因"文件被触碰但该行未变更也无新增调用路径" → 判不通过。
- **跨文件调用链声明**（`cross_file_causal_claim: true`）**不在这一步判定**，原样转交 verifier（L116 明确要求）。
- Schema/SHA/path/side/引用文本任一不匹配 → 判不通过，附具体原因。

**验收标准：** 针对文档 L84-88 每条规则各写一个 fixture 用例（新增行命中 / 未变更行但符号被改动命中 / 仅文件被触碰但代码未变判不通过 / 跨文件声明被转交而非本步骤判定）。

### Task 1.9：独立 verifier

**Files:**
- Create: `action/src/lib/verifier-client.ts`
- Test: `action/src/lib/verifier-client.test.ts`

对每个通过确定性校验（或被标记为待 verifier 复核的跨文件因果声明）的 candidate finding，发起独立 LLM 调用："主动寻找反例、遗漏条件和已有保护"（L117）；对 `cross_file_causal_claim: true` 的候选，要求 verifier 必须在给定上下文文件中找到 `causal_evidence_refs` 对应的真实调用点/引用，找不到判不通过（L117 最后一句"不允许仅凭专家自述的调用链直接过关"）。verifier 超时/API 失败/Schema 失败 → 整次审核标记为 `incomplete`（L122），这里只需要把该信号往上抛，不在本模块内决定最终 verdict。

**验收标准：** mock 一个 verifier 响应"未找到 causal_evidence_refs 对应引用" → 该候选判不通过；mock 一个 API 超时 → 抛出会被上层捕获为 `incomplete` 信号的特定错误类型。

### Task 1.10：主审/arbiter

**Files:**
- Create: `action/src/lib/arbiter.ts`
- Test: `action/src/lib/arbiter.test.ts`

去重、合并等价问题、剔除证据不足/被上下文反驳/与 PR 无关的候选（L118），只对已通过前两步验证的候选操作，**不新增未经验证的问题**（L120）。输出 `Finding[]`（符合 `finding.schema.json`，补上 `evidence_validation`/`verifier_conclusion` 字段）。

**验收标准：** 两个候选描述不同但指向同一 `path+line+category` → 合并为一条；一个候选被 verifier 判不通过 → 不出现在最终列表，也不出现在对外可见的任何 artifact（只保留在内部诊断 artifact，对应 L120 最后一句——需要单独一个 `internal-diagnostics` artifact 输出，本任务一并创建其 schema-less 内部结构）。

### Task 1.11：analyze entrypoint 整合 + 补充审核

**Files:**
- Create: `action/src/entrypoints/analyze.ts`
- Test: `action/src/entrypoints/analyze.test.ts`

整合 1.6-1.10：读取 prepare artifact → 按分片调度三个专家（预装通用 skill + 按文件后缀装备语言 skill）→ 收集 `skill_requests`，用 `validateSkillRequests` 校验后最多追加一轮定向专家（L124-126，补充审核产生的候选同样计入硬上限并过完整验证流水线）→ 逐候选跑确定性校验 → 跑 verifier → arbiter 汇总 → 产出最终 `Finding[]` + 更新后的 coverage-manifest（含 verifier/finding 数是否触达硬上限）。**命中任一硬上限时**：停止调度尚未开始的分片/补充审核（L110），整个 analyze 标记 `hardLimitHit`。**analyze 不持有 `contents:read`**，因此本入口内任何"读 GitHub"的代码路径都是禁止的——需要在代码 review 中显式检查这一条。

**验收标准：** 端到端 fixture（3 个分片、一次补充审核请求、一个跨文件因果声明、一个命中 maxItems 的分片）跑通，输出的 `verdict` 相关字段能反映"部分分片因硬上限未完成"。

### Task 1.12：裁决规则纯函数

**Files:**
- Create: `action/src/lib/verdict.ts`
- Test: `action/src/lib/verdict.test.ts`

```typescript
export function computeVerdict(input: {
  coverageManifest: CoverageManifest;
  finalFindings: Finding[];
  hardLimitHit: boolean;
  anyRequiredStageFailed: boolean;
}): { verdict: 'pass' | 'changes_requested' | 'incomplete'; incompleteReasons: string[] };
```

严格对应文档"裁决规则"一节（L140-153）的每条：`changes_requested` 需审核完整且 findings>0；`pass` 需所有必需阶段成功且 findings===0；否则 `incomplete`。**不在这里处理 `stale_cancelled`**（那是 publish/status-finalize 基于身份元组比对得出的，不属于本函数输入维度）。

**验收标准：** 覆盖文档给出的每一种组合的单测（含"命中硬上限即使 findings=0 也不能判 pass"）。

### Task 1.13：publish entrypoint（Phase 1 范围：诊断态，不写 GitHub）

**Files:**
- Create: `action/src/entrypoints/publish.ts`（后续 Phase 2/3 在此文件上增量扩展，Phase 1 只实现下面这部分）
- Test: `action/src/entrypoints/publish.test.ts`

Phase 1 的 `publish.ts` 职责：
1. 重新拉取身份元组，与 prepare 锁定值比对；不一致 → 产出 `verdict: 'stale_cancelled'`。
2. 调用 `computeVerdict` 得到裁决结果。
3. **不调用任何 `pull-requests:write`/`issues:write` API**（Phase 1 的 publish Job 权限声明里根本不请求这两个权限，代码里也不应引用相关 octokit 方法——留一个显式的 `// PHASE 1: no GitHub write calls here, see Phase 2 task list` 注释标记扩展点）。
4. 把 verdict + findings + coverage-manifest 摘要写入 `$GITHUB_STEP_SUMMARY`，并作为 artifact 上传（供人工在 shadow mode 下与真实审核结果比对）。
5. 输出符合 `verdict.schema.json` 的对象供 status-finalize 消费。

**验收标准：** 单测断言该模块在 Phase 1 阶段完全不引用 `octokit.rest.pulls.createReview`/`issues.createComment` 等写入方法（可以用简单的静态检查：grep 该文件源码确认没有这些方法名，作为一个"锁"，防止在 Phase 1 提前实现 Phase 2/3 的内容）。

### Task 1.14：status-finalize entrypoint

**Files:**
- Create: `action/src/entrypoints/status-finalize.ts`
- Test: `action/src/entrypoints/status-finalize.test.ts`

读取 publish 产出的 verdict 摘要（或更早阶段的失败信号）→ 映射到 Check Run 终态：
- 无 verdict 摘要（说明 prepare/analyze 提前失败）→ `action_required` 或 `timed_out`（区分：超时用 `timed_out`，其他失败用 `action_required`）。
- `verdict.verdict === 'pass'` → `conclusion=success`。
- `verdict.verdict === 'changes_requested'` → `conclusion=failure`。
- `verdict.verdict === 'incomplete'` → `conclusion=action_required`。
- `verdict.verdict === 'stale_cancelled'` → `conclusion=cancelled`。

用 `check-run.ts` 的 `patchCheckConclusion`。**这是唯一写终态的地方**（L57 publish 自身不写 Check）。

**验收标准：** 覆盖 L234-241 六种状态映射的单测；覆盖"上游阶段异常退出、没有任何 verdict 摘要"时仍能写出确定的终态（不会挂起）。

### Task 1.15：watchdog entrypoint（Phase 1 范围：Check 清理，摘要评论回填部分 stub）

**Files:**
- Create: `action/src/entrypoints/watchdog.ts`
- Test: `action/src/entrypoints/watchdog.test.ts`

实现文档 L247-253：
1. `GET /repos/{owner}/{repo}/pulls?state=open`（分页）。
2. 对每个 PR，`GET /repos/{owner}/{repo}/pulls/{pr}/commits`（命中 250 条上限时记录 `commitHistoryTruncated` 标记，用于后续在摘要评论里追加降级说明——Phase 1 阶段该说明只写入 job summary，因为固定摘要评论模块要到 Phase 2 才存在）。
3. 逐 commit 查 `check-runs`，筛出本机器人、`in_progress`、超过 `watchdogStaleThresholdMinutes` 的候选。
4. 强一致性核验：`GET /repos/{owner}/{repo}/actions/runs/{run_id}`，`status` 仍为 `queued`/`in_progress` → 跳过；`completed` → 继续。
5. **Phase 1 简化**：由于 Phase 1 从不发布真正的 `REQUEST_CHANGES`/`APPROVE` Review，跳过"核实是否已有合法最终 Review"这一步（永远视为真正孤儿），直接终结为 `timed_out`。**必须在代码里用注释明确标出这是 Phase 1 的临时简化**，并在 Phase 3 Task 3.3 里补全"核实已发布 Review 后回填"的逻辑（对应 L251，这部分逻辑在 Phase 1 提前写出接口占位 `checkForPublishedFinalReview(): Promise<'REQUEST_CHANGES' | 'APPROVE' | null>`，Phase 1 内实现为固定返回 `null`，Phase 3 再替换为真实实现）。
6. 大仓库的扫描上限/轮转（L253 最后一句），本任务实现为"每次运行最多处理 `central-limits.json` 里新增的 `maxPrsPerWatchdogRun`（默认 50）个最近更新的 open PR"。

**验收标准：**
- run 仍 `in_progress` → 不终结 Check（覆盖 L250 的核心验收点：不会误杀正在正常执行的大 PR 审核）。
- run 已 `completed` 且 Check 仍 `in_progress` → 终结为 `timed_out`。
- commit 历史达 250 条上限 → 标记 `commitHistoryTruncated`。

### Task 1.16：两个 reusable workflow 文件

**Files:**
- Create: `.github/workflows/reusable-pr-review.yml`
- Create: `.github/workflows/reusable-pr-review-watchdog.yml`

`reusable-pr-review.yml` 骨架（`on: workflow_call`，Phase 1 阶段 `publish` Job 只声明 `contents: read`，不声明 `pull-requests: write`/`issues: write`，与 Task 1.13 的代码范围保持一致；Phase 2 会在这里追加权限）：

```yaml
name: PR Review Swarm (reusable)
on:
  workflow_call:
    inputs:
      pr_number:
        required: true
        type: number
    secrets:
      DEEPSEEK_API_KEY:
        required: true

concurrency:
  group: pr-review-swarm-${{ github.repository }}-${{ inputs.pr_number }}
  cancel-in-progress: true

jobs:
  status-start:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      checks: write
    outputs:
      identity_tuple: ${{ steps.run.outputs.identity_tuple }}
    steps:
      - uses: <org>/pr-review-swarm@<pinned-sha>
        id: run
        with:
          entrypoint: status-start

  prepare:
    needs: status-start
    if: needs.status-start.outputs.gate_passed == 'true'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      prepare_artifact: ${{ steps.run.outputs.prepare_artifact }}
    steps:
      - uses: <org>/pr-review-swarm@<pinned-sha>
        id: run
        with:
          entrypoint: prepare

  analyze:
    needs: prepare
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: <org>/pr-review-swarm@<pinned-sha>
        id: run
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          entrypoint: analyze

  publish:
    needs: analyze
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Phase 2 起追加: pull-requests: write, issues: write
    steps:
      - uses: <org>/pr-review-swarm@<pinned-sha>
        id: run
        with:
          entrypoint: publish

  status-finalize:
    needs: [status-start, publish]
    if: always()
    runs-on: ubuntu-latest
    permissions:
      checks: write
    steps:
      - uses: <org>/pr-review-swarm@<pinned-sha>
        with:
          entrypoint: status-finalize
```

（`gate_passed` 之类的 job output 传递细节属于实现期打磨项，此处给出的是 Job/权限骨架，实际字段名以 status-start 的真实输出为准。）

`reusable-pr-review-watchdog.yml`：单一 Job，`permissions: { pull-requests: read, issues: write, checks: write, actions: read }`，`uses: <org>/pr-review-swarm@<pinned-sha>` + `entrypoint: watchdog`。

**Files（目标仓库监听器示例，更新 README）：**
- Modify: `README.md` — 在现有监听器 YAML 示例基础上，补一份 `pr-review-watchdog.yml` 示例（`on: schedule: cron: '*/10 * * * *'` + `workflow_dispatch` 便于手动触发排障）。

**验收标准：** `actionlint` 通过；CI 的 forbidden-ref 扫描通过（两个文件都不出现 PR head ref）；`concurrency.group` 包含 repo+PR 编号；`analyze` Job 的 `permissions: {}` 精确匹配文档 L56。

### Task 1.17：benchmarks 骨架

**Files:**
- Create: `benchmarks/cases/swift-retain-cycle/diff.patch`
- Create: `benchmarks/cases/swift-retain-cycle/pr-description.md`
- Create: `benchmarks/cases/swift-retain-cycle/expected-findings.json`
- Create: `benchmarks/cases/go-missing-error-check/diff.patch`
- Create: `benchmarks/cases/go-missing-error-check/expected-findings.json`
- Create: `benchmarks/cases/historical-issue-not-introduced/diff.patch`
- Create: `benchmarks/cases/historical-issue-not-introduced/expected-findings.json`（`must_find:false` 用例，验证"仅因文件被触碰但代码未改"不产生 finding，对应 L88）
- Create: `benchmarks/run-evaluation.js`
- Create: `schemas/expected-findings.schema.json`

`expected-findings.json` 格式按文档 L285：`{ path, line, category, must_find: true|false }[]`。

`run-evaluation.js`：对每个 `cases/*` 目录，跑一遍 analyze 流水线（Phase 1 阶段可以直接调用 `action/dist` 导出的内部函数，或者先跑最小可行版本——只对比 `expected-findings.json` 与 arbiter 输出的 `Finding[]`），计算召回率（`must_find:true` 命中比例）、误报数（未在 `expected-findings.json` 出现却被报告的数量）、`incomplete` 比例，输出汇总表。

**验收标准：** 至少 3 个用例可跑通并输出汇总指标；`must_find:false` 用例在正常流程下不产生对应 finding（哪怕专家 LLM 输出了候选,也应被确定性因果规则或 verifier 挡掉——这是回归测试的核心价值）。

### Task 1.18：Phase 1 退出检查清单

**代码侧验收标准（可自动化）：**
1. Task 0.1-1.17 全部单测/CI 通过。
2. 在一个测试用 GitHub 仓库上手动触发一次 `synchronize` 事件，确认：出现 `in_progress` → 终态 Check；PR 上**没有**任何评论/Review；job summary 或 artifact 里能看到裁决结果与 findings 列表。
3. 手动制造一次"信任门控拒绝"场景（fork 仓库外部贡献者 PR，未加入白名单），确认 Check 直接落到 `action_required`，且能通过 `workflow_dispatch` 重跑放行。
4. 手动制造一次"analyze 命中 maxItems"场景（对某个专家用一个会产出很多候选的超大 diff），确认整体判 `incomplete`，而不是静默截断。

**人工/业务侧检查项（非本计划代填）：**
5. 在真实或沙盒仓库上以 shadow mode 运行一段时间，与人工审核结果对比，达到您认可的召回率/误报上限（对应待确认项 H）——**这是进入 Phase 2 的准入条件，不是一个可以被单测替代的代码验收标准**。

---

## Phase 2：Comment-only

### Task 2.1：固定摘要评论模块

**Files:**
- Create: `action/src/lib/summary-comment.ts`
- Test: `action/src/lib/summary-comment.test.ts`

实现文档 L220-227 的双层 marker：稳定身份 marker（`repo/pr/bot/summary`）用于查找/创建/更新；可变结果 marker（`head_sha/base_sha/engine_revision/policy_revision/model/schema_version/verdict/review_set_id`）编码进评论正文的隐藏区块。`upsertSummaryComment(octokit, ...)`：先按稳定 marker 搜索（`GET /repos/{owner}/{repo}/issues/{pr}/comments`，客户端过滤），存在则 `PATCH`，不存在则 `POST`。

### Task 2.2：review_set_id 与批量发布 manifest

**Files:**
- Create: `action/src/lib/review-set-id.ts`（身份元组 + engine/policy/model/schema 版本 + 最终 findings 集合内容摘要 → 派生 ID，L196）
- Create: `action/src/lib/publish-manifest.ts`（`batch_index`/`batch_count`/`findings_digest`，容量估算与分批算法）
- Create: `action/src/lib/hidden-marker.ts`（Review body 隐藏 HTML 注释的编解码，格式见 L207）
- Test: 各自 `.test.ts`

### Task 2.3：Review/评论发布 + 对账（仅 COMMENT 事件）

**Files:**
- Modify: `action/src/entrypoints/publish.ts`（在 Phase 1 的诊断逻辑基础上新增真实写入路径）
- Test: `action/src/entrypoints/publish.test.ts`（追加用例）

实现 L200-215：批量策略、按 `review_set_id`+`batch_index` 对账已发布批次、旧 `review_set_id` 收尾（dismiss 或降级为编辑正文追加取代说明，含 403 降级路径 L211）。**Phase 2 硬约束**：无论裁决结果是什么，最终一批一律用 `event: 'COMMENT'` 提交，**代码里不出现 `REQUEST_CHANGES`/`APPROVE` 字面量的分支**（该分支到 Phase 3 才添加，Phase 2 阶段这是一个显式限制而非临时开关）。

**Files（权限声明更新）：**
- Modify: `.github/workflows/reusable-pr-review.yml`（`publish` Job 追加 `pull-requests: write`、`issues: write`）

**验收标准：**
- 单测覆盖"单次容量不足需分批"路径，末批和中间批的 `event` 均为 `COMMENT`。
- 单测覆盖"重试时按 `findings_digest` 对账，一致则跳过，不一致则 incomplete"（L204）。
- 单测覆盖旧 `review_set_id` 存在中间批次未完成的情况被追加取代说明（L212）。
- 单测覆盖 dismiss 403 → 降级为编辑正文（L211）。
- 集成测试：真实沙盒仓库上验证 PR 收到评论/inline comment，但审核状态（绿色/红色叉）不受影响。

---

## Phase 3：启用 REQUEST_CHANGES/APPROVE

> **状态：已完成（2026-07-22）。** Task 3.1-3.4 全部落地，TDD 流程 + 沙盒仓库端到端验证（`dustPyrotechnic/pr-review-swarm` PR #5/#6）。详细清单见 `action/test/integration/CHECKLIST.md`。Task 3.4 审计过程中发现并修复一个 Phase 2 遗留缺口：`supersedeOldReviewSets` 此前从未真正调用 `dismissReview`，一律走编辑 body 路径；已按设计文档 L211 补齐"先 dismiss、403 时降级编辑"的分支。另发现一个与本阶段无关的既有问题：analyze 阶段对纯文档 diff 会偶发 `any_required_stage_failed`（详见 CHECKLIST.md"已知问题"），留待后续单独排查。

### Task 3.1：真实裁决事件

**Files:**
- Modify: `action/src/entrypoints/publish.ts`

新增分支：`verdict.verdict === 'pass'` → 最终批次 `event: 'APPROVE'` 并在摘要评论 @ 配置的负责人（默认 `dustPyrotechnic`，读取 repo-config 的覆盖值，本任务需要在 `repo-config.schema.json` 追加 `default_mention` 字段——已在 Task 1.1 预留）；`verdict.verdict === 'changes_requested'` → `REQUEST_CHANGES`；`verdict.verdict === 'incomplete'` 且存在已验证 finding → `REQUEST_CHANGES` + 醒目横幅（L154 的固定模板）；`incomplete` 且无 finding → 只更新摘要评论，不提交 Review；`stale_cancelled` → 不发布任何内容。

### Task 3.2：incomplete 横幅模板

**Files:**
- Create: `action/src/lib/incomplete-banner.ts`

固定模板插入 Review body 与摘要评论顶部（"⚠️ 本次审核未完整覆盖..."），列出具体未完成阶段/范围（来自 `verdict.incompleteReasons`）。

### Task 3.3：watchdog 完整回填逻辑

**Files:**
- Modify: `action/src/entrypoints/watchdog.ts`

把 Task 1.15 里的 `checkForPublishedFinalReview` 占位替换为真实实现：解析该 head_sha 上的 `pulls/{pr}/reviews`，找带有效隐藏 marker 的最终批次 Review，存在则回填 Check 为对应结论而不是 `timed_out`（L251）。

### Task 3.4：完整安全与集成测试清单

**Files:**
- Create: `action/test/integration/`（跑在真实或高保真 mock 的沙盒仓库上的集成测试集）

逐条对应设计文档"测试与验收 → 安全与集成测试"一节（L291-318）实现自动化或半自动化验证，包括但不限于：
- fork PR 无法修改 workflow/action/skills/裁决规则、无法获取写凭据/DeepSeek Secret。
- prompt injection、恶意文件名、非法 JSON、越界路径、伪造行号/证据不能进入 publish。
- `REQUEST_CHANGES → 新 commit → APPROVE` 完整生命周期。
- 旧身份元组延迟结果不覆盖新结果。
- PR 关闭/转草稿/身份元组变化时不发布内容，Check 落 `cancelled`。
- 各 Check 终态与后继运行对账。
- `review_set_id`/`findings_digest` 相关的重跑/去重场景。
- watchdog 与 status-finalize 之间无清理空隙。

**验收标准：** 本任务清单本身就是验收标准来源——每一条设计文档 L291-318 的验证项都要能在测试报告里找到对应的一条通过记录，缺失的需要显式列出原因（不能默默跳过）。

---

## Phase 4：Required Check（主要为运维操作）

### Task 4.1：长期可靠性观察

在真实仓库上以 Phase 3 配置运行至少一段您认可的观察期，确认 watchdog 没有误杀正常运行、Check 终态始终能收敛（不会永久卡在 `in_progress`）。

### Task 4.2：分支保护配置（人工操作，不通过代码 PR 完成）

在目标仓库的 ruleset / branch protection 设置里把 `PR Review Swarm / verdict` 设为 required check，并确认仓库所有者保留人工 bypass 能力（L255、L325）。**这是 GitHub 仓库设置层面的操作，需要您本人在 GitHub UI 或用有相应权限的 API 调用完成**，本计划不会代为执行这类仓库配置变更。

### Task 4.3：最终验收

对照设计文档"测试与验收"整节，确认 Phase 1-3 建立的自动化测试仍然全部通过，且 Task 3.4 的集成测试清单在 required 模式下重新跑过一遍（尤其是 bypass 能力、watchdog 兜底两项，required 模式下后果更严重，值得重新确认）。

---

## 附加组件：一键部署 CLI（`deploy` 命令）

**这不是设计文档原有条款，是您在实施过程中新提出的需求**：在目标仓库根目录跑一条终端命令、填入 DeepSeek API key，即完成部署。以下是把这个需求转成的具体任务；因为它只是往目标仓库写文件/设置 secret 的脚手架工具，不参与审核链路的信任决策，所以**不影响** Phase 0-4 已确认的安全架构，可以独立于四个上线门槛并行推进（建议在 Phase 1 的两份 reusable workflow 文件落地后开始，这样 CLI 一开始就能 pin 住一个真实存在的 commit SHA）。

**命令形态**（不发布到 npm registry，直接用 `npx github:` 语法引用中央仓库自身，延续"pin 住 commit SHA"的一贯做法）：
```bash
npx github:<org>/pr-review-swarm#<pinned-tag> deploy --deepseek-key=sk-xxxx
```
不传 `--deepseek-key` 时走交互式遮罩输入，也可用 `DEEPSEEK_API_KEY` 环境变量传入；任何情况下都不在终端输出/日志里回显 key 内容。

**默认行为选择（已替您做出，如需更改请告知）：**
- 落地方式默认是"新建分支 + `gh pr create` 开 PR"，不直接 push 到默认分支——添加一个引用外部 pinned SHA 的 workflow、以及一个新 secret，值得给您一个确认的窗口。提供 `--direct-push` 跳过 PR、直接提交到当前分支，供追求"零确认、一条命令跑通"的场景使用。
- 不发布 npm 包，用 `npx github:owner/repo#tag` 直接从源码运行，省去注册包名、维护发布流水线的额外决定。

### Task C.1：CLI 项目脚手架

**Files:**
- Create: `cli/package.json`（`bin` 字段指向 `src/index.mjs`，依赖交互式输入库如 `@inquirer/prompts`，不需要打包成 dist——CLI 不是安全边界内组件，`npx github:` 拉取时允许 `npm install`）
- Create: `cli/src/index.mjs`（解析子命令，目前只有 `deploy`）
- Create: `cli/VERSION`（记录当前建议 pin 的中央仓库 commit SHA，随中央仓库每次发布更新）

**验收标准：** `npx github:<本地测试路径或临时仓库>#<tag> deploy --help` 能跑出帮助文本。

### Task C.2：仓库探测与前置检查

**Files:**
- Create: `cli/src/lib/detect-repo.mjs`（解析 `git remote get-url origin` 得到 `owner/repo`；不是 git repo 或没有 GitHub remote 时给出明确报错）
- Create: `cli/src/lib/check-gh-cli.mjs`（`gh auth status` 检查已安装且已登录，未满足时提示先 `gh auth login`）
- Test: `cli/src/lib/detect-repo.test.mjs`、`check-gh-cli.test.mjs`

### Task C.3：写入监听器 workflow 文件

**Files:**
- Create: `cli/src/lib/write-workflows.mjs`

从 `cli/VERSION` 读取 pinned SHA，渲染写入目标仓库的 `.github/workflows/pr-review.yml` 与 `pr-review-watchdog.yml`（内容对应 README 里的监听器示例 + Phase 1 Task 1.16 的 watchdog 版本）。若目标路径已存在同名文件，默认**不覆盖**、报错退出并提示 `--force`，避免悄悄覆盖用户已有的自定义配置。

**验收标准：** 干净目录下运行生成两个文件，内容包含正确的 `owner/repo` pinned 引用；已存在同名文件时默认报错，`--force` 后允许覆盖并在输出里明确提示"已覆盖"。

### Task C.4：写入默认仓库配置

**Files:**
- Modify: `cli/src/lib/write-workflows.mjs`（或拆出 `write-repo-config.mjs`）

写入 `.github/pr-review-swarm.yml` 默认模板（`enabled: true`，其余字段留空或注释说明用途，对应 `schemas/repo-config.schema.json`），已存在则不覆盖。

### Task C.5：设置 DeepSeek Secret

**Files:**
- Create: `cli/src/lib/set-secret.mjs`

调用 `gh secret set DEEPSEEK_API_KEY --repo <owner>/<repo>`，key 来源按 `--deepseek-key` flag → `DEEPSEEK_API_KEY` 环境变量 → 交互式遮罩输入的优先级获取；**不写入任何日志、临时文件或终端回显**。

**验收标准：** 单测里用一个假的 `gh` 可执行文件（stub）验证调用参数正确，且 key 值不出现在任何 `console.log`/断言之外的输出里。

### Task C.6：仓库 Actions 权限检查

**Files:**
- Create: `cli/src/lib/check-actions-permissions.mjs`

调用 `gh api repos/{owner}/{repo}/actions/permissions` 确认允许 Actions 创建/批准 PR（对应设计文档 L69 的前提）；不满足时只打印需要去哪个 GitHub 设置页手动开启，**不代为修改**（这是权限扩大操作，CLI 不越权）。

### Task C.7：分支 + PR / 直接推送

**Files:**
- Create: `cli/src/lib/deploy-changes.mjs`

默认：新建分支 `pr-review-swarm/deploy`，`git add`/`commit` 新文件，`gh pr create` 打开 PR 并打印链接。`--direct-push`：跳过分支/PR，直接 commit + push 到当前分支，输出里加醒目提示"已直接推送到当前分支，未经 PR review"。

### Task C.8：收尾输出

**Files:**
- Modify: `cli/src/index.mjs`

汇总打印：workflow 文件已写入、secret 已设置、PR 链接（或直接推送确认）、Actions 权限检查结果、下一步人工操作清单（合并 PR；之后按 Phase 1-4 的验收标准逐步推进到 required check）。

**Task C.1-C.8 整体验收标准：** 在一个干净的测试用 GitHub 仓库根目录下，只执行一条 `npx github:... deploy --deepseek-key=...` 命令，运行结束后能看到一个包含两份 workflow 文件 + 默认配置文件的 PR，且该仓库的 `DEEPSEEK_API_KEY` secret 已被设置——全程不需要手动编辑任何 YAML。

---

## 关于"待确认"项的处理方式

本计划对 A-H 八项标注了默认提案。如果您认可这些默认值，我会按当前顺序从 Phase 0 / Task 0.1 开始实现（遵循 test-driven-development skill，每个 Task 从失败测试写起）。如果某几项您想现在就拍板（尤其是 D 项 DeepSeek 模型 ID、H 项召回率/误报数值），也可以先告诉我,我会把计划里的占位替换掉再开工。
