import { describe, expect, it } from 'vitest';
import {
  parseIndex,
  loadSkill,
  matchTriggeredSkills,
  validateSkillRequests,
  readIndexMd,
} from './skill-loader.js';

describe('parseIndex', () => {
  it('parses each line of the real index.md into name/version/triggers/description', () => {
    const entries = parseIndex(readIndexMd());

    expect(entries).toContainEqual({
      name: 'swift-review',
      version: 4,
      triggers: ['*.swift'],
      description: 'Swift 正确性、内存管理与并发审查清单',
    });
    // 多 trigger 的条目：objc-review 覆盖 .m/.mm/.h（见 issue #11——此前 ObjC
    // 文件匹配不到任何语言专属清单）。
    expect(entries).toContainEqual({
      name: 'objc-review',
      version: 1,
      triggers: ['*.m', '*.mm', '*.h'],
      description: 'Objective-C 强引用循环与内存生命周期审查清单',
    });
    expect(entries.map((e) => e.name)).toEqual([
      'generic-correctness',
      'generic-security',
      'generic-maintainability',
      'swift-review',
      'objc-review',
    ]);
  });

  it('throws on a malformed index line', () => {
    expect(() => parseIndex('- not-a-valid-line\n')).toThrow();
  });
});

describe('loadSkill', () => {
  it('loads swift-review.md front matter and body', () => {
    const { meta, body } = loadSkill('swift-review');

    expect(meta).toEqual({
      name: 'swift-review',
      version: 4,
      triggers: ['*.swift'],
      category: 'correctness',
    });
    expect(body).toContain('Checklist');
  });

  it('every entry in index.md matches its skill file front matter (version and triggers)', () => {
    const entries = parseIndex(readIndexMd());

    for (const entry of entries) {
      const { meta } = loadSkill(entry.name);
      expect(meta.version, `${entry.name} version mismatch`).toBe(entry.version);
      expect(meta.triggers, `${entry.name} triggers mismatch`).toEqual(entry.triggers);
    }
  });
});

describe('matchTriggeredSkills', () => {
  it('matches swift-review for a .swift file', () => {
    const entries = parseIndex(readIndexMd());
    const matched = matchTriggeredSkills(['Sources/App/Foo.swift'], entries);
    expect(matched.map((s) => s.name)).toContain('swift-review');
  });

  it('matches generic skills (trigger "*") for any file', () => {
    const entries = parseIndex(readIndexMd());
    const matched = matchTriggeredSkills(['README.md'], entries);
    expect(matched.map((s) => s.name)).toEqual(
      expect.arrayContaining(['generic-correctness', 'generic-security', 'generic-maintainability']),
    );
    expect(matched.map((s) => s.name)).not.toContain('swift-review');
  });
});

describe('validateSkillRequests', () => {
  const entries = parseIndex(readIndexMd());

  it('returns the requested names when they are valid and within the limit', () => {
    expect(validateSkillRequests(['swift-review'], entries, 3)).toEqual(['swift-review']);
  });

  it('throws when a requested skill name is not in the index', () => {
    expect(() => validateSkillRequests(['not-a-real-skill'], entries, 3)).toThrow();
  });

  it('throws when the number of requested skills exceeds the max', () => {
    expect(() =>
      validateSkillRequests(['generic-correctness', 'generic-security', 'swift-review'], entries, 2),
    ).toThrow();
  });
});

describe('readIndexMd', () => {
  it('reads the real skills/index.md content off disk', () => {
    const content = readIndexMd();
    expect(content).toContain('swift-review: v4');
  });
});

/**
 * issue #11：retain cycle 类缺陷识别率过低。
 *
 * 全量评测（已补 context、已修 #9）里这两条是整个用例集最差的：
 *   swift-retain-cycle        召回 0%（3 轮全部漏报，且零候选零误报）
 *   objc-retain-cycle-block   召回 33.3%
 *
 * 查出两个具体缺口：
 *
 * 1. swift-review 的 checklist 只写「闭包捕获 self 未加 [weak self]」，而
 *    swift-retain-cycle 用例的形态是 **delegate 属性未用 weak**
 *    （`loader.delegate = self` + `var delegate: DataLoaderDelegate?`）。
 *    这不是闭包捕获，清单没覆盖，模型自然报不出来。
 *
 * 2. 根本没有 ObjC skill。swift-review 的 trigger 是 `*.swift`，所以
 *    `Classes/FeedViewController.m` 匹配不到任何语言专属清单，只能靠三个
 *    generic agent 的通用条目。
 */
describe('retain cycle 类缺陷的清单覆盖（#11）', () => {
  const index = parseIndex(readIndexMd());

  it('.m 文件能匹配到 ObjC 专属清单', () => {
    const matched = matchTriggeredSkills(['Classes/FeedViewController.m'], index);
    expect(matched.map((e) => e.name)).toContain('objc-review');
  });

  it('.h 文件同样匹配（属性声明是 retain cycle 的关键证据）', () => {
    const matched = matchTriggeredSkills(['Classes/FeedViewController.h'], index);
    expect(matched.map((e) => e.name)).toContain('objc-review');
  });

  it('.swift 文件不会误匹配到 ObjC 清单', () => {
    const matched = matchTriggeredSkills(['Sources/App/ViewController.swift'], index);
    expect(matched.map((e) => e.name)).not.toContain('objc-review');
    expect(matched.map((e) => e.name)).toContain('swift-review');
  });

  it('objc-review 的清单点明 block 捕获 self 与 __weak', () => {
    const body = loadSkill('objc-review').body;
    expect(body).toMatch(/__weak|weakSelf/);
    expect(body.toLowerCase()).toContain('block');
  });

  it('objc-review 归到 correctness 类别（与三个 generic agent 的分派对齐）', () => {
    // skillsForAgent 按 category 过滤：类别写错，清单就装备不到任何 agent 上，
    // 等于白写。
    expect(loadSkill('objc-review').meta.category).toBe('correctness');
  });

  it('swift-review 的清单覆盖 delegate 属性未用 weak 这一形态', () => {
    const body = loadSkill('swift-review').body;
    expect(body).toMatch(/delegate/);
    expect(body).toMatch(/weak var|weak\b/);
  });

  it('swift-review 仍然覆盖闭包捕获（原有条目不能被挤掉）', () => {
    const body = loadSkill('swift-review').body;
    expect(body).toMatch(/\[weak self\]|\[unowned self\]/);
  });
});
