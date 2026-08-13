# 回归评测门槛定基线 + arbiter 去重修复 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `benchmarks/thresholds.json` 的六个门槛值第一次建立在实测分布上，并修掉一个让误报数虚高的去重缺陷，使 nightly 的回归评测成为一条真正能拦住劣化的护栏。

**Architecture:** 三步走——先修 `arbiter.ts` 的去重键（它是当前误报数虚高的主因，修完误报可能自然达标，门槛就不必一开始就放宽）；再跑一次全量评测拿到干净分布；最后按分布定门槛，并把两个确认属于模型能力范畴的问题开成 issue 单独跟踪。

**Tech Stack:** Node 24、TypeScript、vitest（`action/`）、`.mjs` + vitest（`benchmarks/`）、GitHub Actions、DeepSeek API（`deepseek-chat`）。

---

## 背景：两轮全量评测的实测数据

27 个用例 × 3 轮，`deepseek-chat`，每轮约 357 次请求、总花费约 $0.07。

| 指标 | 第一轮（无 context） | 第二轮（补齐 context） | 当前门槛 | 达标 |
|---|---|---|---|---|
| 召回率 | 80.2% | **91.4%** | ≥80% | ✓ |
| 误报（最差一轮） | 5 | 5 | ≤2 | ✗ |
| 陷阱命中 | 1 | 1 | 0 | ✗ |
| incomplete 比例 | 1.2% | **0.0%** | ≤10% | ✓ |
| 结果抖动 | 0.332 | **0.168** | ≤0.2 | ✓ |
| p95 端到端延迟 | 31.2s | 31.7s | ≤300s | ✓ |
| 成本/PR | $0.0027 | $0.0029 | ≤$0.5 | ✓ |

已在前序 commit 修掉并复测的三个缺陷：`#9`（模型无行号锚点）、`#10`（畸形 tool-call 不重试）、评测层拿自由文本 `category` 做精确匹配。补齐 23 份 `context/` 全文后召回率 +11.2pp、抖动减半——原先那 0.332 里有一半是 verifier 因「拿不到文件内容」随机拒绝造成的**假**抖动。

### 关键发现：误报虚高的主因是 arbiter 去重失效

`action/src/lib/arbiter.ts:41` 的去重键是：

```ts
function groupKey(finding: CandidateFinding): string {
  return `${finding.path}|${finding.line}|${finding.category}`;
}
```

而 `category` 在 `schemas/candidate-finding.schema.json` 里是 `{"type":"string","minLength":1}`——**自由文本**，设计文档 L139 也写明它「仅用于排序、呈现和统计，不决定是否阻塞」。用它做去重键的结果，在第二轮实测里直接可见：

```
hardcoded-credential: internal/notify/webhook.go:9 [hardcoded credential]（1/3 轮）
hardcoded-credential: internal/notify/webhook.go:9 [hardcoded-credential]（1/3 轮）
```

同一行、同一个问题，**只差一个连字符**，就绕过了去重，变成两条独立 finding。更密集的例子：

```
go-goroutine-leak: internal/worker/pool.go:15 [concurrency]
go-goroutine-leak: internal/worker/pool.go:15 [concurrency-race]
go-goroutine-leak: internal/worker/pool.go:15 [unbounded-goroutines-and-channel-deadlock]
go-goroutine-leak: internal/worker/pool.go:15 [unnecessary-complexity]

go-missing-error-check: pkg/service/user.go:18 [logic-edge-cases]
go-missing-error-check: pkg/service/user.go:18 [API design / error handling]
go-missing-error-check: pkg/service/user.go:18 [Style / convention consistency]
go-missing-error-check: pkg/service/user.go:18 [maintainability]
```

**用户侧的后果**：同一行代码收到 4 条 inline 评论。这不只是让评测数字难看，它本身就是这个产品最招人烦的失败模式。

**对门槛的影响**：所以「误报 5」里相当一部分不是模型报错了 5 个不同问题，而是同一问题的重复条目。在修掉去重之前按 5 定门槛，等于把一个 bug 的后果固化成验收标准。

> **与既有决策的关系**：上一轮讨论选定的是「按现状定门槛、问题另开 issue」。那个选择基于当时的信息——两项超标都被判为模型能力问题。现在证据变了：误报超标有一个明确的、改动很小的代码根因。所以本计划把「修去重」放在「定门槛」之前（Task 1 → Task 3）。如果实测证明修完仍然超标，Task 3 仍会按现状定，决策本身不变，只是先排除掉一个已知 bug 的干扰。

---

## 执行者须知（Repo conventions）

写第一行代码前必读：

1. **测试文件位置**：单元测试与被测模块同目录同名（`action/src/lib/arbiter.ts` → `arbiter.test.ts`）；跨入口的集成测试放 `action/test/integration/`。
2. **运行命令**：`cd action && npm test`；单文件 `npx vitest run src/lib/arbiter.test.ts`；单用例加 `-t "用例名"`。`benchmarks` 同理（`cd benchmarks && npm test`）。
3. **硬禁令**：改任何 workflow / action 代码前先读 `docs/AGENTS.md`（8 条硬禁令）。不要为了让测试通过而放宽被测的安全属性。
4. **`dist/` 必须同步**：任何改到 `action/src/` 的任务，commit 前跑 `cd action && npm run build` 并把 `dist/` 一并提交，否则 CI 的 `build-dist-no-drift` 会红。
5. **每个 Task 一次 commit**，前缀用 `fix:` / `test:` / `ci:` / `docs:`。
6. **评测会真的花钱**。`--gate --repeat=3` 全量一次约 $0.07、耗时约 17 分钟。不要为了「看一眼」反复全量跑；单用例调试用 `--case=<name> --repeat=2`。
7. **不要用 workflow_dispatch 触发 nightly**：当前 token 缺该权限（403）。全量评测通过临时 workflow 走 `pull_request` 事件，用完即删。

---

## Task 1：arbiter 去重键去掉自由文本 category

**Files:**
- Modify: `action/src/lib/arbiter.ts:40-42`（`groupKey`）
- Modify: `action/src/lib/arbiter.test.ts`（追加一组）
- Rebuild: `action/dist/index.js`

**Step 1: 写失败测试**

追加到 `action/src/lib/arbiter.test.ts` 末尾。先看文件里现有的候选构造 helper（大概叫 `confirmed(...)` 或类似），复用它，不要另造一套：

```ts
describe('去重键不含自由文本 category', () => {
  it('同一位置、category 措辞不同的候选被合并成一条', () => {
    // 实测语料：模型在同一行报出 "hardcoded credential" 与 "hardcoded-credential"，
    // 只差一个连字符。category 在 schema 里是自由文本（设计文档 L139：仅用于排序、
    // 呈现和统计），拿它做去重键，用户就会在同一行收到多条重复评论。
    const { findings, internalDiagnostics } = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'hardcoded credential' }),
      confirmedCandidate({ id: 'b', path: 'a.go', line: 9, category: 'hardcoded-credential' }),
    ]);

    expect(findings).toHaveLength(1);
    expect(internalDiagnostics.filter((d) => d.outcome === 'merged_into')).toHaveLength(1);
  });

  it('同一行的四条不同措辞全部合并（实测 go-goroutine-leak 的形态）', () => {
    const { findings } = arbitrate(
      ['concurrency', 'concurrency-race', 'unbounded-goroutines', 'unnecessary-complexity'].map(
        (category, i) =>
          confirmedCandidate({ id: `c${i}`, path: 'pool.go', line: 15, category }),
      ),
    );

    expect(findings).toHaveLength(1);
  });

  it('不同行仍然各自成条——合并只在同一位置发生', () => {
    const { findings } = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'b', path: 'a.go', line: 20, category: 'x' }),
    ]);

    expect(findings).toHaveLength(2);
  });

  it('不同文件的同一行号不合并', () => {
    const { findings } = arbitrate([
      confirmedCandidate({ id: 'a', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'b', path: 'b.go', line: 9, category: 'x' }),
    ]);

    expect(findings).toHaveLength(2);
  });

  it('合并后保留的代表条目在 internalDiagnostics 里可追溯', () => {
    // 合并不能是静默丢弃：被合并掉的那条要能在诊断里查到去向，
    // 否则「模型报了但用户没看到」就成了一个查不出的黑洞。
    const { findings, internalDiagnostics } = arbitrate([
      confirmedCandidate({ id: 'keep', path: 'a.go', line: 9, category: 'x' }),
      confirmedCandidate({ id: 'gone', path: 'a.go', line: 9, category: 'y' }),
    ]);

    const merged = internalDiagnostics.find((d) => d.id === 'gone');
    expect(merged?.outcome).toBe('merged_into');
    expect(merged?.mergedIntoId).toBe(findings[0]!.id);
  });
});
```

**Step 2: 运行测试确认失败**

Run: `cd action && npx vitest run src/lib/arbiter.test.ts -t "去重键不含自由文本"`
Expected: 前两条 FAIL（`expected 2 to be 1` / `expected 4 to be 1`），后三条应当已经 PASS（它们锁的是不该被改掉的行为）。

**Step 3: 改实现**

`action/src/lib/arbiter.ts`：

```ts
// 去重键刻意**不含** category。它在 candidate-finding.schema.json 里是
// `{"type":"string","minLength":1}` 自由文本，设计文档 L139 也写明「severity、
// confidence、category 仅用于排序、呈现和统计，不决定是否阻塞」——拿一个模型每次
// 措辞都可能不同的字段做去重键，等于没有去重。
//
// 实测（2026-08-13 全量评测）：模型在同一行分别报出 "hardcoded credential" 与
// "hardcoded-credential"，只差一个连字符就产生了两条 finding；go-goroutine-leak
// 的第 15 行拿到四条不同措辞。用户侧的后果是同一行收到多条重复 inline 评论，
// 这本身就是这个产品最招人烦的失败模式。
//
// 代价是同一行上两个**真正不同**的问题会被并成一条。这个取舍是有意的：一行代码
// 同时存在两个独立缺陷远比措辞抖动罕见，而重复评论是用户每次都会看到的。被合并
// 掉的条目在 internalDiagnostics 里带 mergedIntoId，不会静默消失。
function groupKey(finding: CandidateFinding): string {
  return `${finding.path}|${finding.line}`;
}
```

**Step 4: 运行测试确认通过**

Run: `cd action && npx vitest run src/lib/arbiter.test.ts`
Expected: 全部 PASS。若有既有测试因为「同一行不同 category 应产出两条」而红，**先读那条测试的意图**：如果它锁的正是旧去重语义，按本 Task 的理由更新它并在注释里写明；如果它锁的是别的属性（比如 severity 选择），那是真回归，改实现别改测试。

**Step 5: 全量回归 + 重建 dist**

Run:
```bash
cd action && npm run lint && npm run typecheck && npm test && npm run build
```
Expected: lint/typecheck 无输出，测试全绿（当前基线 759 + 新增 5），build 产出 `dist/index.js`。

**Step 6: Commit**

```bash
git add action/src/lib/arbiter.ts action/src/lib/arbiter.test.ts action/dist
git commit -m "fix: arbiter 去重键去掉自由文本 category，同一行不再重复报"
```

---

## Task 2：拿修复后的干净分布

**Files:**
- Create（临时）: `.github/workflows/tmp-eval-full.yml`

**Step 1: 建临时 workflow**

内容与 `nightly.yml` 的 `evaluation` job 完全一致，只把触发方式换成 `pull_request`（nightly 的 `workflow_dispatch` 需要当前 token 没有的权限）：

```yaml
name: TMP Eval Full
on:
  pull_request
permissions:
  contents: read
env:
  NPM_CONFIG_FETCH_RETRIES: '5'
  NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '10000'
  NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '120000'
  NPM_CONFIG_FETCH_TIMEOUT: '600000'
jobs:
  full-evaluation:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: action/package-lock.json
      - name: Install action deps
        run: npm ci
        working-directory: action
      - name: Install benchmark deps
        run: npm ci
        working-directory: benchmarks
      - name: Full regression evaluation (gated)
        working-directory: benchmarks
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        run: node run-evaluation.mjs --gate --repeat=3
```

**Step 2: actionlint 校验后推送**

Run: `actionlint .github/workflows/tmp-eval-full.yml && git add -A && git commit -m "tmp: 跑全量评测取修复后分布（拿到数据后删除）" && git push`
Expected: actionlint 无输出；push 成功。

**Step 3: 等结果并取数**

Run: `gh run list --branch <branch> --workflow="TMP Eval Full" --limit 1 --json databaseId,status`
然后挂一个 Monitor 轮询到 `completed/*`（约 17 分钟）。**不要**用 `sleep` 链式等待。

取数：
```bash
gh run view <id> --log > /tmp/eval3.log
sed 's/^[^\t]*\t[^\t]*\t[0-9T:.Z-]* //' /tmp/eval3.log | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -E "用例 |召回 |召回率 |误报（最差|陷阱命中|incomplete 比例|结果抖动|p95 |成本/PR|未对上|^    [a-z]|    - "
```

`--gate` 预期仍以退出码 1 结束（陷阱命中 1 那条一定还在），job 会显示红色。**要的是数据，不是绿灯。**

**Step 4: 判断去重是否生效**

对照 Task 1 之前的数据。预期变化：
- 「未对上」清单里同一 `path:line` 的多条应当收敛成一条；
- 误报（最差一轮）应当明显下降；
- 召回率不应下降（合并只发生在同一位置，不影响能否命中 expected）。

若召回率反而掉了，说明合并把该命中的那条并掉了——那是 Task 1 的回归，回去查 `pickRepresentative` 选的是哪一条，而不是在这里放宽门槛。

**Step 5: 不 commit，进 Task 3**

数据记在手边即可，临时 workflow 到 Task 5 统一删。

---

## Task 3：按实测分布定门槛

**Files:**
- Modify: `benchmarks/thresholds.json`

**Step 1: 按下表填值**

用 Task 2 的实测值，每一项都按「实测 + 留余量」定，并在 `_comment` 里写下依据。原则：

- **门槛的作用是拦住劣化，不是标记理想状态。** 定成刚好卡住当前值会让 nightly 因正常波动天天红；定得太松则失去护栏作用。留一档余量。
- **有数据支撑的项按数据定**：召回率、误报、抖动。
- **余量极大的项不动**：延迟（31.7s vs 300s）、成本（$0.0029 vs $0.5）保持原值——它们盯的是「量级劣化」，不需要贴着实测收紧。
- **陷阱命中保持 0**。它命中意味着模型把历史遗留问题当成本次引入的缺陷报了出来，那是设计意图明确禁止的行为（见 Task 4 的 issue）。这一项**不放宽**，代价是 nightly 会红到该问题修完为止——这正是它该有的样子。

建议值（`X` 用 Task 2 实测替换）：

| 键 | 现值 | 建议 | 依据 |
|---|---|---|---|
| `min_recall` | 0.8 | `0.85` | 实测 91.4%，留 ~6pp 波动余量 |
| `max_false_positives` | 2 | Task 2 实测 + 1 | 去重修复后的实测值 |
| `max_incomplete_ratio` | 0.1 | `0.05` | 实测 0.0%，`#10` 修完后未再复现 |
| `max_p95_latency_ms` | 300000 | 不变 | 实测 31.7s，量级余量充足 |
| `max_cost_usd_per_pr` | 0.5 | 不变 | 实测 $0.0029，量级余量充足 |
| `max_finding_set_instability` | 0.2 | 不变 | 实测 0.168，已达标且余量合适 |
| `line_tolerance` | 2 | 不变 | 与 `metrics.mjs` 的匹配规则配套 |

**Step 2: 在 `_comment` 里记下基线出处**

必须写清楚这些数字是**哪一次运行**定出来的，否则半年后没人知道该不该改：

```json
"_comment": "门槛基线来自 2026-08-13 的全量评测（27 用例 × 3 轮，deepseek-chat，
见 docs/plans/2026-08-13-threshold-baseline-and-dedup-fix.md）。实测：召回 X%、
误报 X、抖动 X、incomplete X%、p95 X ms、成本 $X。定值原则是「拦住劣化」而非
「标记理想状态」，每项留一档波动余量；延迟与成本余量本就有两个量级，不贴着实测
收紧。max_false_positives 与陷阱命中是硬门槛——误报是这个产品的头号杀手。"
```

**Step 3: 跑 benchmarks 单测**

Run: `cd benchmarks && npm test`
Expected: 全绿（当前基线 311）。thresholds 只被 `run-evaluation.mjs` 读，改值不该让任何单测红；如果红了，说明有测试硬编码了门槛值，去掉那处耦合。

**Step 4: Commit**

```bash
git add benchmarks/thresholds.json
git commit -m "test: 门槛按 2026-08-13 全量评测的实测分布定基线"
```

---

## Task 4：把两个模型能力问题开成 issue

这两项确认不是管线缺陷，改动范围在 prompt / skill，属于独立工程，不塞进本轮。

**Step 1: 开 issue「retain cycle 类缺陷识别率过低」**

数据（第二轮全量，补齐 context 之后）：

- `swift-retain-cycle`：召回 **0%**，三轮全部未报出，且零误报——模型完全没识别 `loader.delegate = self` 造成的强引用环。
- `objc-retain-cycle-block`：召回 **33.3%**（1/3 轮），`rejected_verifier=1 confirmed=1`。

这两条是本用例集里最差的。`skills/swift-review.md` 的 checklist 需要针对 retain cycle 补具体判据（delegate 属性未用 `weak`、block 内直接捕获 `self`、`[weak self]` 缺失），而不是笼统写「注意内存管理」。

**Step 2: 开 issue「模型不区分本次引入与历史遗留」**

`historical-todo-in-touched-file` 用例的陷阱被稳定命中（1/1）：模型报出了文件里那条 2019 年的 TODO，而该 TODO 与本次改动无关。

设计文档 L139 之外，`buildExpertSystemPrompt` 已经写了「Only report issues introduced, exposed, expanded, or made reachable by this PR」，但实测不足以约束住。这条同时也是 `max_false_positives` 之外唯一还超标的门槛项，修掉它 nightly 才能转绿。

可能方向：shard 内容里已经用 `+` 标了新增行，可以在 prompt 里把「只有带 `+` 的行可以作为 finding 锚点，未标记的行属于既有代码」这条讲得更硬——注意 `#9` 已经建立了行号契约，这里是在同一个位置加一条语义约束。

**Step 3: 无需 commit**

issue 只在 GitHub 上，不落仓库文件。用 `gh issue create`；若 token 缺 `issues: write`（历史上出现过 `addComment` 403），改为在 PR #8 评论里记录并注明原因。

---

## Task 5：清理与文档对账

**Files:**
- Delete: `.github/workflows/tmp-eval-full.yml`
- Modify: `action/test/integration/CHECKLIST.md`
- Modify: `README.md`

**Step 1: 删临时 workflow**

Run: `git rm .github/workflows/tmp-eval-full.yml`

**Step 2: 更新 CHECKLIST**

在「首轮真实模型评测已跑过」那一节之后追加本轮结果，需要写清：

- 两轮 → 三轮的指标演进表（无 context / 补 context / 修去重）；
- arbiter 去重缺陷的发现过程与取舍（同一行两个真问题会被并掉，这是有意的）；
- 门槛基线的定值原则与出处；
- 仍然超标的项（陷阱命中）及其对应 issue 编号，**不要写成「已完成」**。

**Step 3: 更新 README 的现状描述**

当前那句「审核质量还在建立基线的阶段」要按事实更新：基线已经建立，但 retain cycle 识别与历史遗留区分两项已知不足，指向对应 issue。

**Step 4: 全量验证**

Run:
```bash
cd action && npm run lint && npm run typecheck && npm test
cd ../cli && npm test
cd ../benchmarks && npm test
cd .. && actionlint .github/workflows/*.yml
cd action && npm run build && cd .. && git status --porcelain -- action/dist
```
Expected: 三个包全绿；actionlint 无输出；`dist` 无漂移（最后一条命令无输出）。

**Step 5: Commit**

```bash
git add -A
git commit -m "docs: 记录门槛基线的定值依据，并如实标注仍超标的一项"
```

---

## Task 6：合并与发布

**Step 1: 确认 CI 全绿**

Run: `gh pr view 8 --json statusCheckRollup --jq '[.statusCheckRollup[] | {name, conclusion}]'`
Expected: 8 个 CI job 全 SUCCESS。`PR Review Swarm / verdict` 可能仍是 `ACTION_REQUIRED`/失败——那是机器人自己的审核结论，不是 CI 门禁，按内容判断是否需要处理。

**Step 2: 合并 PR #8**

历史里有 5 个 `tmp:` commit（临时 workflow 的增删）。**建议 squash merge**，它们的净变更为零，squash 后历史干净。若要保留逐条历史，需要先 `git push --force-with-lease` 折叠——那需要用户显式授权（此前该操作被权限策略拦过）。

**Step 3: 发布 `v1`（需要用户确认）**

两件仍未处理的事，都要推 tag 到远端，属于对外动作，**必须先确认**：

- `v1` tag 目前**根本不存在**，而 README 和 CLI 默认写入的 workflow 都钉在 `v1` 上——按文档部署到目标仓库会直接解析失败。
- 内部 pin 落后 HEAD 十几个提交，`#9` / `#10` / 去重修复都不在已发布的 action 里。

Run（确认后）: `node scripts/release.mjs 1.0.0` 先本地看效果，确认无误再 `node scripts/release.mjs 1.0.0 --push`。

---

## 附录：不在本计划内的部分

- **计划附录 A 的 5 项沙盒人工验证**仍未覆盖（fork PR 的真实凭据可见性、分支保护真实拒绝 dismiss、`cancel-in-progress` 真实时序、required check 真实门禁、真实模型在注入语料下的行为）。理由不变：需要真实 GitHub 环境。
- **误报的深层治理**。Task 1 只修去重造成的重复。修完若仍高于理想值，剩下的是「找到真问题时顺手多报几条低价值条目」——那需要在 skill checklist 里加严重性下限，是独立工程。注意 14 个真阴性用例里 13 个是零误报，说明模型并非无差别乱报。
- **`swift-retain-cycle` 等用例的召回**归 Task 4 的 issue，不在本轮修。
