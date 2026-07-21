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
      version: 3,
      triggers: ['*.swift'],
      description: 'Swift 正确性、内存管理与并发审查清单',
    });
    expect(entries.map((e) => e.name)).toEqual([
      'generic-correctness',
      'generic-security',
      'generic-maintainability',
      'swift-review',
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
      version: 3,
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
    expect(content).toContain('swift-review: v3');
  });
});
