import { describe, expect, it } from 'vitest';
import { buildIncompleteBanner } from './incomplete-banner.js';

describe('buildIncompleteBanner', () => {
  it('starts with the fixed warning line', () => {
    const banner = buildIncompleteBanner(['hard_limit_hit']);
    expect(banner.startsWith('⚠️ 本次审核未完整覆盖')).toBe(true);
  });

  it('lists every incomplete reason as its own bullet', () => {
    const banner = buildIncompleteBanner(['hard_limit_hit', 'shards_incomplete']);
    expect(banner).toContain('- hard_limit_hit');
    expect(banner).toContain('- shards_incomplete');
  });
});
