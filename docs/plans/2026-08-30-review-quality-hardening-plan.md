# 审阅质量与可靠性加固 实施计划

> **For Claude:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 逐任务实施本计划。
> 动 `.github/workflows/`、`action/action.yml`、Job `permissions`、Secret 边界之前，**必须先完整读完 [`docs/AGENTS.md`](../AGENTS.md) 的 9 条硬禁令**。不要为了让测试变绿而放宽被测的安全属性。
>
> **修订记录**：v1 经子 Agent 审阅发现 5 处阻断问题（自带测试与自带实现互相打架 ×2、漏调用点、根因定位错文件、未声明的规格变更）与 11 处需修正项，本文是修订后的 v2。审阅结论与逐条核对见文末「审阅遗留」。

**Goal:** 消除 [`docs/field-reports/2026-08-30-ios-source-learning-pr9.md`](../field-reports/2026-08-30-ios-source-learning-pr9.md) 实测出的 12 类缺陷中可确定性修复的部分，使一次审核「不发自我否定的 finding、不因单个模型格式抖动整轮报废、不在已合并 PR 上发 REQUEST_CHANGES、不无限堆叠横幅」。

**Architecture:** 全部改动落在三层。① **确定性门禁层**（arbiter 前新增 self-refutation gate、收紧 deterministic validator）——不依赖模型，是本计划的主承重墙。② **可靠性层**（本地补齐模型漏填字段、verifier 补重试、单 agent 失败不再中断整轮、采样温度置 0）。③ **发布层**（verdict→review event 降级、supersede 横幅覆盖式与分页、已关闭 PR 短路）。提示词只做补强，不作为任何缺陷的唯一防线。

**Tech Stack:** TypeScript（ES2022）+ vitest（`action/`）、JSON Schema draft-07（`schemas/`）、GitHub Actions（`.github/workflows/`）、`.mjs` + vitest（`benchmarks/`、`cli/`）。

---

## 根因分析（每条都指到行）

下表是「现象 → 代码位置 → 为什么会这样」。P 编号沿用实测报告。

| # | 现象 | 根因位置 | 根因 |
|---|---|---|---|
| P1 | 12/62 finding 正文自称「不构成缺陷」仍发布 | `action/src/lib/arbiter.ts:66-90` | arbiter 只看 `deterministicStatus` 和 `verifierConclusion.status` 两个布尔量，**从不读 finding 正文**。`suggestion` 在 `schemas/candidate-finding.schema.json:24` 只要求 `minLength: 1`，字符串「无。」完全合法。verifier（`verifier-client.ts:26-32`）被要求判断「finding 是否成立」，而一个正文写满否定推理的 finding 在字面上仍「描述属实」，模型给 `confirmed` 并不违背它收到的指令。**整条链路没有任何一处问「这条 finding 要求对方做什么」**。 |
| P2 | 标题里出现 `predictable? no,` / `However…` 等推理草稿 | `schemas/candidate-finding.schema.json:21` | `title` 只有 `minLength: 1`，无长度上限；`expert-runner.ts:110-119` 的 system prompt 也没有任何标题契约。模型把 title 当自由文本，自然会把思考过程写进去。 |
| P3 | 5 条 high 里 3 条自我否定、1 条是设计取舍 | `expert-runner.ts` + `arbiter.ts` | `severity` 由模型单次生成，**没有任何回写或一致性校验**。自我否定的那 3 条由 Task 1 覆盖；「设计取舍被标 high」那条见「不在本计划内的」。 |
| P4 | 同一位置跨轮给相反结论 | 无状态设计 | 每轮 `review_set_id` 独立，不读取上一轮结论。这是刻意设计（避免锚定偏差），叠加 P10 的高温采样后表现为「翻烧饼」。**本计划不改无状态设计**，只改 P10。 |
| P5 | 中英文混用，同一轮内也混 | `expert-runner.ts:110-119`、`verifier-client.ts:26-32` | 两处 system prompt 都没有输出语言契约。 |
| P6 | 5/17 轮 incomplete，根因全是模型输出不合 schema | 三处 | (a) `source_agent` 在 `candidate-finding.schema.json` 是必填，但它的值 = `runExpert` 自己传进去的 `input.agentName`——**让模型回填一个调用方已知的常量，纯属自造失败面**；(b) `central-limits.json:17` 的 `maxExpertSchemaRetries: 1`；(c) `verifier-client.ts:34-60` **完全没有重试**，`sendStructuredRequest` 或 schema 校验任一失败直接 `VerifierUnavailableError`，而 expert 侧同样的失败模式有 `withRetry` 兜底。两侧策略不一致，不是政策，是遗漏。 |
| P6' | incomplete 轮次 findings 明显偏少（1/1/2） | `analyze.ts:182-191` | 任一 agent 抛错就 `break outer`，**剩余全部 shard × agent 一个不跑**。一次格式抖动＝整轮审核报废。 |
| P7 | incomplete + 全 low 仍发 REQUEST_CHANGES | `verdict.ts:45-52` | `computeFinalReviewEvent` 只看 `verdict` 和 `finalFindingsCount`，`incomplete` 分支写死 `count > 0 → REQUEST_CHANGES`，**不看严重度**。这是设计文档 L152 的既定规格，本计划要改它（见 Task 6）。 |
| P8 | 62 条评论累计 341 行横幅，单条最多 17 行 | `publish.ts:271-288` + `publish.ts:239` | 两处拼接（`:276`、`:286`）都是 `notice + 旧 body`，**无条件前缀**，从不检测已有横幅；`staleReviews`（`:229-235`）每轮把前 N-1 轮的评论全重写一遍 —— 横幅 O(N) 堆叠、API O(N²)。**另有一个独立缺陷**：`:239` 的 `listReviewComments` 既没 `per_page` 也没 `.paginate`，GitHub 默认只返回 30 条，实测的 62 条评论里第 31 条之后**从来没被处理过**。 |
| P9 | PR 合并后仍触发并发 REQUEST_CHANGES | `cli/src/lib/write-workflows.mjs:20` + `status-start.ts:36-111` | **第一触发源是本项目自己的部署模板**：`pr-agent deploy` 写进使用方仓库的 `pull_request_target` 监听 `[…, edited, converted_to_draft, closed]`，`closed` 就在里面。第二道缺口在 action 内：整个 gate 只查 `repoConfig.enabled` 和 `evaluateTrustGate`，**从不看 PR 的 `state` / `merged`**，而 `identity-tuple.ts:20` 已经调了 `pulls.get`，数据在手里没用。 |
| P10 | 同一 head_sha 两次审核 findings 交集为 0 | `deepseek-client.ts:147-167` | 请求体里**没有 `temperature`**，走 DeepSeek 默认值（`deepseek-chat` 默认 1.0）。抽取类任务用默认温度采样，run-to-run 方差就是这么来的。 |
| P11 | 评论挂错文件（正文分析 `progress.sh`，锚在 `bootstrap.sh:210`） | `deterministic-evidence-validator.ts:33-35` | `cross_file_causal_claim === true` **在任何锚点检查之前就直接 return `deferred_to_verifier`**，path / side / 行号落点全部跳过。这是一条绕过确定性锚点校验的后门：模型只要声明「这是跨文件因果」，锚点就不再被校验。 |
| P12 | 59.7% 是 low，18 轮不收敛 | 无严重度预算 | 没有任何「每轮最多发几条 low」策略。P1 + P10 修完后噪声量会显著下降，剩余部分留待实测再定。 |

### 不在本计划内的（连同理由）

- **P4 的无状态设计**：跨轮记忆会引入锚定偏差，且需要持久化状态。先修 P10 看方差降到多少，再决定要不要做。
- **P11 的「正文谈 A 文件、锚点在 B 文件」识别**：可靠做法需要解析 evidence 里的文件名并与 `causal_evidence_refs` 交叉验证，任何正则启发式都会误伤合法的跨文件描述。本计划只堵死 Task 10 那条确定性后门。
- **P3 里「设计取舍被标 high」那一类**（实测第 15 轮 `bootstrap.sh:203`，把本 PR 的既定意图当缺陷报）：判断「这是缺陷还是取舍」没有任何确定性信号，只能靠模型。Task 9 的 severity 契约是唯一手段，做不到根治。
- **P12 的 low 预算**：数量策略应当由数据决定。等 Task 1 + Task 5 落地后重跑全量评测，看 low 占比降到多少再定阈值。

---

## 任务顺序

**建议先做 Task 2 和 Task 10**——这两个改动面最小、与既有规格无冲突，可以先把回归链路跑通建立信心。其余按编号顺序：

确定性门禁（1）→ 可靠性（2-5）→ 发布层（6-8）→ 提示词（9）→ 收紧（10）→ 文档（11）→ 评测（12）→ 发布（13）。

Task 1-10 相互独立、可单独回滚；Task 11-13 依赖前面全部。**Task 6 涉及规格变更，用户已明确同意**（见该任务开头）。

**每个任务一次 commit**；凡是改了 `action/src/` 的 commit，必须先 `cd action && npm run build` 并把 `dist/` 一并提交（CI 的 `build-dist-no-drift` 会挡漂移）。

---

### Task 1: 自我否定 finding 的确定性门禁（P1）

本计划性价比最高的一项：消掉 19.4% 的噪声和 3/5 的假 high，且完全不依赖模型。

**这道门误杀的代价比漏杀大得多**：`arbitrate` 的输出直接喂 `computeVerdict`，全部被误杀就变成 `pass` + COMMENT，等于「审完说没问题」。所以两条规则都必须窄。

**Files:**
- Create: `action/src/lib/self-refutation-gate.ts`
- Create: `action/src/lib/self-refutation-gate.test.ts`
- Modify: `action/src/lib/arbiter.ts`（`InternalDiagnosticOutcome` 联合类型、`arbitrate` 主循环）
- Modify: `action/src/lib/arbiter.test.ts`

**Step 1: 写失败测试**

新建 `action/src/lib/self-refutation-gate.test.ts`。**正例全部取自实测数据，反例里必须包含那条真阳性**——v1 的词表会把它误杀，这条测试就是防线：

```typescript
import { describe, it, expect } from 'vitest';
import { isSelfRefuting } from './self-refutation-gate.js';

const base = {
  id: 'f1', path: 'progress.sh', line: 10, side: 'RIGHT' as const,
  severity: 'high' as const, confidence: 'high' as const,
  category: 'correctness', title: 't', evidence: 'e', impact: 'i',
  suggestion: 's', introduced_by_pr: true, source_agent: 'generic-correctness',
};

describe('isSelfRefuting', () => {
  // 规则 1：suggestion 是空操作。取自第 13 轮 bootstrap.sh:210（标 [high]）
  it.each(['无', '无。', '无需修改', '无需修改。', '无需改动', '无问题', '不适用', 'None', 'none.', 'N/A', 'n/a'])(
    'rejects no-op suggestion %s',
    (suggestion) => {
      expect(isSelfRefuting({ ...base, suggestion })).toBe(true);
    },
  );

  // 规则 2：末句是否定式结论。取自第 15 轮 progress.sh:253
  it('rejects a finding whose evidence concludes there is no defect', () => {
    expect(
      isSelfRefuting({
        ...base,
        evidence: 'PIPESTATUS[0] 在 printf 前仍是 git 的真实退出码，OK。综合无实际缺陷。',
        suggestion: '保持现状即可',
      }),
    ).toBe(true);
  });

  it('rejects when the impact field carries the negation', () => {
    expect(
      isSelfRefuting({ ...base, impact: '两个调用点都在控制结构中，退出码被正确处理。不构成缺陷。' }),
    ).toBe(true);
  });

  // ↓↓↓ 反例。这三条全是 v1 词表会误杀的，必须全部为 false ↓↓↓

  // 实测里**唯一站得住的那条 high**（第 13 轮 update-sources.sh:104）的自然写法。
  // 误杀它 = 这道门把真缺陷吃掉了。
  it('keeps a real defect stated as a concessive clause', () => {
    expect(
      isSelfRefuting({
        ...base,
        evidence: '计数逻辑正确，但 dry-run 分支 fetched=1; break 后漏了 FETCH_DONE 自增',
        impact: '进度条恒定偏低',
        suggestion: 'dry-run 分支中也 FETCH_DONE=$((FETCH_DONE + 1))',
      }),
    ).toBe(false);
  });

  it('keeps a finding whose negation is a rejected first impression', () => {
    expect(
      isSelfRefuting({
        ...base,
        evidence: '乍看无问题，但 total=0 时整数除法会抛错',
        suggestion: '除法前判 total > 0',
      }),
    ).toBe(false);
  });

  it('keeps a finding that concedes one point while asking for another change', () => {
    expect(
      isSelfRefuting({
        ...base,
        evidence: '这里无需修改命名，但边界判断必须补',
        suggestion: '补 total > 0 的判断',
      }),
    ).toBe(false);
  });
});
```

**Step 2: 跑测试确认失败**

```bash
cd action && npx vitest run src/lib/self-refutation-gate.test.ts
```
预期：FAIL，`Failed to resolve import "./self-refutation-gate.js"`。

**Step 3: 写实现**

新建 `action/src/lib/self-refutation-gate.ts`。规则 2 **按句子切分、并对转折句免疫**——v1 用「尾部 40 字符窗口」是错的：短正文整串都在窗口内，让步从句的前半句会命中。

```typescript
import type { CandidateFinding } from './expert-runner.js';

/**
 * 丢弃「模型自己论证了不构成缺陷、却仍然作为 finding 交上来」的候选。
 *
 * 依据 ios-source-learning#9 实测：62 条 inline finding 里 12 条（19.4%）
 * 属于这一类，其中 3 条被标成 [high] 并直接驱动了 REQUEST_CHANGES。典型样本
 * 的 suggestion 字段就是字符串「无。」，正文末尾写着「不构成缺陷。」。
 *
 * 放在 arbiter 里而不是 prompt 里，是因为 prompt 已经被证明拦不住它：模型给出
 * severity 之后再写正文，写完否定结论也不会回头改 severity。这里做的是一次
 * 确定性的事后核对——「这条 finding 到底要求对方做什么」。
 *
 * 刻意保守，宁可漏杀不可误杀：这道门的输出直接决定 verdict，误杀到底就变成
 * 「审完说没问题」。
 */

// 规则 1：suggestion 是空操作。归一化后**全等**匹配，不做包含匹配——
// 「无需改动这一处的命名，但要修边界判断」包含「无需改动」，却是真建议。
const NO_OP_SUGGESTIONS = new Set([
  '无', '无。', 'none', 'none.', 'n/a', 'na', '不适用', '不适用。',
  '无需修改', '无需修改。', '无需改动', '无需改动。', '无需变更', '无需变更。',
  '无问题', '无问题。', '不需要修改', '不需要修改。', 'no change needed',
  'no change needed.', 'no changes needed', 'no changes needed.',
  'nothing to change', 'nothing to change.',
]);

// 规则 2：**最后一个句子**是否定式结论。
//
// 词表刻意只收「不会出现在让步从句里」的短语。「逻辑正确」「无问题」「无需修改」
// 这类**必须排除**：它们是让步从句的标准开头（「计数逻辑正确，但 dry-run 分支漏了
// 自增」正是实测里唯一那条真阳性的写法），放进词表会把真缺陷吃掉。它们作为**整个
// suggestion** 出现时已由规则 1 全等匹配覆盖。
const NEGATION_CONCLUSIONS = [
  '不构成缺陷', '不构成问题', '无实际缺陷', '无实际问题', '并非缺陷', '不是缺陷',
  'not a defect', 'not an actual defect', 'no actual defect', 'not an issue',
];

// 末句里出现转折词，说明否定只是让步的前半截，后面还有真正的主张。
const CONCESSIVE_MARKERS = ['但', '不过', '然而', '可是', '只是', 'however', 'but ', 'except'];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function lastSentence(text: string): string {
  const parts = normalize(text)
    .split(/[。；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.at(-1) ?? '';
}

function concludesNoDefect(text: string): boolean {
  const sentence = lastSentence(text);
  if (CONCESSIVE_MARKERS.some((marker) => sentence.includes(marker))) return false;
  return NEGATION_CONCLUSIONS.some((phrase) => sentence.includes(phrase));
}

export function isSelfRefuting(finding: CandidateFinding): boolean {
  if (NO_OP_SUGGESTIONS.has(normalize(finding.suggestion))) return true;
  return concludesNoDefect(finding.evidence) || concludesNoDefect(finding.impact);
}
```

**Step 4: 跑测试确认通过**

```bash
cd action && npx vitest run src/lib/self-refutation-gate.test.ts
```
预期：PASS，**全部 16 条**（11 条 `it.each` + 2 条正例 + 3 条反例）。反例只要有一条红，就是词表又收宽了，回去删词，不要改测试。

**Step 5: 接进 arbiter**

改 `action/src/lib/arbiter.ts`：

- 顶部加 `import { isSelfRefuting } from './self-refutation-gate.js';`
- `InternalDiagnosticOutcome` 加一个成员：`| 'rejected_self_refuted'`（这是纯 TS 联合类型，`schemas/` 下没有 outcome 枚举约束，新增取值不会破坏任何校验）
- 在 `arbitrate` 的主循环最前面：

```typescript
  for (const candidate of candidates) {
    if (isSelfRefuting(candidate.finding)) {
      internalDiagnostics.push({
        id: candidate.finding.id,
        path: candidate.finding.path,
        line: candidate.finding.line,
        outcome: 'rejected_self_refuted',
        reason: 'finding text concludes there is no defect / suggestion is a no-op',
      });
      continue;
    }

    if (candidate.deterministicStatus === 'failed') {
```

> `arbitrate` 收到的是**已经过 verifier 的** candidates（`analyze.ts:320`），所以这道门省不掉 verifier 的调用费用。要省钱得把它前移到 `analyze.ts:271` 的验证循环开头——那是 Task 4 之后的独立优化，**不要在本 commit 里混进来**。

**Step 6: 补 arbiter 测试**

`action/src/lib/arbiter.test.ts` 已有 `makeFinding(overrides: Partial<CandidateFinding> = {})`（第 6 行），直接复用：

```typescript
it('drops a self-refuting candidate before dedup and records it in diagnostics', () => {
  const result = arbitrate([
    {
      finding: makeFinding({ suggestion: '无。' }),
      deterministicStatus: 'passed',
      verifierConclusion: { status: 'confirmed' },
    },
  ]);
  expect(result.findings).toHaveLength(0);
  expect(result.internalDiagnostics[0]?.outcome).toBe('rejected_self_refuted');
});
```
`deterministicStatus: 'passed'` + `confirmed` 是刻意的：证明这道门确实排在那两者之前。

**Step 7: 跑全量单测并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/self-refutation-gate.ts action/src/lib/self-refutation-gate.test.ts \
        action/src/lib/arbiter.ts action/src/lib/arbiter.test.ts action/dist
git commit -m "fix(arbiter): 丢弃正文自称不构成缺陷的 finding"
```

---

### Task 2: `source_agent` 由 runner 本地补齐（P6-a）

改动面最小、无规格冲突，**建议第一个做**。

**Files:**
- Modify: `action/src/lib/expert-runner.ts`（`requestAndValidate`）
- Modify: `action/src/lib/expert-runner.test.ts`

**Step 1: 写失败测试**

```typescript
it('fills source_agent from agentName when the model omits it', async () => {
  const client = {
    sendStructuredRequest: vi.fn().mockResolvedValue({
      shard_id: 's1',
      agent: 'generic-correctness',
      coverage_complete: true,
      candidate_findings: [
        // 与 2026-08-28 第 6 轮、第 12 轮线上观测到的响应一致：除 source_agent
        // 外全部字段齐备
        {
          id: 'f1', path: 'a.sh', line: 3, side: 'RIGHT',
          severity: 'low', confidence: 'low', category: 'style',
          title: 't', evidence: 'e', impact: 'i', suggestion: 's',
          introduced_by_pr: true,
        },
      ],
    }),
  };

  const result = await runExpert({ /* …照该文件既有用例填参数…，agentName: 'generic-correctness' */ });

  expect(result.output.candidate_findings[0]?.source_agent).toBe('generic-correctness');
});

it('keeps a source_agent the model did provide', async () => {
  // 模型把 finding 归给别的 agent 这件事必须仍然可观察
  /* …同上，但 candidate_findings[0].source_agent = 'generic-security' … */
  expect(result.output.candidate_findings[0]?.source_agent).toBe('generic-security');
});
```

**Step 2: 确认失败**

```bash
cd action && npx vitest run src/lib/expert-runner.test.ts -t 'fills source_agent'
```
预期：FAIL，`expert-runner: model response failed expert-output schema validation: /candidate_findings/0 must have required property 'source_agent'`。与线上日志逐字相同。

**Step 3: 实现**

在 `expert-runner.ts` 里 `coerceStringifiedBoolean` 旁边加一个同级函数：

```typescript
// `source_agent` 的正确值永远是调用方自己传进来的 agentName —— 让模型回填一个
// 我们已经知道的常量，等于凭空造出一个失败面。2026-08-28 的 ios-source-learning#9
// 上，17 轮里有 2 轮就是因为模型漏填这个字段而整轮判 incomplete。
//
// 与 coerceStringifiedBoolean 同一性质：只补 runner 的元数据，绝不触碰任何
// 证据字段（path/line/evidence/…），所以不削弱证据完整性边界。**只在缺失时补**，
// 模型填了值就原样保留，这样「模型把 finding 归给了别的 agent」仍然可被观察到。
function fillMissingSourceAgent(raw: unknown, agentName: string): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.candidate_findings)) return raw;

  return {
    ...obj,
    candidate_findings: obj.candidate_findings.map((finding) => {
      if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) return finding;
      const f = finding as Record<string, unknown>;
      return f.source_agent === undefined ? { ...f, source_agent: agentName } : f;
    }),
  };
}
```

`requestAndValidate` 里：

```typescript
  const raw = fillMissingSourceAgent(coerceStringifiedBoolean(rawResponse), input.agentName);
```

**Step 4-5: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/expert-runner.ts action/src/lib/expert-runner.test.ts action/dist
git commit -m "fix(expert-runner): source_agent 缺失时用 agentName 本地补齐"
```

---

### Task 3: verifier 补上重试，且只重试真正随机的那一类（P6-c）

**Files:**
- Modify: `action/src/lib/verifier-client.ts`
- Modify: `action/src/lib/verifier-client.test.ts`
- Modify: `action/config/central-limits.json`
- Modify: `action/src/entrypoints/analyze.ts`（`AnalyzeLimits` 与调用处）
- Modify: `action/config/README.md`

**关键约束（v1 在这里错了）**：`verifier-client.ts:36-50` 把 `sendStructuredRequest` 的**任何**异常一律包成 `VerifierUnavailableError`。所以「重试所有 `VerifierUnavailableError`」会连带重试这些**确定性**失败：`response missing tool_calls`、`request failed with status 401`、`response body is empty`、`non-finite number`、以及客户端内部已经退避重试过 3 次的 `DeepSeekTransientError`。`deepseek-client.ts:22-24` 的注释明说这类「repeat deterministically, so retrying only burns quota」。最坏情况是 200 × 2 = 400 次无效调用。**必须把可重试的那一类单独立类型。**

**Step 1: 写失败测试**

```typescript
it('retries once when the verifier response fails schema validation, then succeeds', async () => {
  const client = {
    sendStructuredRequest: vi.fn()
      // 与 2026-08-29 第 17 轮线上观测一致：缺 status
      .mockResolvedValueOnce({ notes: 'looks fine' })
      .mockResolvedValueOnce({ status: 'rejected' }),
  };
  const conclusion = await verifyFinding({
    finding: makeFinding(), contextContent: '', model: 'deepseek-chat',
    client, maxSchemaRetries: 1, retrySleep: async () => {},
  });
  expect(conclusion.status).toBe('rejected');
  expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
});

it('retries a malformed tool-call payload', async () => {
  const client = {
    sendStructuredRequest: vi.fn()
      .mockRejectedValueOnce(new DeepSeekMalformedResultError('deepseek-client: tool call arguments are not valid JSON'))
      .mockResolvedValueOnce({ status: 'confirmed' }),
  };
  const conclusion = await verifyFinding({ /* …maxSchemaRetries: 1… */ });
  expect(conclusion.status).toBe('confirmed');
  expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
});

it('does NOT retry a deterministic client failure', async () => {
  const client = {
    sendStructuredRequest: vi.fn()
      .mockRejectedValue(new DeepSeekResponseError('deepseek-client: request failed with status 401')),
  };
  await expect(verifyFinding({ /* …maxSchemaRetries: 1… */ })).rejects.toBeInstanceOf(VerifierUnavailableError);
  // 401 重试多少次都是 401，只烧配额
  expect(client.sendStructuredRequest).toHaveBeenCalledTimes(1);
});

it('still throws after schema retries are exhausted', async () => {
  const client = { sendStructuredRequest: vi.fn().mockResolvedValue({ notes: 'no status' }) };
  await expect(verifyFinding({ /* …maxSchemaRetries: 1… */ })).rejects.toBeInstanceOf(VerifierUnavailableError);
  expect(client.sendStructuredRequest).toHaveBeenCalledTimes(2);
});
```

**Step 2: 确认失败**（`maxSchemaRetries` 尚不是 `VerifyFindingInput` 的字段，TS 直接报错）

**Step 3: 实现**

```typescript
import { withRetry } from './retry.js';
import { DeepSeekMalformedResultError, type StructuredRequestInput } from './deepseek-client.js';

export class VerifierUnavailableError extends Error {}

/**
 * verifier 的**响应结构**不可用——模型这一次没按 schema 输出（实测第 17 轮：
 * 缺 `status`）。和 ExpertOutputSchemaError 同一性质：同样的请求下一次通常就好了。
 *
 * 单独立成子类，是因为 verifyFinding 会把客户端的**任何**异常都包成
 * VerifierUnavailableError —— 其中 401、空响应体、缺 tool_calls 都是确定性失败，
 * 重试只烧配额。只有这一类和 DeepSeekMalformedResultError 值得重试。
 */
export class VerifierSchemaError extends VerifierUnavailableError {}

export async function verifyFinding(input: VerifyFindingInput): Promise<VerifierConclusion> {
  return withRetry(() => requestAndValidate(input), {
    maxRetries: input.maxSchemaRetries ?? 0,
    ...(input.retrySleep ? { sleep: input.retrySleep } : {}),
    isRetryable: (err) =>
      err instanceof VerifierSchemaError ||
      (err as { cause?: unknown } | null)?.cause instanceof DeepSeekMalformedResultError,
  });
}
```

`requestAndValidate` 就是原 `verifyFinding` 的函数体，两处改动：

```typescript
  } catch (err) {
    // 带上 cause，让上面的 isRetryable 能分辨「模型这次抽了」和「401 / 空响应体」
    // 这两种完全不同的失败。tsconfig target 是 ES2022，Error cause 可直接用。
    throw new VerifierUnavailableError(
      `verifier-client: verifier call failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
```
```typescript
  if (!result.valid) {
    throw new VerifierSchemaError(
      `verifier-client: verifier response failed schema validation: ${result.errors.join('; ')}`,
    );
  }
```

**Step 4: 接线**

- `action/config/central-limits.json` 增加 `"maxVerifierSchemaRetries": 1`。**`maxExpertSchemaRetries` 保持 1 不动**——v1 想提到 2，依据是温度 1.0 时代的穿透率；Task 5 把温度降到 0 之后这个依据失效，等 Task 12 的数据出来再决定（见 Task 5 的取舍说明）。
- `analyze.ts` 的 `AnalyzeLimits` 加 `maxVerifierSchemaRetries: number;`，`run()` 从 `centralLimits` 读，`verifyFinding({...})` 传 `maxSchemaRetries: input.limits.maxVerifierSchemaRetries`。
- `action/config/README.md` 补一行新键说明（格式照既有条目）。

**Step 5-6: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/verifier-client.ts action/src/lib/verifier-client.test.ts \
        action/src/entrypoints/analyze.ts action/config/central-limits.json action/config/README.md action/dist
git commit -m "fix(verifier): 只对 schema 抖动重试，确定性失败不重试"
```

---

### Task 4: 单个 expert 失败不再中断整轮，但要有熔断（P6'）

**Files:**
- Modify: `action/src/entrypoints/analyze.ts:164-204` 与 `:244-248`
- Modify: `action/src/entrypoints/analyze.test.ts`
- Modify: `.github/workflows/reusable-pr-review.yml`（给 analyze Job 加 `timeout-minutes`）

**取舍先说清楚**：现在一个 agent 抛错就 `break outer`，剩余 shard × agent 全部不跑。改成「跳过这一个、继续跑其余」会在失败时**增加**调用量：`AGENT_NAMES` 3 个 × `maxShardsPerRun: 20` = 60 次 expert 调用，每次客户端内部还有 `maxRetries: 3` 的退避。DeepSeek 整体不可用时这会放大成 60 × 4 次，而 `fetchImpl` 没有超时、workflow 也没有 `timeout-minutes`（全仓库只有 `nightly.yml:24/47` 有）。**所以本任务必须同时加熔断和 Job 超时**，只做 `continue` 是不负责任的。

另一处必须区分的：`skillsForAgent(...)` 和 `runExpert(...)` 现在共用 `analyze.ts:170-191` 同一个 try。skill 文件畸形是**确定性**本地失败（`analyze.test.ts:371` 断言的正是这个场景），100% 会复现，对它 fan-out 纯属烧钱。**把 `skillsForAgent` 移出该 try，本地失败继续 `break outer`。**

**Step 1: 写失败测试**

```typescript
it('skips only the failing agent and still analyzes the remaining ones', async () => {
  // client 同时供 expert 和 verifier 使用，必须按 systemPrompt 分流
  //（照抄 analyze.test.ts:378-397 的现成写法），否则 verifier 会拿到 expert 的
  // 输出、schema 校验失败，findings 恒为空。
  const client = { sendStructuredRequest: vi.fn().mockImplementation(async (req) => {
    if (req.systemPrompt.includes('independent verifier')) return { status: 'confirmed' };
    if (client.sendStructuredRequest.mock.calls.length === 1) {
      throw new Error('deepseek-client: tool call arguments are not valid JSON');
    }
    return makeExpertOutput({ candidate_findings: [makeCandidate()] });
  }) };

  const result = await runAnalysis({ /* 单 shard，3 个 agent */ });

  expect(result.anyRequiredStageFailed).toBe(true);
  expect(result.findings.length).toBeGreaterThan(0);
});

it('breaks out after 3 consecutive expert failures instead of fanning out', async () => {
  const client = { sendStructuredRequest: vi.fn().mockRejectedValue(new Error('deepseek down')) };
  await runAnalysis({ /* 20 shard × 3 agent */ });
  expect(client.sendStructuredRequest).toHaveBeenCalledTimes(3);
});

it('still stops immediately when loading a skill file fails', async () => {
  // analyze.test.ts:371 的既有断言，改造后必须仍然成立
  const client = { sendStructuredRequest: vi.fn() };
  await runAnalysis({ loadSkillFn: () => { throw new Error('malformed skill'); } /* … */ });
  expect(client.sendStructuredRequest).not.toHaveBeenCalled();
});
```

**Step 2: 确认失败**（第一条当前调用 1 次、findings 为 0；第二条当前调用 1 次，恰好通过但理由不同——加熔断后要保持 3 次）

**Step 3: 实现**

```typescript
// 连续失败到这个数就停。单次格式抖动不该让整轮报废（实测 5 个 incomplete 轮次
// 全是这么来的），但 DeepSeek 整体不可用时也不该把 20 shard × 3 agent 全试一遍。
const MAX_CONSECUTIVE_EXPERT_FAILURES = 3;
```

主循环改造：

```typescript
    for (const agentName of AGENT_NAMES) {
      // skill 加载失败是确定性的本地错误，不是模型抖动 —— 对它 fan-out 只烧钱。
      let skills;
      try {
        skills = skillsForAgent(agentName, filePaths, skillIndex, loadSkillFn);
      } catch (err) {
        anyRequiredStageFailed = true;
        stageFailureReason ??= err instanceof Error ? err.message : String(err);
        stop = true;
        break outer;
      }

      let result;
      try {
        result = await runExpert({ /* …原样，systemPromptSkills: skills.map((s) => s.body)… */ });
        consecutiveExpertFailures = 0;
      } catch (err) {
        // 一个 agent 的格式抖动不该让整轮审核报废。verdict 仍降级为 incomplete
        //（下游据此加免责横幅、并按 Task 6 决定 review event），但其余
        // shard × agent 照跑 —— 部分覆盖远好于零覆盖。
        anyRequiredStageFailed = true;
        stageFailureReason ??= err instanceof Error ? err.message : String(err);
        consecutiveExpertFailures += 1;
        if (consecutiveExpertFailures >= MAX_CONSECUTIVE_EXPERT_FAILURES) {
          stop = true;
          break outer;
        }
        continue;
      }
```

`supplement` 循环（`:244-248`）做同样处理：`break supplement` 改为同一套「计数 + 到阈值才 break」。

> **`outer:` 标签和其余 `stop` 赋值一律不要动**——`analyze.ts:201` 的 hardLimitHit 分支仍在用这个标签，删了编译不过。本任务只改这一处 catch 的行为。
> 熔断没触发时 `stop` 为 false，`analyze.ts:206` 的 skill 补充轮会照常跑，这是对的：部分 agent 成功说明模型可用。

**Step 4: 给 analyze Job 加超时**

> 改 workflow 前先读 [`docs/AGENTS.md`](../AGENTS.md)。加 `timeout-minutes` 是收紧，不涉及 `permissions` 或 Secret 边界。

`.github/workflows/reusable-pr-review.yml` 的 `analyze` job 加 `timeout-minutes: 20`（默认 360 分钟对一个约 2-3 分钟的 job 毫无意义）。

**Step 5-6: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/entrypoints/analyze.ts action/src/entrypoints/analyze.test.ts \
        .github/workflows/reusable-pr-review.yml action/dist
git commit -m "fix(analyze): 单个 expert 失败只跳过该 agent，连续 3 次才熔断"
```

> `analyze.test.ts:311` 的 `toHaveBeenCalledTimes(1)`（注释「should stop scheduling further expert calls once one has failed」）是本任务**有意推翻**的既有断言，改成新语义即可。`analyze.test.ts:371` 的 `not.toHaveBeenCalled()` **必须保持通过**——那条断言的是合法场景（Step 3 的 skill 分流就是为它准备的）。

---

### Task 5: 采样温度置 0（P10）

**Files:**
- Modify: `action/src/lib/deepseek-client.ts`
- Modify: `action/src/lib/deepseek-client.test.ts`

**Step 0（先做，否则没有对照）：留基线**

```bash
cd benchmarks && node run-evaluation.mjs --case=<代表性用例> --repeat=3
```
记下输出里的 `instability` 值（`run-evaluation.mjs:164` 的 `findingSetInstability`，阈值键是 `thresholds.json:17` 的 `max_finding_set_instability: 0.35`）。**这个数字要抄进本任务的 commit message**，Task 12 拿它做前后对照。

**Step 1: 写失败测试**

```typescript
it('sends temperature 0 for structured extraction', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(makeToolCallResponse({ ok: true }));
  const client = createDeepSeekClient({ apiKey: 'k', fetchImpl });
  await client.sendStructuredRequest({ model: 'deepseek-chat', systemPrompt: 's', userPrompt: 'u', jsonSchema: {} });

  const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body);
  expect(body.temperature).toBe(0);
});
```

> 测试名刻意只说「发出 temperature 0」，不说「同 diff 必出同 findings」——t=0 在 MoE + 批处理下并不保证逐 token 确定，`top_p` 也没动。承诺只到「降低方差」，量化交给 Step 0 / Task 12 的对照数据。

**Step 2: 确认失败**（当前 body 里没有 `temperature`，得到 `undefined`）

**Step 3: 实现**

```typescript
// 不设 temperature 就是走 DeepSeek 的默认值（deepseek-chat 为 1.0）。对于
// 「从 diff 里抽取缺陷并填进固定 schema」这种任务，默认温度带来的只有方差。
//
// 实测依据：ios-source-learning#9 的第 17、18 轮跑的是同一个 head_sha
// 9d434a41、同一份 diff，一轮 4 条 finding、另一轮 3 条，**交集为 0**，
// 且完整性判定还不一样。评测集上的召回率完全没有覆盖这种 run-to-run 方差。
//
// 副作用要留意：schema 重试（expert-runner / verifier-client）的正当性建立在
// 「同样的请求下一次通常就好了」上，温度降到 0 后这个前提被削弱。所以本轮
// **不动** maxExpertSchemaRetries，等 Task 12 的数据说话。
const STRUCTURED_EXTRACTION_TEMPERATURE = 0;
```

请求体里加 `temperature: STRUCTURED_EXTRACTION_TEMPERATURE`。
（`action/config/allowed-models.json` 只放行 `deepseek-chat`，不涉及 `deepseek-reasoner` 忽略 temperature 的坑。）

**Step 4-5: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/deepseek-client.ts action/src/lib/deepseek-client.test.ts action/dist
git commit -m "fix(deepseek-client): 结构化抽取固定 temperature=0（基线 instability=<Step 0 的数字>）"
```

---

### Task 6: incomplete 且仅剩 low 时降级为 COMMENT（P7）——**含规格变更**

> **这是一次显式的规格变更，用户已于 2026-08-30 明确同意，并选定「排除 `hard_limit_hit`」这一版。**
>
> 被改的规格：`docs/plans/2026-07-13-pr-review-swarm-design.md:152`「所有严重度的最终 findings 都必须反馈，不隐藏、不截断。**任何最终 finding 都触发 `REQUEST_CHANGES`**；severity 只影响排序和展示。」同口径见 L29、L304。
> 被改的不变式：`action/src/lib/verdict.test.ts:268` 的 `it('findings > 0 时 final_review_event 必为 REQUEST_CHANGES')`——那是「对抗性测试加固计划 Task 3.1」留下的 160 组合穷举。
> **为什么排除 `hard_limit_hit`**：它是 `verdict.ts:20` 的 incomplete 触发维度之一。「`maxVerifierCallsPerRun` 耗尽 → 剩余候选全丢 → 剩下的恰好全是 low」这条路径若也降级，实际效果就是「截断之后不再阻塞」，正是 `docs/AGENTS.md` 硬禁令 8 想防的东西。所以降级只在 incomplete **不是**由硬上限引起时生效。

**Files:**
- Modify: `action/src/lib/verdict.ts:45-52`
- Modify: `action/src/lib/verdict.test.ts`（含 `makeFinding` helper 与 `:268` 的不变式）
- Modify: `action/src/entrypoints/publish.ts:130`
- Modify: `action/src/entrypoints/publish.test.ts`
- Modify: `action/test/integration/injection-e2e.test.ts:149,170` ← **v1 漏掉的调用点**

**Step 1: 改 helper**

`verdict.test.ts:18` 现在是 `makeFinding(id: string)`。改成 `makeFinding(overrides: Partial<Finding> = {})`，形态照抄 `arbiter.test.ts:6`，并更新该文件里所有既有调用点。

**Step 2: 写失败测试**

```typescript
describe('computeFinalReviewEvent', () => {
  it('downgrades an incomplete run with only low-severity findings to COMMENT', () => {
    expect(computeFinalReviewEvent('incomplete', [
      makeFinding({ severity: 'low' }), makeFinding({ severity: 'low' }),
    ], [])).toBe('COMMENT');
  });

  it('still requests changes when the incomplete run found a medium', () => {
    expect(computeFinalReviewEvent('incomplete', [
      makeFinding({ severity: 'low' }), makeFinding({ severity: 'medium' }),
    ], [])).toBe('REQUEST_CHANGES');
  });

  // 硬禁令 8：硬上限截断后不得因此不再阻塞
  it('does NOT downgrade when the run is incomplete because a hard limit was hit', () => {
    expect(computeFinalReviewEvent('incomplete', [makeFinding({ severity: 'low' })],
      ['hard_limit_hit'])).toBe('REQUEST_CHANGES');
  });

  it('is unchanged for a complete run with only low findings', () => {
    expect(computeFinalReviewEvent('changes_requested', [makeFinding({ severity: 'low' })], []))
      .toBe('REQUEST_CHANGES');
  });

  it('returns none for an incomplete run with no findings', () => {
    expect(computeFinalReviewEvent('incomplete', [], [])).toBe('none');
  });
});
```

**Step 3: 改 `:268` 的穷举不变式**

不要删，改成「除 incomplete-且-全 low-且-非硬上限之外，findings > 0 必为 REQUEST_CHANGES」，保留穷举覆盖：

```typescript
it('findings > 0 时 final_review_event 必为 REQUEST_CHANGES（唯一例外：incomplete + 全 low + 非硬上限）', () => {
  for (const combo of COMBINATIONS) {
    if (combo.findingCount === 0) continue;
    const { verdict, incompleteReasons } = computeVerdict(combo);
    const findings = /* 按 combo.findingCount 造，severity 取自 combo 或默认 medium */;
    const event = computeFinalReviewEvent(verdict, findings, incompleteReasons);
    const isException =
      verdict === 'incomplete' &&
      findings.every((f) => f.severity === 'low') &&
      !incompleteReasons.includes('hard_limit_hit');
    expect(event, combo.label).toBe(isException ? 'COMMENT' : 'REQUEST_CHANGES');
  }
});
```

**Step 4: 实现**

```typescript
// 机器人永远不给最终合并确认——那是人的判断。所以即便是干净的 `pass` 也只发
// COMMENT-state Review，从不 APPROVE；只有 REQUEST_CHANGES 是真正的状态变更。
//
// incomplete 是第三种情形：我们**知道自己没看全**。此时只有 low 级 finding，
// 等于「没看全，也没发现要紧的问题」——用 REQUEST_CHANGES 卡住一个 PR 说不通。
// 2026-08-29 的 ios-source-learning#9 第 17 轮正是这个组合：verdict=incomplete、
// 4 条全 low、其中 2 条还是自我否定，却发了 REQUEST_CHANGES。
//
// 但 hard_limit_hit 引起的 incomplete 不降级：那意味着我们主动截断了分析，
// 「截断后不再阻塞」正是 docs/AGENTS.md 硬禁令 8 要防的。
export function computeFinalReviewEvent(
  verdict: Verdict,
  finalFindings: Finding[],
  incompleteReasons: string[],
): 'COMMENT' | 'REQUEST_CHANGES' | 'none' {
  if (verdict === 'pass') return 'COMMENT';
  if (verdict === 'changes_requested') return 'REQUEST_CHANGES';
  if (finalFindings.length === 0) return 'none';
  if (incompleteReasons.includes('hard_limit_hit')) return 'REQUEST_CHANGES';
  return finalFindings.every((f) => f.severity === 'low') ? 'COMMENT' : 'REQUEST_CHANGES';
}
```

**Step 5: 更新全部调用点**

- `publish.ts:130` → `computeFinalReviewEvent(verdict, input.findings, incompleteReasons)`
- `action/test/integration/injection-e2e.test.ts:149` 和 `:170` → 传 `Finding[]` 和 `incompleteReasons`

先 grep 确认没有第四处：

```bash
grep -rn "computeFinalReviewEvent" action/ --include='*.ts'
```

**Step 6: 验证并提交**

incomplete 免责横幅不受影响（`publish.ts:407-410` 的 `bannerReasons` 只看 `verdict === 'incomplete'`，不看 event），Check 结论也不变（`status-finalize.ts:26-27`）。

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/verdict.ts action/src/lib/verdict.test.ts \
        action/src/entrypoints/publish.ts action/src/entrypoints/publish.test.ts \
        action/test/integration/injection-e2e.test.ts action/dist
git commit -m "feat(verdict): incomplete 且仅剩 low（非硬上限）时降级为 COMMENT"
```

设计文档与 CHECKLIST 的同步在 Task 11。

---

### Task 7: supersede 横幅覆盖式、幂等，并修掉分页缺失（P8）

**Files:**
- Modify: `action/src/entrypoints/publish.ts:218-290`（含 `:239` 的分页）
- Modify: `action/src/entrypoints/publish.test.ts`

**Step 1: 写失败测试**

`review_set_id` 是 `review-set-id.ts:37` 生成的 **20 位小写 hex**，测试夹具必须用真实形态（v1 用了 `old111`，含非 hex 字符，正则匹配不上，导致自带测试与自带实现互相打架）：

```typescript
const OLD_ID = 'da930601ee5709fe5117';   // 实测第 9 轮真实 id
const NEW_ID = '749175639961c1b2be8b';   // 实测第 17 轮真实 id

it('replaces an existing supersede banner instead of stacking a second one', () => {
  const body = applySupersedeNotice(`⚠️ 已被新一轮审核（review_set_id=${OLD_ID}）取代。\n\n正文`, NEW_ID);
  expect(body).toBe(`⚠️ 已被新一轮审核（review_set_id=${NEW_ID}）取代。\n\n正文`);
  expect(body.match(/已被新一轮审核/g)).toHaveLength(1);
});

it('strips a whole stack of banners at once', () => {
  // 实测里单条评论最多堆了 17 行
  const stacked = Array.from({ length: 17 }, (_, i) =>
    `⚠️ 已被新一轮审核（review_set_id=${OLD_ID}）取代。\n\n`).join('') + '正文';
  expect(applySupersedeNotice(stacked, NEW_ID).match(/已被新一轮审核/g)).toHaveLength(1);
});

it('also strips the review-body variant that carries the trailing pointer', () => {
  const body = applySupersedeNotice(
    `⚠️ 已被新一轮审核（review_set_id=${OLD_ID}）取代，请以下方最新 Review 为准。\n\n正文`,
    NEW_ID, '，请以下方最新 Review 为准。',
  );
  expect(body.match(/已被新一轮审核/g)).toHaveLength(1);
});

it('leaves a body without a banner intact apart from the new prefix', () => {
  expect(applySupersedeNotice('正文', NEW_ID)).toBe(`⚠️ 已被新一轮审核（review_set_id=${NEW_ID}）取代。\n\n正文`);
});

it('paginates review comments instead of stopping at the default 30', async () => {
  const octokit = makeOctokit({ reviewCommentPages: [Array(100).fill(comment), Array(20).fill(comment)] });
  await executePublish({ /* … */ });
  expect(octokit.paginate).toHaveBeenCalled();
});
```

**Step 2: 确认失败**（`applySupersedeNotice` 尚不存在）

**Step 3: 实现**

在 `publish.ts` 的 `supersedeOldReviewSets` 上方：

```typescript
// 横幅必须**覆盖**而不是追加。原实现无条件 `notice + 旧 body`，于是第 N 轮会给
// 前 N-1 轮的每条评论再叠一行：ios-source-learning#9 跑到第 17 轮时，62 条 inline
// 评论上累计了 341 行横幅，单条最多 17 行 —— 正文被推得完全看不见。
//
// id 是 review-set-id.ts 生成的 20 位小写 hex；正则同时覆盖两种线上文本：
// Review 正文的「…取代，请以下方最新 Review 为准。」和 inline 评论的「…取代。」。
const SUPERSEDE_BANNER_RE =
  /^(?:⚠️ 已被新一轮审核（review_set_id=[0-9a-f]+）取代[^\n]*\n\n)+/;

export function applySupersedeNotice(body: string, currentReviewSetId: string, tail = '。'): string {
  const notice = `⚠️ 已被新一轮审核（review_set_id=${currentReviewSetId}）取代${tail}\n\n`;
  return notice + body.replace(SUPERSEDE_BANNER_RE, '');
}

export function hasSupersedeBanner(body: string | null | undefined): boolean {
  return SUPERSEDE_BANNER_RE.test(body ?? '');
}
```

三处改造：

1. **分页**（这是 P8 验收能不能成立的前提）。`:239` 换成：
   ```typescript
   const allComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
     owner: params.owner, repo: params.repo, pull_number: params.prNumber, per_page: 100,
   });
   ```
   同文件 `:208-213` 的 `listFiles` 就是这个写法，照抄。**不修这个，第 31 条以后的评论永远处理不到**，横幅是不是覆盖式都无所谓了。

2. **幂等**。`staleReviews` 过滤条件追加 `&& !hasSupersedeBanner(review.body)`。
   代价说清楚：更老的 Review 上的 `review_set_id` 指针会停在它当初被取代的那一轮。横幅的作用是「这条已过期」，指针停在哪一轮不影响这个判断。
   注意 **`dismissReview` 成功时 GitHub 不改 review body**，所以被 dismiss 的那些下一轮仍会命中一次 `updateReview`。稳态是每轮处理约 2 个历史 Review——总量从 O(N²) 降到 **O(N)**，不是严格 O(1)。

3. **覆盖式**。`:276` 与 `:286` 分别改为
   `applySupersedeNotice(review.body ?? '', params.currentReviewSetId, '，请以下方最新 Review 为准。')`
   和 `applySupersedeNotice(comment.body ?? '', params.currentReviewSetId)`。

**Step 4-5: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/entrypoints/publish.ts action/src/entrypoints/publish.test.ts action/dist
git commit -m "fix(publish): supersede 横幅改覆盖式并补上评论分页"
```

---

### Task 8: 已关闭 / 已合并的 PR 直接短路（P9）

> **先读 [`docs/AGENTS.md`](../AGENTS.md)。** 本任务改信任门 `status-start` 与部署模板，属于安全边界代码。这里是**收紧**（多一个不跑的条件），不是放宽，但仍要把 9 条硬禁令读完再动手。

**v1 在这里定位错了文件**：真正的第一触发源是本项目自己的部署 CLI 模板，不是 `.github/workflows/pr-review-caller.yml`（后者本来就没有 `closed`）。

**Files:**
- Modify: `cli/src/lib/write-workflows.mjs:20` ← **真正的第一道防线**
- Modify: `cli/` 对应的单测（`write-workflows` 的快照/断言，先 grep 定位）
- Modify: `action/src/lib/identity-tuple.ts`
- Modify: `action/src/entrypoints/status-start.ts`
- Modify: `action/src/entrypoints/status-start.test.ts`

**Step 1: 收窄部署模板的触发条件**

`cli/src/lib/write-workflows.mjs:20` 现在是：

```
types: [opened, synchronize, reopened, ready_for_review, edited, converted_to_draft, closed]
```

**用户已决定：`closed` 和 `edited` 都删。** 改成：

```yaml
    # 不含 closed：PR 合并后再跑一轮只会留下一条没人会处理的 REQUEST_CHANGES
    #（实测 ios-source-learning#9 第 18 轮）。不含 edited：改标题/正文不影响 diff，
    # 却会触发一整轮完整审核。action 侧 status-start 还有第二道短路。
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]
```

先 grep 出 `cli/` 里断言了这份模板内容的测试，一并更新：

```bash
grep -rn "converted_to_draft\|ready_for_review" cli/
```

**Step 2: 写 action 侧的失败测试**

```typescript
it('skips the review entirely when the PR is already merged', async () => {
  const octokit = makeOctokit({ pull: { state: 'closed', merged: true } });
  const result = await evaluateAndStartStatus(octokit, makeInput());

  expect(result.gatePassed).toBe(false);
  // 已合并不是「需要人处理」，check 不能是红的
  expect(octokit.rest.checks.update).toHaveBeenCalledWith(
    expect.objectContaining({ conclusion: 'neutral' }),
  );
});

it('skips a closed-unmerged PR the same way', async () => {
  const octokit = makeOctokit({ pull: { state: 'closed', merged: false } });
  expect((await evaluateAndStartStatus(octokit, makeInput())).gatePassed).toBe(false);
});

it('still reviews an open PR', async () => {
  const octokit = makeOctokit({ pull: { state: 'open', merged: false } });
  expect((await evaluateAndStartStatus(octokit, makeInput())).gatePassed).toBe(true);
});
```

> `status-start.test.ts:28-33` 的现有 `pulls.get` mock 没有 `state`/`merged`。改完后 `undefined === 'closed'` 为 false，既有用例不会红，但**顺手把 `state: 'open', merged: false` 补进去**，免得将来收紧类型时踩坑。

**Step 3: 暴露 PR 状态**

`identity-tuple.ts:20` 的 `fetchIdentityTuple` 已经调了 `pulls.get`，`@octokit/openapi-types` 的 `pull-request` schema 同时有 `state: "open" | "closed"` 和 `merged: boolean`，数据就在手里。

**做法唯一**：让 `fetchIdentityTuple` 额外返回这两个字段（新增并列的返回结构，**不要改 `IdentityTuple` 本身**——它进 verdict artifact，受 `schemas/verdict.schema.json:8-22` 约束）。不要新写一个 `fetchPullRequestState`，那会多打一次 API。

**Step 4: 实现门禁**

`status-start.ts` 的 `evaluateAndStartStatus` 里，在 `repoConfig.enabled` 检查**之前**：

```typescript
  // 已合并 / 已关闭的 PR 上再发 Review 没有任何意义，只会留下一条永远不会被
  // 处理的 REQUEST_CHANGES 和一个红叉。2026-08-30 的 ios-source-learning#9：
  // 00:45:10 合并，00:45:14 被 closed 事件触发，00:47:13 在已合并 PR 上提交了
  // 第 18 轮 CHANGES_REQUESTED。
  //
  // 防线放在 action 里而不是只放在部署模板里：模板落地后就是使用方自己的文件，
  // 我们改不动已经发出去的那些。
  if (pullState.state === 'closed') {
    core.info(`status-start: skipping ${pullState.merged ? 'merged' : 'closed'} PR`);
    await patchCheckConclusion(octokit, {
      owner: input.owner, repo: input.repo, checkRunId, conclusion: 'neutral',
    });
    return { gatePassed: false, identityTuple, checkRunId };
  }
```

**不要复用 `rejectWithActionRequired`**：它写的是 `action_required`（红），而「PR 已合并」不需要任何人做任何事，必须是 `neutral`。

`gate_passed: false` 能正确短路整条流水线——`reusable-pr-review.yml:48/107/134` 三处都挂了 `gate_passed == 'true'`，`neutral` 结论由 status-start 自己写完，不会留孤儿 Check。

**Step 5-6: 验证并提交**

```bash
cd action && npm test && cd ../cli && npm test && cd ../action && npm run build && cd ..
git add cli/src/lib/write-workflows.mjs cli/ action/src/lib/identity-tuple.ts \
        action/src/entrypoints/status-start.ts action/src/entrypoints/status-start.test.ts action/dist
git commit -m "fix: 已关闭或已合并的 PR 不再触发审核"
```

---

### Task 9: 提示词补强与标题长度兜底（P2 / P5 / P1 补强）

提示词是**补强**，不是防线——P1 的真正防线是 Task 1。P2 额外加一个确定性的长度兜底。

**Files:**
- Modify: `action/src/lib/expert-runner.ts`（两个契约常量 + 标题归一化）
- Modify: `action/src/lib/verifier-client.ts`（`VERIFIER_SYSTEM_PROMPT`）
- Modify: `action/src/lib/expert-runner.test.ts` / `verifier-client.test.ts`

**Step 1: 写失败测试**

```typescript
it('includes the title and language contracts in the expert system prompt', async () => {
  const client = { sendStructuredRequest: vi.fn().mockResolvedValue(makeExpertOutput()) };
  await runExpert({ /* … */ client });
  const sent = client.sendStructuredRequest.mock.calls[0]?.[0] as { systemPrompt: string };
  expect(sent.systemPrompt).toContain('简体中文');
  expect(sent.systemPrompt).toContain('title');
});

it('truncates an over-long title instead of rejecting the whole response', async () => {
  // 实测第 6 轮的真实标题，把自问自答写进了 title
  const longTitle = 'Non-progress lines from git stderr written verbatim into a predictable? no, mktemp temp log then catted';
  /* …让 client 返回带该 title 的 candidate… */
  expect(result.output.candidate_findings[0]?.title.length).toBeLessThanOrEqual(80);
});
```

**Step 2: 确认失败**

**Step 3: 实现**

`expert-runner.ts` 在 `SCOPE_CONTRACT` 之后加两个常量，并加进 `buildExpertSystemPrompt` 的数组：

```typescript
// title 是给人扫一眼用的，不是草稿纸。实测里出现过
// 「…written verbatim into a predictable? no, mktemp temp log then catted」
// 和「…fetched counter consistent. However FAILURE path…」这种把自问自答写进
// 标题的情况。同一批数据里还出现了「先给 high、正文推翻自己、severity 不回改」，
// 所以这里把两件事绑在一起说。
const TITLE_AND_SEVERITY_CONTRACT =
  '`title` MUST be a single declarative sentence stating the defect, under 60 characters, ' +
  'with no question marks, no "however"/"but"/"no, actually", and no trace of your reasoning ' +
  'process. Write the title LAST, after you have settled on a conclusion. `severity` must ' +
  'match that same final conclusion — if your analysis ends with the code being correct, do ' +
  'not submit the finding at all, and never submit one whose `suggestion` is "无" / "无需修改" ' +
  '/ "none". A finding is a request for a change; if you are not requesting a change, there ' +
  'is no finding.';

// 实测：同一轮里 6 条 finding 有 3 条英文 3 条中文。审阅对象是中文项目，读的人
// 是中文使用者，混排纯粹增加阅读成本。
const OUTPUT_LANGUAGE_CONTRACT =
  'Write `title`, `evidence`, `impact` and `suggestion` in Simplified Chinese（简体中文）. ' +
  'Keep identifiers, file paths, commands and quoted code verbatim in their original form.';
```

标题长度兜底，放在 `fillMissingSourceAgent` 旁边，同样在 `validate` **之前**调用：

```typescript
// 给 title 一个**确定性上界**。刻意不写进 schema：schema 校验失败会让整个 shard
// 的响应作废、整轮判 incomplete（P6 就是这么来的），为了一个呈现问题去新增一条
// 失败路径不划算。这里只截断，不拒绝。
//
// 这是兜底不是修复 —— 真正让标题变好的是上面的 TITLE_AND_SEVERITY_CONTRACT，
// 截断只保证「再糟也糟不到哪去」。
const MAX_TITLE_CHARS = 80;

function clampTitles(raw: unknown): unknown { /* 取首行，超长则截到 79 + '…' */ }
```

`verifier-client.ts` 的 `VERIFIER_SYSTEM_PROMPT` 末尾追加：

```typescript
  ' Reject the finding outright if its own text concludes that the code is correct, or if its ' +
  '`suggestion` field does not actually ask for a change (for example "无", "无需修改", "none") — ' +
  'a finding that requests nothing is not a finding, regardless of how sound its analysis is.'
```

**Step 4-5: 验证并提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/expert-runner.ts action/src/lib/verifier-client.ts \
        action/src/lib/expert-runner.test.ts action/src/lib/verifier-client.test.ts action/dist
git commit -m "fix(prompts): 补标题/严重度/语言契约与 verifier 自我否定条款"
```

---

### Task 10: 堵死 cross-file 声明绕过锚点校验的后门（P11）

改动面小、无规格冲突，**建议与 Task 2 一起先做**。

**Files:**
- Modify: `action/src/lib/deterministic-evidence-validator.ts:33-35`
- Modify: `action/src/lib/deterministic-evidence-validator.test.ts`

**Step 1: 写失败测试**

```typescript
it('rejects a cross-file causal claim anchored outside any changed hunk', () => {
  expect(validateDeterministicEvidence(
    makeFinding({ cross_file_causal_claim: true, path: 'a.sh', line: 9999, side: 'RIGHT' }),
    'a.sh', [makeHunk({ newStart: 1, newLines: 10 })],
  ).status).toBe('failed');
});

it('rejects a cross-file causal claim anchored to side LEFT', () => {
  expect(validateDeterministicEvidence(
    makeFinding({ cross_file_causal_claim: true, side: 'LEFT', line: 3 }),
    'a.sh', [makeHunk({ newStart: 1, newLines: 10 })],
  ).status).toBe('failed');
});

it('still defers a properly anchored cross-file causal claim to the verifier', () => {
  expect(validateDeterministicEvidence(
    makeFinding({ cross_file_causal_claim: true, line: 3, side: 'RIGHT' }),
    'a.sh', [makeHunk({ newStart: 1, newLines: 10 })],
  ).status).toBe('deferred_to_verifier');
});
```

**Step 2: 确认失败**（前两条当前返回 `deferred_to_verifier`）

**Step 3: 实现**

把 `cross_file_causal_claim` 的早返回**从函数开头移到锚点检查通过之后**：

```typescript
  // …path / side / LEFT / hunk 范围四项检查原样保留，位置不动…

  for (const hunk of fileHunks) {
    if (isWithinChangedHunkRange(hunk, finding.side, finding.line)) {
      // 跨文件因果**声明**要交给 verifier 复核（设计文档 L87），但「锚点必须落在
      // 本次 diff 改过的行上」这条规则对它同样适用。原实现在任何检查之前就
      // return deferred，等于给了模型一条后门：只要声明 cross_file_causal_claim，
      // path/side/行号全都不再校验。实测里出现过正文整段分析 progress.sh、
      // 评论却挂在 bootstrap.sh:210 的 finding。
      //
      // 收紧的只是**锚点**，不是证据范围：跨文件证据继续走 causal_evidence_refs。
      return finding.cross_file_causal_claim === true
        ? { status: 'deferred_to_verifier' }
        : { status: 'passed' };
    }
  }

  return { status: 'failed', reason: /* …原样… */ };
```

**Step 4: 处理会变红的既有测试**

会变红的正好两条，**且都断言的正是本任务要堵的洞**，改用例：

- `deterministic-evidence-validator.test.ts:94`「defers cross-file causal claims to the verifier **without evaluating line rules**」（`fileHunks = []`）
- `deterministic-evidence-validator.test.ts:261`「跨文件调用链声明…」（注释明写「行号是越界的」）

`:272`「跨文件声明在确定性层永远拿不到 passed」改后仍然通过，**不要动它**。

若出现第三条变红的用例，先判断它断言的是不是合法场景——是就改实现，不是就改用例。不要为了让测试变绿而放宽被测的安全属性。

**Step 5: 提交**

```bash
cd action && npm test && npm run build && cd ..
git add action/src/lib/deterministic-evidence-validator.ts action/src/lib/deterministic-evidence-validator.test.ts action/dist
git commit -m "fix(validator): cross-file 声明不再绕过锚点校验"
```

---

### Task 11: 文档同步

**Files:**
- Modify: `docs/plans/2026-07-13-pr-review-swarm-design.md`（L152、L29、L304）← **Task 6 的规格变更**
- Modify: `action/test/integration/CHECKLIST.md`（对账项 6 在 `:19`）
- Modify: `CLAUDE.md` 与 `AGENTS.md`（两份必须逐字一致）
- Modify: `README.md`「当前阶段」

**Step 1: 设计文档**。L152 那句「任何最终 finding 都触发 `REQUEST_CHANGES`」改成带例外的表述，并写明例外的两个前提（incomplete + 全 low + 非硬上限）和理由。L29、L304 同口径跟改。

**Step 2: CHECKLIST**。`:19` 的对账项 6 随之更新；另加四条新对账项：自我否定门禁、incomplete→COMMENT 降级、已合并 PR 短路、横幅覆盖式 + 分页。

**Step 3: `CLAUDE.md` / `AGENTS.md`**。「当前落地」表加一行实测结论，「下一步」按本计划落地情况重排。**不要把这两个文件写成活动日志**——只动「当前落地」和「下一步」两节。

**Step 4: `README.md`**「当前阶段」补一句外部真实 PR 实测的结论与报告链接。

**Step 5: 跑文档一致性测试**

```bash
cd action && npx vitest run test/docs-consistency.test.ts
```
预期：PASS。规格文档里若写了「机器人会提交 APPROVE」这类句子会让它变红——本计划没有引入 APPROVE，若变红说明措辞写歪了。

**Step 6: 提交**

```bash
git add docs/plans/2026-07-13-pr-review-swarm-design.md action/test/integration/CHECKLIST.md \
        CLAUDE.md AGENTS.md README.md
git commit -m "docs: 同步 PR#9 实测结论与 review event 规格变更"
```

---

### Task 12: 评测验证

**先单用例、再全量。评测花钱：`--gate --repeat=3` 全量约 \$0.07、约 17 分钟。**

脚本是 `benchmarks/run-evaluation.mjs`（不是 `run.mjs`）。

**Step 1: 方差回归（验证 Task 5）**

```bash
cd benchmarks && node run-evaluation.mjs --case=<与 Task 5 Step 0 同一个用例> --repeat=3
```
拿 `instability`（`run-evaluation.mjs:164` 的 `findingSetInstability`）与 Task 5 Step 0 记下的基线对照。预期显著下降。若下降明显，考虑收紧 `thresholds.json:17` 的 `max_finding_set_instability: 0.35`——**改阈值必须有全量数据支撑**。

**Step 2: 噪声回归（验证 Task 1）**

确认自我否定样本不再出现在最终 findings 里，`internalDiagnostics` 里能看到 `rejected_self_refuted`。
注意 `run-evaluation.mjs:209` 的候选归宿打印**只在 `recall < 1` 时输出**，召回满分的用例看不到该计数——要么挑一个召回不满分的用例观察，要么临时改打印条件。

**Step 3: 全量门禁**

```bash
cd benchmarks && node run-evaluation.mjs --gate --repeat=3
```
预期：召回不低于既有基线（88.9%–91.4%），`incomplete` 比例显著低于此前，陷阱命中 0。

**Step 4: 按数据决定两个阈值**

- 若全量陷阱为 0，按 CLAUDE.md 既定计划删掉 `benchmarks/thresholds.json` 的 `max_must_not_find_hits`（缺键回落到 0）。**没有全量数据时不要动。**
- 若 Step 1 显示方差大幅下降，再决定 `maxExpertSchemaRetries` 该不该从 1 调整（Task 3 刻意没动它）。

**Step 5: 提交**

```bash
git add benchmarks/thresholds.json action/config/central-limits.json
git commit -m "chore(benchmarks): 按全量数据更新门槛"
```

> 不要用 `workflow_dispatch` 触发 nightly（当前 token 缺该权限）；全量评测走临时 `pull_request` workflow，用完即删。

---

### Task 13: 发布

**Step 1:** `git status` 干净、`cd action && npm test` 全绿、`npm run build` 后 `dist/` 无漂移、`cd cli && npm test` 全绿。

**Step 2:** 内部 `uses:` 重钉：

```bash
node scripts/repin.mjs <本轮最终 commit sha>
```
**禁止手工改一半。** 使用方 caller 钉 `v1` 是刻意例外，不要动。

**Step 3:**

```bash
git add .github/workflows
git commit -m "chore(release): pin action refs to <sha> for v1.2.0"
```

---

## 验收标准

逐条对应实测报告的 P 编号。**每一条都要有证据，不要凭「代码看起来对了」就打勾。**

| 编号 | 验收 | 怎么证明 |
|---|---|---|
| P1 | 自我否定 finding 不再发布，且真缺陷不被误杀 | `self-refutation-gate.test.ts` 16 条全绿，**3 条反例是硬门槛**；评测里 `rejected_self_refuted` 有计数 |
| P2 | 标题有契约且有确定性上界 | prompt 断言 + 截断测试全绿 |
| P5 | 输出语言固定 | prompt 断言全绿；全量评测输出人工抽查 |
| P6 | `source_agent` 与 verifier schema 抖动不再整轮报废，且确定性失败不重试 | Task 2/3 的 6 条新单测全绿；全量评测 incomplete 比例低于此前 |
| P6' | 单 agent 失败只跳过该 agent，连续 3 次熔断，skill 加载失败仍立即停 | `analyze.test.ts` 三条新用例全绿，`:371` 保持通过 |
| P7 | incomplete + 全 low + 非硬上限 → COMMENT | `verdict.test.ts` 五条新用例 + 改写后的穷举不变式全绿 |
| P8 | 横幅不再堆叠，且第 31 条以后的评论也被处理 | `applySupersedeNotice` 五条单测（含 17 行堆叠、两种文本、分页）全绿；下一次真实多轮审核后人工确认 |
| P9 | 已合并 PR 不再触发（模板与 action 双防线） | `status-start.test.ts` 三条新用例全绿；`cli/` 模板测试全绿 |
| P10 | 同输入方差下降 | Task 5 Step 0 与 Task 12 Step 1 的 `instability` 前后对照 |
| P11 | cross-file 不再绕过锚点校验 | `deterministic-evidence-validator.test.ts` 三条新用例全绿，`:272` 保持通过 |
| P3 部分 / P4 / P12 | **本计划不做** | 见「不在本计划内的」——等 Task 12 数据出来再定 |

---

## 审阅遗留

v2 已吸收子 Agent 审阅的全部 5 条阻断和 11 条修正项。审阅中**核对无误、明确不需要改**的部分（记在这里，避免后续重复排查）：

- 根因表的全部代码定位（文件:行号、字段名、配置键名）逐条核过，与实际代码一致。
- Task 8 的可行性成立：`pulls.get` 返回值确实含 `state` / `merged`；新增并列返回不碰 `IdentityTuple`，`schemas/verdict.schema.json:8-22` 的约束不受影响；`gate_passed: false` 能正确短路（`reusable-pr-review.yml:48/107/134`），`neutral` 结论不会留孤儿 Check。
- Task 1 的新 outcome 取值不撞任何 schema：`InternalDiagnosticOutcome` 是纯 TS 联合类型，`analyze.ts:392` 只是序列化，`run-evaluation.mjs:212` 用 Map 聚合。
- Task 6 不会丢 incomplete 免责横幅（`publish.ts:407-410` 只看 verdict），Check 结论也不变（`status-finalize.ts:26-27`）。
- Task 7 的正则对线上两种真实横幅（含 17 行堆叠）都成立，前提是夹具用真实的 20 位 hex id。
- Task 5 无模型兼容性风险：`allowed-models.json` 只放行 `deepseek-chat`。
- **没有任何任务放宽 workflow / permissions / Secret 边界**：`permissions: {}` 未被触碰，DeepSeek Secret 未流向 publish，没有引入 PR head checkout，没有把可变 tag 写进内部 `uses:`。硬禁令 1-7、9 无问题；硬禁令 8 的语义边界由 Task 6 的 `hard_limit_hit` 排除条件守住。
