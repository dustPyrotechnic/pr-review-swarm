import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCase, toPrepareArtifact } from './case-loader.mjs';
import { loadPipeline } from './pipeline.mjs';

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases');

const CASE_NAMES = readdirSync(CASES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// fixture 的**书写约定**，不是系统契约：`candidate-finding.schema.json` 里
// category 是自由文本，评测的匹配也不看它（见 metrics.mjs 的 matches）。
// 保留这条断言只为让用例集里的说明性标签保持统一、便于阅读——绝不能反过来
// 被读成「模型必须返回这三个词之一」，模型实测返回的是
// `error-handling`、`Race condition on delegate access` 这类自由措辞。
const FIXTURE_CATEGORY_VOCABULARY = new Set(['correctness', 'security', 'maintainability']);

let pipeline;
let loaded;

beforeAll(async () => {
  pipeline = await loadPipeline();
  loaded = new Map(CASE_NAMES.map((name) => [name, loadCase(join(CASES_DIR, name))]));
}, 60_000);

/**
 * 用例集自身的守恒检查。
 *
 * 一条写错的 fixture 不会报错，它只会安静地拉低召回率——然后有人去调 prompt，
 * 试图修一个根本不在模型那边的问题。这一组测试把"用例写错"和"模型变差"分开。
 */
describe('benchmark 用例集', () => {
  it('至少有 20 个用例', () => {
    expect(CASE_NAMES.length).toBeGreaterThanOrEqual(20);
  });

  it('真阴性用例数不少于真阳性（计划要求的 1:1 误报陷阱密度）', () => {
    let positives = 0;
    let negatives = 0;
    for (const c of loaded.values()) {
      if (c.expected.some((e) => e.must_find)) positives += 1;
      else negatives += 1;
    }

    // 只堆真阳性会让召回率好看，而误报率——这个产品真正的死因——无人度量。
    expect(negatives).toBeGreaterThanOrEqual(positives);
  });

  it.each(CASE_NAMES)('%s: expected 的 category 在三个 agent 的范围内', (name) => {
    for (const e of loaded.get(name).expected) {
      expect(
        FIXTURE_CATEGORY_VOCABULARY,
        `${name} 的 category "${e.category}"（fixture 书写约定，不是模型契约）`,
      ).toContain(e.category);
    }
  });

  it.each(CASE_NAMES)('%s: diff 能被生产 parsePatch 解析出内容', (name) => {
    const c = loaded.get(name);
    expect(c.files.length).toBeGreaterThan(0);

    for (const f of c.files) {
      const parsed = pipeline.parsePatch(f.path, f.patch);
      if (f.patch === '') {
        // 纯 rename / 二进制：没有 hunk 是正确的。
        expect(parsed.hunks).toEqual([]);
      } else {
        expect(parsed.hunks.length, `${name} 的 ${f.path}`).toBeGreaterThan(0);
      }
    }
  });

  it.each(CASE_NAMES)('%s: 每个 @@ 头声明的行数与 hunk 实际行数一致', (name) => {
    // 确定性证据校验器按 `newStart + newLines - 1` 卡上界，所以 newLines 少写一行，
    // hunk 最后一行就会被判成「不属于本次 diff 修改的范围」。这类错误不报错、
    // 不影响解析、只会让某些 expected 永远无法命中 —— 表现为召回率莫名偏低。
    //
    // 这条断言覆盖全部用例，包括那些会被分类器跳过的（lockfile / vendor /
    // 生成文件）：它们不走行号校验，正因如此才最容易把计数错误藏到没人看见。
    for (const file of loaded.get(name).files) {
      if (file.patch === '') continue;

      for (const hunk of splitHunks(file.patch)) {
        const declared = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(hunk.header);
        expect(declared, `${name} 的 ${file.path}: hunk 头缺少行数 → ${hunk.header}`).not.toBeNull();

        const actualOld = hunk.context + hunk.deleted;
        const actualNew = hunk.context + hunk.added;
        expect(
          [Number(declared[2]), Number(declared[4])],
          `${name} 的 ${file.path} @@ ${hunk.header}：声明 old=${declared[2]} new=${declared[4]}，` +
            `实际 old=${actualOld} new=${actualNew}`,
        ).toEqual([actualOld, actualNew]);
      }
    }
  });

  it.each(CASE_NAMES)('%s: must_find 的行号必须能通过确定性证据校验', (name) => {
    const c = loaded.get(name);
    const mustFind = c.expected.filter((e) => e.must_find);
    if (mustFind.length === 0) return;

    for (const e of mustFind) {
      const file = c.files.find((f) => f.path === e.path);
      const hunks = pipeline.parsePatch(file.path, file.patch).hunks;
      const result = pipeline.validateDeterministicEvidence(
        { path: e.path, line: e.line, side: 'RIGHT' },
        e.path,
        hunks,
      );

      // 校验器挡掉的行，模型就算报对了也进不了 findings——这条用例是死的，
      // 只会永远贡献一次漏报。
      expect(result.status, `${name} expected ${e.path}:${e.line} → ${result.reason ?? ''}`).toBe(
        'passed',
      );
    }
  });

  it.each(CASE_NAMES)('%s: must_not_find 要么落在可审范围内，要么该文件本就被跳过', (name) => {
    const c = loaded.get(name);
    const trap = c.expected.filter((e) => !e.must_find);
    if (trap.length === 0) return;

    const artifact = buildArtifact(c);
    const reviewedPaths = new Set(
      artifact.coverage_manifest.files.filter((f) => f.treatment === 'reviewed').map((f) => f.path),
    );

    for (const e of trap) {
      if (!reviewedPaths.has(e.path)) {
        // 被分类器跳过（lockfile / vendor / 生成文件 / 纯 rename）——
        // 陷阱由"根本不送给模型"这条路径守住，不需要行号落在 hunk 内。
        continue;
      }
      const file = c.files.find((f) => f.path === e.path);
      const hunks = pipeline.parsePatch(file.path, file.patch).hunks;
      const result = pipeline.validateDeterministicEvidence(
        { path: e.path, line: e.line, side: 'RIGHT' },
        e.path,
        hunks,
      );

      // 一个"模型物理上报不出来"的陷阱不构成任何证据。它必须是可达的，
      // 否则这条真阴性用例只是在给自己发免费的及格分。
      expect(result.status, `${name} 陷阱 ${e.path}:${e.line} → ${result.reason ?? ''}`).toBe(
        'passed',
      );
    }
  });

  it.each(CASE_NAMES)('%s: 能组装出可被 runAnalysis 消费的 artifact', (name) => {
    const artifact = buildArtifact(loaded.get(name));

    expect(artifact.identity_tuple.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.coverage_manifest.hard_limit_hit).toBe(false);
    // 覆盖清单守恒：diff 里的每个文件都要留痕，不管审没审。
    const manifestPaths = artifact.coverage_manifest.files.map((f) => f.path).sort();
    const diffPaths = loaded.get(name).files.map((f) => f.path).sort();
    expect(manifestPaths).toEqual(diffPaths);
  });

  it('被分类器跳过的用例确实走的是跳过路径，而不是碰巧没有 hunk', () => {
    const expectations = [
      ['lockfile-only-change', 'package-lock.json', 'skipped_lockfile'],
      ['vendor-dependency-update', 'vendor/github.com/pkg/errors/errors.go', 'skipped_vendor'],
      ['generated-file-changed', 'api/gen/service.pb.go', 'skipped_generated'],
    ];

    for (const [name, path, treatment] of expectations) {
      const artifact = buildArtifact(loaded.get(name));
      const entry = artifact.coverage_manifest.files.find((f) => f.path === path);
      expect(entry?.treatment, `${name} → ${path}`).toBe(treatment);
    }
  });

  it('被跳过的文件不会出现在任何 shard 里（不送给模型）', () => {
    for (const name of ['lockfile-only-change', 'vendor-dependency-update', 'generated-file-changed']) {
      const artifact = buildArtifact(loaded.get(name));
      const shardedPaths = artifact.shards.flatMap((s) => s.files.map((f) => f.path));
      expect(shardedPaths, name).toEqual([]);
    }
  });

  // 2026-08-14 nightly（6e3d4c0，#12 的 prompt 已合入、#11 的 skill 还没有）
  // 把这两条用例的真实形状钉死了。没有这两条，下一次改夹具很容易再写成
  // 「看起来像缺陷、verifier 按所有权图否决」或「陷阱钉在新代码上、测的不是
  // issue 里说的那件事」。
  it('swift-retain-cycle: ViewController 必须属性持有 DataLoader，才构成引用环', () => {
    // nightly 里 verifier 连拒 9 条 retain-cycle 候选，理由一致：
    // `let loader = DataLoader()` 是局部变量，VC 不持有 loader，只有
    // DataLoader → delegate 单向引用，不成环。把 must_find 钉在这种代码上，
    // 召回率会永远是 0%——调 skill / prompt 都救不了，因为 verifier 否决是对的。
    const c = loaded.get('swift-retain-cycle');
    const source = c.contextContents['Sources/App/ViewController.swift'];
    expect(source, 'swift-retain-cycle 必须提供 ViewController.swift 全文').toBeTruthy();
    // 4 空格缩进 = 类体属性；8 空格 = 方法内局部变量。前者才让 VC 持有 loader。
    expect(
      source,
      'ViewController 类体里必须有 DataLoader 存储属性（不能只是方法内的局部变量）',
    ).toMatch(
      /^    (?:(?:private|fileprivate|internal|public|open)\s+)?(?:let|var)\s+\w+[^\n]*=\s*DataLoader\s*\(/m,
    );
    expect(source).not.toMatch(/^        let\s+loader\s*=\s*DataLoader\s*\(/m);

    const expected = c.expected.find((e) => e.must_find);
    expect(expected, '必须有一条 must_find').toBeTruthy();
    const expectedLine = source.split('\n')[expected.line - 1];
    expect(
      expectedLine,
      `must_find 应落在 loader.delegate = self，实际第 ${expected.line} 行是：${expectedLine}`,
    ).toMatch(/loader\.delegate\s*=\s*self/);
  });

  it('historical-todo-in-touched-file: 陷阱必须钉在那条 2019 TODO 上，而不是新函数', () => {
    // issue #12 与 thresholds.json 都写明陷阱是「文件里那条 2019 年的 TODO」。
    // 夹具却把 must_not_find 写在 FormatAmount（本次新增）上。nightly 里模型
    // 给新函数报了 Naming clarity，被记成陷阱命中——测到的是风格挑剔，不是
    // 「把历史遗留当成本次引入」。
    const c = loaded.get('historical-todo-in-touched-file');
    const source = c.contextContents['internal/billing/invoice.go'];
    expect(source, 'historical-todo 必须提供 invoice.go 全文').toBeTruthy();
    const traps = c.expected.filter((e) => !e.must_find);
    expect(traps).toHaveLength(1);
    const trapLine = source.split('\n')[traps[0].line - 1];
    expect(
      trapLine,
      `陷阱应落在 TODO(2019) 那一行，实际第 ${traps[0].line} 行是：${trapLine}`,
    ).toMatch(/TODO\(2019\)/);
    expect(trapLine).not.toMatch(/func \(s \*Service\) FormatAmount/);
  });
});

/**
 * 把一份单文件 patch 正文切成若干 hunk，并数出各类行数。
 * 刻意不复用 parsePatch —— 它只认 newStart、根本不读声明的行数，
 * 用它来验证行数等于用被测对象给自己打分。
 */
function splitHunks(patch) {
  const hunks = [];
  let current;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, context: 0, added: 0, deleted: 0 };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // "\ No newline at end of file" 不是一条 diff 行。
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.deleted += 1;
    else current.context += 1;
  }
  return hunks;
}

function buildArtifact(c) {
  return toPrepareArtifact(c, {
    parsePatch: pipeline.parsePatch,
    shardFiles: pipeline.shardFiles,
    classifyFile: pipeline.classifyFile,
    scanAndRedactSecrets: pipeline.scanAndRedactSecrets,
    limits: {
      maxFilesPerShard: pipeline.centralLimits.maxFilesPerShard,
      maxBytesPerShard: pipeline.centralLimits.maxBytesPerShard,
      maxShards: pipeline.centralLimits.maxShardsPerRun,
    },
  });
}

/**
 * 生产的 prepare 在 parsePatch **之前**对 patch 做 scanAndRedactSecrets
 * （prepare.ts:127），contextContents 同样打码（prepare.ts:136）。评测必须走同一
 * 条路，否则 hardcoded-credential 这类用例度量的是一个生产里不存在的输入——模型
 * 在生产里看到的是 `[REDACTED:...]`，在评测里却看到明文。
 */
describe('评测输入与生产一致：secret 打码', () => {
  it('用例里的凭据在进 shard 前已被打码', () => {
    const artifact = buildArtifact(loaded.get('hardcoded-credential'));
    const content = artifact.shards
      .flatMap((s) => s.files)
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .map((l) => l.content)
      .join('\n');

    expect(content).toContain('REDACTED');
    expect(content).not.toContain('3f7a91c04e8b46d2ab5c1e09f2d84b7615ca390e');
  });

  it('打码不改变行数——否则 #9 的行号锚点会整体漂掉', () => {
    // scanAndRedactSecrets 做的是行内替换，但这一点必须被锁住：一旦某条 pattern
    // 跨行匹配，post-image 行号就会和 @@ 头声明的范围错开，所有 finding 又会被
    // 确定性校验成批拒掉——正是 #9 的故障模式，只是换了个起因。
    for (const name of CASE_NAMES) {
      const c = loaded.get(name);
      for (const f of c.files) {
        if (f.patch === '') continue;
        const { redactedContent } = pipeline.scanAndRedactSecrets(f.patch);
        expect(
          redactedContent.split('\n').length,
          `${name} 的 ${f.path}：打码改变了行数`,
        ).toBe(f.patch.split('\n').length);
      }
    }
  });

  it('打码后 must_find 的行号仍然能通过确定性证据校验', () => {
    for (const name of CASE_NAMES) {
      const c = loaded.get(name);
      for (const e of c.expected.filter((x) => x.must_find)) {
        const file = c.files.find((f) => f.path === e.path);
        const { redactedContent } = pipeline.scanAndRedactSecrets(file.patch);
        const hunks = pipeline.parsePatch(file.path, redactedContent).hunks;
        const result = pipeline.validateDeterministicEvidence(
          { path: e.path, line: e.line, side: 'RIGHT' },
          e.path,
          hunks,
        );
        expect(result.status, `${name} expected ${e.path}:${e.line}（打码后）`).toBe('passed');
      }
    }
  });
});

/**
 * verifier 只能看到 `contextContents`。首轮全量评测里它几乎拒绝了一切需要上下文
 * 才能确认的 finding，理由清一色是「拿不到文件内容」——因为用例当时没有 context，
 * 而生产的 prepare 会把变更文件的全文填进去。这组断言保证补上的 context 是**可用**
 * 的，而不只是存在。
 */
describe('context 全文与 diff post-image 对齐', () => {
  /**
   * 会进 shard（因而会触发 verifier）的用例才需要 context。
   * 必须在运行时判断——`loaded` 是 beforeAll 填的，collection 阶段还是 undefined。
   */
  function needsContext(name) {
    const artifact = buildArtifact(loaded.get(name));
    return artifact.shards.some((s) => s.files.length > 0);
  }

  it('会被审的用例数符合预期（4 个被分类器跳过的不需要 context）', () => {
    expect(CASE_NAMES.filter(needsContext).length).toBe(CASE_NAMES.length - 4);
  });

  it.each(CASE_NAMES)('%s: 每个被审文件都有 context 全文', (name) => {
    if (!needsContext(name)) return;
    const c = loaded.get(name);
    const artifact = buildArtifact(c);

    for (const file of artifact.shards.flatMap((s) => s.files)) {
      expect(
        Object.keys(file.contextContents),
        `${name} 的 ${file.path} 缺 context/ 全文——verifier 会因「拿不到文件内容」拒掉一切`,
      ).toContain(file.path);
    }
  });

  it.each(CASE_NAMES)('%s: context 的行号与 diff 的 post-image 严格一致', (name) => {
    if (!needsContext(name)) return;
    const c = loaded.get(name);

    for (const file of c.files) {
      const full = c.contextContents[file.path];
      if (full === undefined) continue;

      const contextLines = full.split('\n');
      const hunks = pipeline.parsePatch(file.path, file.patch).hunks;

      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'del') continue;
          const actual = contextLines[line.newLine - 1];
          // 对不齐比没有 context 更糟：verifier 会照着一份和 finding 行号错开的
          // 代码去核对，得出的结论毫无意义却看着很像回事。
          expect(
            actual,
            `${name} 的 ${file.path}:${line.newLine} —— diff 说是 ${JSON.stringify(
              line.content,
            )}，context 里是 ${JSON.stringify(actual)}`,
          ).toBe(line.content);
        }
      }
    }
  });
});
