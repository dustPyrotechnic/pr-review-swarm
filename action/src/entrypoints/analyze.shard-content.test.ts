import { describe, expect, it } from 'vitest';
import { buildShardContent } from './analyze.js';
import { parsePatch } from '../lib/diff-parser.js';
import { validateDeterministicEvidence } from '../lib/deterministic-evidence-validator.js';
import type { PrepareShard } from './prepare.js';

/**
 * Regression tests for #9.
 *
 * The shard content is the *only* view of the diff the model ever gets. It used
 * to carry no line numbers at all — no `@@` header, nothing — while
 * `validateDeterministicEvidence` requires `finding.line` to fall inside
 * `[hunk.newStart, hunk.newStart + hunk.newLines - 1]`. The model had no way to
 * satisfy a rule it was being judged by, so candidates were rejected in bulk
 * (16/16 in the first real benchmark run) and effective recall sat near zero.
 *
 * This function had zero test coverage, which is exactly why the gap survived:
 * every other test injects pre-built candidates whose line numbers the test
 * itself gets right.
 */

const PATCH = [
  '@@ -15,6 +15,11 @@ func GetUser(id int) (*User, error) {',
  ' 	return user, nil',
  ' }',
  ' ',
  '+func DeleteUser(id int) {',
  '+	db.Exec("DELETE FROM users WHERE id = ?", id)',
  '+	log.Printf("user %d deleted", id)',
  '+}',
  '+',
  ' func ListUsers() ([]*User, error) {',
].join('\n');

function shardFor(path: string, patch: string): PrepareShard {
  return {
    id: 'shard-1',
    files: [{ path, hunks: parsePatch(path, patch).hunks, contextRefs: [], contextContents: {} }],
  };
}

describe('buildShardContent — 行号锚点（#9）', () => {
  const content = buildShardContent(shardFor('pkg/service/user.go', PATCH));

  it('仍然标出文件路径', () => {
    expect(content).toContain('File: pkg/service/user.go');
  });

  it('新增行带上它在新文件里的行号', () => {
    // 这个 hunk 从新文件第 15 行开始：15/16/17 是上下文，18 起才是新增。
    expect(content).toMatch(/18\s*\+func DeleteUser\(id int\) \{/);
    expect(content).toMatch(/19\s*\+\tdb\.Exec/);
  });

  it('上下文行同样带行号，且与新增行连续', () => {
    expect(content).toMatch(/15\s+ \treturn user, nil/);
    expect(content).toMatch(/23\s+ func ListUsers/);
  });

  it('删除行不带行号：它在新文件里不存在，给个数字只会被误用', () => {
    const delPatch = ['@@ -10,2 +10,1 @@', ' kept', '-removed'].join('\n');
    const out = buildShardContent(shardFor('a.go', delPatch));

    const removedLine = out.split('\n').find((l) => l.includes('removed'));
    expect(removedLine).toBeDefined();
    expect(removedLine).toContain('-removed');
    // finding 必须锚定 RIGHT 侧；给删除行一个行号等于邀请模型去锚一个
    // 确定性校验器一定会拒的位置。
    expect(removedLine).not.toMatch(/\d/);
  });

  it('每一个被标注的行号都能通过确定性证据校验', () => {
    // 这是本次回归的核心断言：模型照着 prompt 里的数字填 line，就必须能过校验。
    const hunks = parsePatch('pkg/service/user.go', PATCH).hunks;
    const numbers = [...content.matchAll(/^\s*(\d+)\s/gm)].map((m) => Number(m[1]));

    expect(numbers.length).toBeGreaterThan(0);
    for (const line of numbers) {
      const result = validateDeterministicEvidence(
        { path: 'pkg/service/user.go', line, side: 'RIGHT' } as never,
        'pkg/service/user.go',
        hunks,
      );
      expect(result.status, `行号 ${line} 应当可用作 finding 锚点`).toBe('passed');
    }
  });

  it('多个文件之间互不串行号', () => {
    const shard: PrepareShard = {
      id: 'shard-1',
      files: [
        {
          path: 'a.go',
          hunks: parsePatch('a.go', ['@@ -1,1 +1,2 @@', ' one', '+two'].join('\n')).hunks,
          contextRefs: [],
          contextContents: {},
        },
        {
          path: 'b.go',
          hunks: parsePatch('b.go', ['@@ -50,1 +50,2 @@', ' fifty', '+fiftyone'].join('\n')).hunks,
          contextRefs: [],
          contextContents: {},
        },
      ],
    };

    const out = buildShardContent(shard);
    expect(out).toMatch(/2\s*\+two/);
    expect(out).toMatch(/51\s*\+fiftyone/);
  });

  it('同一文件的多个 hunk 各自用自己的起始行号', () => {
    const twoHunks = [
      '@@ -1,1 +1,2 @@',
      ' first',
      '+second',
      '@@ -80,1 +81,2 @@',
      ' eighty',
      '+eightyone',
    ].join('\n');

    const out = buildShardContent(shardFor('a.go', twoHunks));
    expect(out).toMatch(/2\s*\+second/);
    expect(out).toMatch(/82\s*\+eightyone/);
  });

  it('内容本身一字不改（行号是前缀，不是替换）', () => {
    expect(content).toContain('db.Exec("DELETE FROM users WHERE id = ?", id)');
    expect(content).toContain('log.Printf("user %d deleted", id)');
  });
});
