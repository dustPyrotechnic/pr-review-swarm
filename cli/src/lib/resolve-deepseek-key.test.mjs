import { describe, expect, it, vi } from 'vitest';
import { resolveDeepseekKey } from './resolve-deepseek-key.mjs';

describe('resolveDeepseekKey', () => {
  it('prefers the --deepseek-key flag over everything else', async () => {
    const prompt = vi.fn().mockResolvedValue('should-not-be-used');
    const key = await resolveDeepseekKey({
      flagValue: 'from-flag',
      env: { DEEPSEEK_API_KEY: 'from-env' },
      prompt,
    });
    expect(key).toBe('from-flag');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('falls back to the DEEPSEEK_API_KEY env var when no flag is given', async () => {
    const prompt = vi.fn();
    const key = await resolveDeepseekKey({
      flagValue: undefined,
      env: { DEEPSEEK_API_KEY: 'from-env' },
      prompt,
    });
    expect(key).toBe('from-env');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('falls back to an interactive masked prompt when neither flag nor env var is set', async () => {
    const prompt = vi.fn().mockResolvedValue('from-prompt');
    const key = await resolveDeepseekKey({ flagValue: undefined, env: {}, prompt });
    expect(key).toBe('from-prompt');
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
