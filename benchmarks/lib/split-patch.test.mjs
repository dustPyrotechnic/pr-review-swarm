import { describe, expect, it } from 'vitest';
import { splitUnifiedDiff } from './split-patch.mjs';

/**
 * benchmark 的 `diff.patch` 是一份完整的多文件 `git diff` 输出，而 action 的
 * `parsePatch` 消费的是 GitHub `pulls/{pr}/files` 里的**单文件** `patch` 字段
 * （不含 `diff --git` / `index` / `---` / `+++` 头）。这一层负责把前者拆成后者，
 * 拆错就意味着整个评测在错误的输入上跑——所以它自己需要测试。
 */
describe('splitUnifiedDiff', () => {
  it('把单文件 diff 拆出路径与纯 hunk 正文', () => {
    const raw = [
      'diff --git a/pkg/service/user.go b/pkg/service/user.go',
      'index 111aaa..222bbb 100644',
      '--- a/pkg/service/user.go',
      '+++ b/pkg/service/user.go',
      '@@ -15,3 +15,4 @@ func GetUser() {',
      ' 	return user, nil',
      ' }',
      ' ',
      '+func DeleteUser() {}',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('pkg/service/user.go');
    expect(files[0].status).toBe('modified');
    // 正文必须从 @@ 开始 —— 头部若漏进去，parsePatch 会把 `+++ b/...` 当成一条 add 行。
    expect(files[0].patch.startsWith('@@ -15,3 +15,4 @@')).toBe(true);
    expect(files[0].patch).not.toContain('diff --git');
    expect(files[0].patch).not.toContain('+++ b/');
  });

  it('拆分多文件 diff 且互不串味', () => {
    const raw = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      'diff --git a/b.ts b/b.ts',
      'index 3..4 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,1 +5,2 @@',
      ' const c = 3;',
      '+const d = 4;',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files[0].patch).toContain('const b = 2;');
    expect(files[0].patch).not.toContain('const d = 4;');
    expect(files[1].patch).toContain('const d = 4;');
    expect(files[1].patch).not.toContain('const b = 2;');
  });

  it('新增文件用 b/ 侧路径，状态为 added', () => {
    const raw = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const x = 1;',
      '+export const y = 2;',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new.ts');
    expect(files[0].status).toBe('added');
  });

  it('删除文件回落到 a/ 侧路径，状态为 removed', () => {
    const raw = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export const x = 1;',
      '-export const y = 2;',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files).toHaveLength(1);
    // `+++ /dev/null` 不是路径。取错会让整个 case 的 finding 全部对不上文件。
    expect(files[0].path).toBe('gone.ts');
    expect(files[0].status).toBe('removed');
  });

  it('重命名时用新路径，状态为 renamed', () => {
    const raw = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 95%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      'index 1..2 100644',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files[0].path).toBe('new/name.ts');
    expect(files[0].status).toBe('renamed');
  });

  it('二进制文件没有 hunk，patch 为空字符串而不是抛错', () => {
    const raw = [
      'diff --git a/logo.png b/logo.png',
      'index 1..2 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('logo.png');
    // GitHub 对二进制文件同样不给 patch 字段；空串让下游按"无 hunk"处理。
    expect(files[0].patch).toBe('');
  });

  it('保留 "\\ No newline at end of file" 标记行（parsePatch 自己会跳过）', () => {
    const raw = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files[0].patch).toContain('\\ No newline at end of file');
  });

  it('保留 hunk 末尾的空 context 行', () => {
    // unified diff 里一个空的上下文行是「单个空格」。把它当成尾部空白删掉，
    // hunk 就少了一行，声明的 newLines 与实际行数不再一致 —— 而确定性证据
    // 校验器按 newStart + newLines - 1 卡上界，最后一行会因此被判为「不在
    // 本次 diff 修改的 hunk 内」，模型报对了也进不了 findings。
    const raw = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' ',
      '',
    ].join('\n');

    const files = splitUnifiedDiff(raw);

    expect(files[0].patch.split('\n')).toEqual([
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' ',
    ]);
  });

  it('只去掉文件末尾换行产生的那个伪空元素，不吞真实内容', () => {
    const raw = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', ' x', ''].join(
      '\n',
    );

    expect(splitUnifiedDiff(raw)[0].patch).toBe('@@ -1,1 +1,1 @@\n x');
  });

  it('空输入返回空数组', () => {
    expect(splitUnifiedDiff('')).toEqual([]);
    expect(splitUnifiedDiff('   \n  \n')).toEqual([]);
  });

  it('拒绝没有 diff --git 头的裸 hunk，而不是猜一个路径出来', () => {
    const raw = ['@@ -1,1 +1,2 @@', ' const a = 1;', '+const b = 2;'].join('\n');

    // 猜路径会让评测在一个不存在的文件上对账，永远 0 召回且没人知道为什么。
    expect(() => splitUnifiedDiff(raw)).toThrow(/diff --git/);
  });
});
