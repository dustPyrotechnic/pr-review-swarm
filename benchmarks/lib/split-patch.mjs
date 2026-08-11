/**
 * 把一份完整的多文件 `git diff` 输出拆成 GitHub `pulls/{pr}/files` 那样的
 * 单文件条目，供 action 的 `parsePatch(path, patch)` 直接消费。
 *
 * 为什么需要这一层：benchmark 的 `cases/<name>/diff.patch` 是人写的、可读的完整 diff
 * （带 `diff --git` / `index` / `---` / `+++` 头），而 analyze 管线拿到的 `patch`
 * 字段是从第一个 `@@` 开始的裸 hunk。把头部漏进去，`parsePatch` 会把
 * `+++ b/foo.ts` 当成一条 add 行，行号从此整体错位——评测会给出一个看着正常、
 * 实则全错的召回率。
 *
 * @param {string} raw 完整 diff 文本
 * @returns {Array<{path: string, status: 'added'|'removed'|'modified'|'renamed', patch: string}>}
 */
export function splitUnifiedDiff(raw) {
  if (!raw || raw.trim() === '') {
    return [];
  }

  const lines = raw.split('\n');
  const headerIndexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) {
      headerIndexes.push(i);
    }
  }

  if (headerIndexes.length === 0) {
    throw new Error(
      'splitUnifiedDiff: 输入里没有任何 "diff --git" 头，无法确定 hunk 属于哪个文件。' +
        'benchmark 的 diff.patch 必须是完整的 git diff 输出。',
    );
  }

  const files = [];
  for (let n = 0; n < headerIndexes.length; n += 1) {
    const start = headerIndexes[n];
    const end = n + 1 < headerIndexes.length ? headerIndexes[n + 1] : lines.length;
    files.push(parseFileSection(lines.slice(start, end)));
  }
  return files;
}

/**
 * @param {string[]} section 从 `diff --git` 起、到下一个 `diff --git` 前的所有行
 */
function parseFileSection(section) {
  let status = 'modified';
  let newPath;
  let oldPath;
  let hunkStart = -1;

  for (let i = 0; i < section.length; i += 1) {
    const line = section[i];

    if (line.startsWith('@@')) {
      hunkStart = i;
      break;
    }
    if (line.startsWith('new file mode ')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode ')) {
      status = 'removed';
    } else if (line.startsWith('rename to ')) {
      status = 'renamed';
    } else if (line.startsWith('--- ')) {
      oldPath = stripPathPrefix(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      newPath = stripPathPrefix(line.slice(4));
    }
  }

  // 删除的文件 `+++ /dev/null`，新增的文件 `--- /dev/null`；两侧都可能缺
  // （二进制文件根本没有 `---`/`+++` 行），最后回落到 `diff --git a/X b/Y` 头。
  const path = newPath ?? oldPath ?? pathFromGitHeader(section[0]);
  if (!path) {
    throw new Error(`splitUnifiedDiff: 无法从这一段解析出文件路径：${section[0]}`);
  }

  // 二进制/纯模式变更没有 hunk。GitHub 对这类文件同样不返回 patch 字段，
  // 这里给空串而不是抛错，让下游按"无 hunk"一致处理。
  const patch = hunkStart === -1 ? '' : dropTrailingNewlineArtifact(section.slice(hunkStart)).join('\n');

  return { path, status, patch };
}

/**
 * 去掉 `a/` `b/` 前缀；`/dev/null` 不是路径，返回 undefined。
 */
function stripPathPrefix(value) {
  // git 对含空格/特殊字符的路径会加引号，这里只做最小处理：
  // benchmark fixture 的路径由我们自己控制，恶意路径的对抗覆盖在
  // action/test/fixtures/malicious-paths.* （Task 4.2），不属于本层职责。
  const trimmed = value.replace(/\t.*$/, '').trim();
  if (trimmed === '/dev/null') {
    return undefined;
  }
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function pathFromGitHeader(headerLine) {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(headerLine);
  return match ? match[2] : undefined;
}

/**
 * 去掉 `split('\n')` 在「文本以换行结尾」时产生的那一个末尾伪空元素。
 *
 * 只去掉严格等于空串的**一个**元素，刻意不做 `trim()`：unified diff 里一个
 * 空的上下文行写作「单个空格」，用 trim 判断会把它当成尾部空白删掉。hunk 因此
 * 少一行，声明的 `newLines` 与实际行数不再一致，而确定性证据校验器按
 * `newStart + newLines - 1` 卡上界 —— 最后一行会被判成「不属于本次 diff 修改的
 * hunk」，模型报对了也进不了 findings。这类错误不会报任何错，只会表现为召回率
 * 莫名偏低。
 */
function dropTrailingNewlineArtifact(lines) {
  const out = [...lines];
  if (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }
  return out;
}
