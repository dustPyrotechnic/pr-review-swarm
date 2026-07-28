import { describe, expect, it, vi } from 'vitest';
import { resolveRef, DEFAULT_REF } from './resolve-ref.mjs';

const SHA = 'a'.repeat(40);

describe('resolveRef', () => {
  it('defaults to the moving major tag so installed repos track central releases automatically', async () => {
    const exec = vi.fn();
    const result = await resolveRef({ pinSha: false, exec });

    expect(result).toEqual({ ref: DEFAULT_REF, mode: 'tag' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolves the major tag to an immutable commit SHA when pinSha is set', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: `${SHA}\n`, code: 0 });
    const result = await resolveRef({ pinSha: true, exec });

    expect(exec).toHaveBeenCalledWith('gh', [
      'api',
      `repos/dustPyrotechnic/pr-review-swarm/commits/${DEFAULT_REF}`,
      '--jq',
      '.sha',
    ]);
    expect(result).toEqual({ ref: SHA, mode: 'sha' });
  });

  it('fails loudly when gh cannot resolve the tag instead of writing a broken ref', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'Not Found', code: 1 });

    await expect(resolveRef({ pinSha: true, exec })).rejects.toThrow(/Not Found/);
  });

  it('rejects output that is not a full 40-character commit SHA', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'v1\n', code: 0 });

    await expect(resolveRef({ pinSha: true, exec })).rejects.toThrow(/40-character commit SHA/);
  });
});
